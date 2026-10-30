/*
 * PodCutter — offline transcription (bundled whisper.cpp).
 *
 * Mixes the speaker mic tracks of the timeline into one 16 kHz mono WAV in
 * sequence time (ffmpeg), runs the bundled whisper-cli on it, and returns
 * timeline-timed segments. Speakers are attributed afterwards from mic
 * activity, so one transcription pass covers every mic.
 *
 * Everything runs locally from files shipped with the extension:
 *   vendor/whisper/<platform>/whisper-cli(.exe)  + ggml/whisper DLLs
 *   vendor/whisper/models/ggml-*.bin
 * No network, no installed AI runtime.
 */
(function (root, factory) {
  // CEP panels with Node enabled define both window and module: export to both.
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (typeof window !== "undefined") window.PodTranscriber = api;
  else if (root) root.PodTranscriber = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var req = typeof require === "function" ? require : null;
  var cp = req && req("child_process");
  var fs = req && req("fs");
  var os = req && req("os");
  var path = req && req("path");

  var state = { root: null, whisper: null, model: null, customWhisper: null, customModel: null };

  function platformFolder() {
    if (process.platform === "win32") return "win32-x64";
    if (process.platform === "darwin") return process.arch === "arm64" ? "darwin-arm64" : "darwin-x64";
    return "linux-" + process.arch;
  }

  /** Locate whisper-cli and a model. opts: { extensionRoot, whisperPath, modelPath } */
  function locate(opts) {
    opts = opts || {};
    if (opts.extensionRoot) state.root = opts.extensionRoot;
    if (opts.whisperPath !== undefined) state.customWhisper = opts.whisperPath || null;
    if (opts.modelPath !== undefined) state.customModel = opts.modelPath || null;
    var exe = process.platform === "win32" ? "whisper-cli.exe" : "whisper-cli";
    var bins = [];
    if (state.customWhisper) bins.push(state.customWhisper);
    if (state.root) bins.push(path.join(state.root, "vendor", "whisper", platformFolder(), exe));
    state.whisper = bins.filter(function (b) { try { return fs.statSync(b).isFile(); } catch (e) { return false; } })[0] || null;

    var models = [];
    if (state.customModel) models.push(state.customModel);
    if (state.root) {
      var dir = path.join(state.root, "vendor", "whisper", "models");
      try {
        // Prefer the most accurate model shipped: small > base > tiny.
        var files = fs.readdirSync(dir).filter(function (f) { return /^ggml-.*\.bin$/.test(f); });
        var rank = function (f) { return /large/.test(f) ? 0 : /medium/.test(f) ? 1 : /small/.test(f) ? 2 : /base/.test(f) ? 3 : 4; };
        files.sort(function (a, b) { return rank(a) - rank(b); });
        files.forEach(function (f) { models.push(path.join(dir, f)); });
      } catch (e) { /* no models dir */ }
    }
    state.model = models.filter(function (m) { try { return fs.statSync(m).isFile(); } catch (e) { return false; } })[0] || null;
    // Silero voice-activity model: keeps word timestamps accurate after long silences.
    state.vad = null;
    if (state.root) {
      var vad = path.join(state.root, "vendor", "whisper", "models", "vad", "ggml-silero-v5.1.2.bin");
      try { if (fs.statSync(vad).isFile()) state.vad = vad; } catch (e) { /* optional */ }
    }
    return {
      ok: !!(state.whisper && state.model),
      whisper: state.whisper, model: state.model,
      error: !state.whisper ? "Bundled transcriber (whisper-cli) not found for " + platformFolder() + "."
        : (!state.model ? "No Whisper model found in vendor/whisper/models." : null)
    };
  }

  var majorCache = {};
  function ffmpegMajor(ffmpegPath) {
    if (majorCache[ffmpegPath] !== undefined) return majorCache[ffmpegPath];
    var v = 7;
    try {
      var out = String(cp.spawnSync(ffmpegPath, ["-hide_banner", "-version"], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }).stdout || "");
      var m = /ffmpeg version (?:n)?(\d+)\./.exec(out);
      if (m) v = +m[1]; // "master"/git builds have no number: assume modern
    } catch (e) { /* assume modern */ }
    return (majorCache[ffmpegPath] = v);
  }

  /**
   * Render the given timeline audio clips into one mono 16 kHz WAV.
   * clips: [{ mediaPath, startSec, endSec, inPointSec, channel? }]
   */
  function analyzerModule() {
    if (typeof window !== "undefined" && window.PodAnalyzer) return window.PodAnalyzer;
    return req(path.join(__dirname, "analyzer.js"));
  }

  function renderMix(ffmpegPath, clips, durationSec, outPath, onProgress) {
    clips = clips.filter(function (c) { return c.mediaPath && c.endSec > c.startSec; });
    if (!clips.length) return Promise.reject(new Error("No audio clips to transcribe."));
    // Resolve "channel N" to (audio stream, channel within it) for files with several streams/channels.
    var A = analyzerModule();
    return Promise.all(clips.map(function (c) {
      if (c.channel === null || c.channel === undefined) return Promise.resolve({ stream: 0, chan: null, mono: false });
      return A.audioLayout(c.mediaPath).then(function (layout) {
        var loc = A.locateChannel(layout, c.channel);
        if (!loc) return { stream: 0, chan: null, mono: false }; // channel not in this file: use its full mix
        return { stream: loc.stream, chan: loc.chan, mono: layout[loc.stream] === 1 };
      });
    })).then(function (locs) { return renderMixResolved(ffmpegPath, clips, locs, durationSec, outPath, onProgress); });
  }

  function renderMixResolved(ffmpegPath, clips, locs, durationSec, outPath, onProgress) {
    return new Promise(function (resolve, reject) {
      var args = ["-hide_banner", "-nostats", "-loglevel", "error", "-y", "-progress", "pipe:1"];
      // Silent base so the mix always spans the whole sequence.
      args.push("-f", "lavfi", "-t", String(durationSec), "-i", "anullsrc=r=16000:cl=mono");
      var chains = [], labels = ["[0:a]"];
      clips.forEach(function (c, i) {
        args.push("-ss", String(Math.max(0, c.inPointSec || 0)), "-t", String(c.endSec - c.startSec), "-i", c.mediaPath);
        var loc = locs[i];
        var f = "[" + (i + 1) + ":a:" + loc.stream + "]";
        var chain = f + (loc.chan !== null && !loc.mono ? "pan=mono|c0=c" + loc.chan + "," : "") +
          "aresample=16000,aformat=channel_layouts=mono,adelay=" + Math.round(c.startSec * 1000) + ":all=1[a" + i + "]";
        chains.push(chain);
        labels.push("[a" + i + "]");
      });
      chains.push(labels.join("") + "amix=inputs=" + labels.length + ":duration=first:normalize=0,dynaudnorm=f=250:g=15[out]");
      // Long filter graphs can exceed the Windows command-line limit: pass the graph via a script file.
      var graphFile = outPath + ".filter.txt";
      fs.writeFileSync(graphFile, chains.join(";\n"));
      args.push(ffmpegMajor(ffmpegPath) >= 7 ? "-/filter_complex" : "-filter_complex_script", graphFile, "-map", "[out]", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", outPath);
      var p = cp.spawn(ffmpegPath, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      var err = "";
      p.stdout.on("data", function (d) {
        var m = /out_time_ms=(\d+)/.exec(String(d));
        if (m && onProgress) onProgress(Math.min(1, (+m[1] / 1e6) / durationSec));
      });
      p.stderr.on("data", function (d) { if (err.length < 4000) err += d; });
      p.on("error", reject);
      p.on("close", function (code) {
        try { fs.unlinkSync(graphFile); } catch (e) { /* ignore */ }
        if (code !== 0) return reject(new Error("Could not render the transcription mix: " + err.trim()));
        resolve(outPath);
      });
    });
  }

  /** Run whisper-cli on a WAV. Resolves with the parsed JSON object. */
  function runWhisper(wavPath, opts) {
    opts = opts || {};
    return new Promise(function (resolve, reject) {
      if (!state.whisper || !state.model) return reject(new Error("Call locate() first."));
      var base = wavPath.replace(/\.wav$/i, "");
      var threads = Math.max(1, Math.min(8, (os.cpus() || []).length - 1));
      var english = /\.en\.bin$/.test(state.model);
      var args = ["-m", state.model, "-f", wavPath, "-oj", "-of", base,
        "-t", String(threads), "-ml", "1", "-sow", "-pp"]; // one word per segment -> word timestamps
      if (state.vad) args.push("--vad", "-vm", state.vad);
      args.push("-l", english ? "en" : (opts.language || "auto"));
      if (opts.prompt) args.push("--prompt", opts.prompt);
      var p = cp.spawn(state.whisper, args, { cwd: path.dirname(state.whisper), windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      var err = "";
      function scan(d) {
        var s = String(d);
        var m = /progress\s*=\s*(\d+)%/.exec(s);
        if (m && opts.onProgress) opts.onProgress(+m[1] / 100);
        if (err.length < 6000) err += s;
      }
      p.stdout.on("data", scan);
      p.stderr.on("data", scan);
      p.on("error", function (e) { reject(new Error("Could not start whisper-cli: " + e.message)); });
      p.on("close", function (code) {
        var jsonPath = base + ".json";
        if (code !== 0 || !fs.existsSync(jsonPath)) {
          return reject(new Error("Transcription failed (code " + code + "): " + err.split(/\r?\n/).slice(-6).join(" ")));
        }
        try { resolve(JSON.parse(fs.readFileSync(jsonPath, "utf8"))); }
        catch (e) { reject(new Error("Could not read transcript JSON: " + e.message)); }
      });
    });
  }

  /**
   * Full pipeline: mix -> whisper -> segments [{startSec,endSec,text}] in sequence time.
   * opts: { ffmpegPath, clips, durationSec, workDir?, onProgress(stage, fraction) }
   */
  function transcribeTimeline(opts) {
    var work = opts.workDir || fs.mkdtempSync(path.join(os.tmpdir(), "poddirector-tx-"));
    var wav = path.join(work, "timeline-mix.wav");
    var prog = opts.onProgress || function () {};
    return renderMix(opts.ffmpegPath, opts.clips, opts.durationSec, wav, function (f) { prog("mix", f); })
      .then(function () { return runWhisper(wav, { onProgress: function (f) { prog("transcribe", f); }, prompt: opts.prompt, language: opts.language }); })
      .then(function (json) {
        try { fs.unlinkSync(wav); } catch (e) { /* keep going */ }
        return groupWords(json.transcription || []);
      });
  }

  /** Whisper word list -> sentence-ish segments with word timings. */
  function groupWords(items) {
    var words = items.map(function (s) {
      return { startSec: s.offsets.from / 1000, endSec: s.offsets.to / 1000, text: String(s.text || "") };
    }).map(function (w) {
      // Whisper stretches the last word before a pause over the silence; cap to a plausible length.
      var maxDur = 0.3 + 0.12 * w.text.trim().length;
      if (w.endSec - w.startSec > maxDur) w.endSec = w.startSec + maxDur;
      return w;
    }).filter(function (w) { return w.text.trim() && !/^\s*[\[(](BLANK_AUDIO|SILENCE|silence|no speech|inaudible)[\])]\s*$/i.test(w.text); });
    var segs = [], cur = null;
    words.forEach(function (w) {
      var gap = cur ? w.startSec - cur.endSec : Infinity;
      // Sound tags ([phone ringing], (laughs)) get their own segment so the cleanup scan can spot them.
      var tag = /^\s*[\[(*]/.test(w.text) || (cur && cur.tag);
      var newSeg = !cur || gap >= 0.7 || cur.words.length >= 28 || (/[.?!]["')]?$/.test(cur.text) && gap >= 0.25) ||
        (/^\s*[\[(*]/.test(w.text) && !/[\])*]\s*$/.test(cur.text)) || (cur.tag && /[\])*]\s*$/.test(cur.text));
      void tag;
      if (newSeg) { cur = { startSec: w.startSec, endSec: w.endSec, speaker: null, text: "", words: [], tag: /^\s*[\[(*]/.test(w.text) }; segs.push(cur); }
      cur.words.push({ startSec: w.startSec, endSec: w.endSec, text: w.text.trim() });
      cur.text = (cur.text + (/^\s/.test(w.text) || !cur.text ? " " : "") + w.text.trim()).trim();
      cur.endSec = w.endSec;
    });
    segs.forEach(function (sg) { if (sg.tag) sg.sound = /^\s*[\[(*][^\])*]{1,60}[\])*]\s*$/.test(sg.text); delete sg.tag; });
    return segs;
  }

  return { groupWords: groupWords, locate: locate, renderMix: renderMix, runWhisper: runWhisper, transcribeTimeline: transcribeTimeline };
});
