/*
 * PodCutter — waveform analyzer.
 *
 * Turns the audio clips on a Premiere audio track into one continuous loudness
 * curve (dB per hop, in sequence time). Uses ffmpeg to decode the *source*
 * media to 8 kHz mono PCM (voice-band filtered) and computes RMS in JS, which
 * is much faster than parsing ffmpeg's per-frame text stats.
 *
 * Runs in the CEP panel (Node enabled) and in plain Node (CLI, tests).
 * Results are cached on disk, keyed by file path + mtime + range, so changing
 * cut settings never re-reads media.
 */
(function (root, factory) {
  // CEP panels with Node enabled define both window and module: export to both.
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (typeof window !== "undefined") window.PodAnalyzer = api;
  else if (root) root.PodAnalyzer = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var req = typeof require === "function" ? require : null;
  var cp = req && req("child_process");
  var fs = req && req("fs");
  var os = req && req("os");
  var path = req && req("path");
  var crypto = req && req("crypto");

  var RATE = 8000;
  var DEFAULT_HOP = 0.025;
  var SILENT_DB = -120;
  var CACHE_VERSION = 3;

  var state = { ffmpeg: null, customPath: null, extensionRoot: null, tried: [] };

  function platformFolder() {
    var p = process.platform, a = process.arch;
    if (p === "darwin") return a === "arm64" ? "darwin-arm64" : "darwin-x64";
    if (p === "win32") return "win32-x64";
    return "linux-" + a;
  }
  function exe(name) { return process.platform === "win32" ? name + ".exe" : name; }

  function candidates() {
    var list = [];
    if (state.customPath) list.push(state.customPath);
    if (state.extensionRoot) list.push(path.join(state.extensionRoot, "vendor", "ffmpeg", platformFolder(), exe("ffmpeg")));
    if (process.platform === "win32") {
      var env = process.env;
      [env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, "Microsoft", "WinGet", "Links", "ffmpeg.exe"),
       "C:\\ffmpeg\\bin\\ffmpeg.exe",
       env.ProgramFiles && path.join(env.ProgramFiles, "ffmpeg", "bin", "ffmpeg.exe"),
       env.USERPROFILE && path.join(env.USERPROFILE, "scoop", "shims", "ffmpeg.exe"),
       "C:\\ProgramData\\chocolatey\\bin\\ffmpeg.exe"].forEach(function (p) { if (p) list.push(p); });
    } else {
      list.push("/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/usr/bin/ffmpeg", "/opt/local/bin/ffmpeg");
    }
    list.push(exe("ffmpeg")); // PATH lookup last
    return list;
  }

  function tryRun(cmd) {
    return new Promise(function (resolve) {
      var p;
      try { p = cp.spawn(cmd, ["-hide_banner", "-version"], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }); }
      catch (e) { return resolve(false); }
      var out = "";
      p.stdout.on("data", function (d) { out += d; });
      p.on("error", function () { resolve(false); });
      p.on("close", function (code) { resolve(code === 0 && /ffmpeg version/.test(out)); });
    });
  }

  /** Locate a working ffmpeg. Resolves { ok, path, tried }. */
  function findFfmpeg(opts) {
    opts = opts || {};
    if (opts.customPath !== undefined) state.customPath = opts.customPath || null;
    if (opts.extensionRoot) state.extensionRoot = opts.extensionRoot;
    if (!cp) return Promise.resolve({ ok: false, error: "Node.js is not available in this panel." });
    var list = candidates();
    state.tried = [];
    var i = 0;
    function next() {
      if (i >= list.length) {
        return { ok: false, tried: state.tried,
          error: "ffmpeg was not found. Install it (macOS: `brew install ffmpeg`; Windows: `winget install ffmpeg`) or set its path in Settings." };
      }
      var c = list[i++];
      state.tried.push(c);
      if (path.isAbsolute(c) && !fs.existsSync(c)) return next();
      return tryRun(c).then(function (ok) {
        if (ok) { state.ffmpeg = c; return { ok: true, path: c }; }
        return next();
      });
    }
    return Promise.resolve().then(next);
  }

  // ---------------------------------------------------------------- cache

  function cacheDir() {
    var d = path.join(os.tmpdir(), "poddirector-cache");
    try { fs.mkdirSync(d, { recursive: true }); } catch (e) { /* ignore */ }
    return d;
  }
  function cacheKey(mediaPath, inSec, durSec, channel, hop) {
    var st = { mtimeMs: 0, size: 0 };
    try { st = fs.statSync(mediaPath); } catch (e) { /* missing file: key still unique */ }
    return crypto.createHash("sha1").update([CACHE_VERSION, mediaPath, st.mtimeMs, st.size,
      inSec.toFixed(4), durSec.toFixed(4), channel === null || channel === undefined ? "mix" : channel, hop].join("|")).digest("hex");
  }
  function cacheGet(key) {
    try {
      var buf = fs.readFileSync(path.join(cacheDir(), key + ".f32"));
      return new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    } catch (e) { return null; }
  }
  function cachePut(key, arr) {
    try { fs.writeFileSync(path.join(cacheDir(), key + ".f32"), Buffer.from(arr.buffer)); } catch (e) { /* ignore */ }
  }
  function clearCache() {
    var d = cacheDir(), n = 0;
    try { fs.readdirSync(d).forEach(function (f) { if (/\.f32$/.test(f)) { fs.unlinkSync(path.join(d, f)); n++; } }); } catch (e) { /* ignore */ }
    return n;
  }

  // -------------------------------------------------------------- decoding

  // ------------------------------------------------------- audio layout

  var LAYOUTS = { mono: 1, stereo: 2, "2.1": 3, "3.0": 3, "3.0(back)": 3, "4.0": 4, quad: 4, "quad(side)": 4, "3.1": 4,
    "5.0": 5, "5.0(side)": 5, "4.1": 5, "5.1": 6, "5.1(side)": 6, "6.0": 6, "6.0(front)": 6, hexagonal: 6, "6.1": 7,
    "6.1(back)": 7, "6.1(front)": 7, "7.0": 7, "7.0(front)": 7, "7.1": 8, "7.1(wide)": 8, "7.1(wide-side)": 8, octagonal: 8,
    downmix: 2, "22.2": 24 };
  var layoutCache = {};

  /** Parse "ffmpeg -i" output: channel count of each audio stream, in order. */
  function parseLayout(text) {
    var streams = [];
    String(text).split(/\r?\n/).forEach(function (line) {
      if (!/Stream #\d+:\d+.*: Audio:/.test(line)) return;
      var m = /(\d+) channels/.exec(line), n = 0;
      if (m) n = +m[1];
      else {
        var parts = line.split(/,\s*/);
        for (var i = 0; i < parts.length && !n; i++) {
          var name = parts[i].trim().split(/\s/)[0];
          if (LAYOUTS[name]) n = LAYOUTS[name];
          else if (/^\d+\.\d+/.test(name)) { var xy = name.match(/^(\d+)\.(\d+)/); n = +xy[1] + +xy[2]; }
        }
      }
      streams.push(n || 2);
    });
    return streams;
  }

  /** Channel count per audio stream of a media file, e.g. [4] or [2, 2]. Cached. */
  function audioLayout(mediaPath) {
    if (layoutCache[mediaPath]) return Promise.resolve(layoutCache[mediaPath]);
    return new Promise(function (resolve) {
      var p = cp.spawn(state.ffmpeg || "ffmpeg", ["-hide_banner", "-i", mediaPath], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      var err = "";
      p.stderr.on("data", function (d) { err += d; });
      p.on("error", function () { resolve([2]); });
      p.on("close", function () { var l = parseLayout(err); layoutCache[mediaPath] = l.length ? l : [2]; resolve(layoutCache[mediaPath]); });
    });
  }

  /** Global channel number (0-based, counting across all audio streams) -> { stream, chan }. */
  function locateChannel(layout, channel) {
    var c = channel;
    for (var s = 0; s < layout.length; s++) {
      if (c < layout[s]) return { stream: s, chan: c };
      c -= layout[s];
    }
    return null; // beyond the last channel
  }

  /**
   * Loudness of one source range. Returns Float32Array of dB values, one per hop.
   * channel: null = mix all channels, n = use only channel n (0-based).
   */
  function analyzeRange(mediaPath, inSec, durSec, channel, hop) {
    hop = hop || DEFAULT_HOP;
    var key = cacheKey(mediaPath, inSec, durSec, channel, hop);
    var cached = cacheGet(key);
    if (cached) return Promise.resolve(cached);
    if (!state.ffmpeg) return Promise.reject(new Error("Call findFfmpeg() first."));

    var hopSamples = Math.round(RATE * hop);
    var total = Math.ceil(durSec / hop);
    var out = new Float32Array(total).fill(SILENT_DB);

    var wantChannel = channel !== null && channel !== undefined;
    return (wantChannel ? audioLayout(mediaPath) : Promise.resolve(null)).then(function (layout) {
    var filters = [], map = ["-map", "0:a:0?"];
    if (wantChannel) {
      var loc = locateChannel(layout, channel);
      if (!loc) return Promise.reject(new Error(path.basename(mediaPath) + " has only " + layout.reduce(function (a, b) { return a + b; }, 0) +
        " audio channel(s); channel " + (channel + 1) + " doesn't exist."));
      map = ["-map", "0:a:" + loc.stream];
      if (layout[loc.stream] > 1) filters.push("pan=mono|c0=c" + loc.chan);
    }
    filters.push("highpass=f=90", "lowpass=f=5000"); // voice band: ignores rumble, HVAC, hiss
    var args = ["-hide_banner", "-nostats", "-loglevel", "error",
      "-ss", String(Math.max(0, inSec)), "-t", String(durSec), "-i", mediaPath].concat(map, [
      "-vn", "-sn", "-dn", "-af", filters.join(","), "-ac", "1", "-ar", String(RATE),
      "-f", "s16le", "-acodec", "pcm_s16le", "pipe:1"]);

    return new Promise(function (resolve, reject) {
      var p = cp.spawn(state.ffmpeg, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      var idx = 0, acc = 0, count = 0, carry = null, err = "";
      p.stdout.on("data", function (chunk) {
        if (carry) { chunk = Buffer.concat([carry, chunk]); carry = null; }
        var usable = chunk.length - (chunk.length % 2);
        if (usable < chunk.length) carry = chunk.slice(usable);
        for (var o = 0; o < usable; o += 2) {
          var v = chunk.readInt16LE(o) / 32768;
          acc += v * v; count++;
          if (count === hopSamples) {
            if (idx < total) out[idx] = acc > 0 ? Math.max(SILENT_DB, 10 * Math.log10(acc / count)) : SILENT_DB;
            idx++; acc = 0; count = 0;
          }
        }
      });
      p.stderr.on("data", function (d) { if (err.length < 2000) err += d; });
      p.on("error", reject);
      p.on("close", function (code) {
        if (count > 0 && idx < total) out[idx] = acc > 0 ? Math.max(SILENT_DB, 10 * Math.log10(acc / count)) : SILENT_DB;
        if (code !== 0 && idx === 0) {
          // Channel requested but file is mono? retry on mixdown.
          if (channel !== null && channel !== undefined && /pan|channel/i.test(err)) {
            return resolve(analyzeRange(mediaPath, inSec, durSec, null, hop));
          }
          return reject(new Error("ffmpeg failed on " + mediaPath + ": " + err.trim()));
        }
        cachePut(key, out);
        resolve(out);
      });
    });
    });
  }

  /**
   * Stitch every clip of a timeline audio track into one curve in sequence time.
   * track.clips: [{ startSec, endSec, inPointSec, mediaPath, speed? }]
   */
  function analyzeTrack(track, durationSec, opts) {
    opts = opts || {};
    var hop = opts.hopSec || DEFAULT_HOP;
    var channel = opts.channel === undefined ? null : opts.channel;
    var total = Math.ceil(durationSec / hop);
    var curve = new Float32Array(total).fill(SILENT_DB);
    var clips = (track.clips || []).filter(function (c) { return c.mediaPath && c.endSec > c.startSec; })
      .sort(function (a, b) { return a.startSec - b.startSec; });
    var done = 0;
    return clips.reduce(function (chain, clip) {
      return chain.then(function () {
        var speed = clip.speed && isFinite(clip.speed) && clip.speed > 0 ? clip.speed : 1;
        var tlDur = clip.endSec - clip.startSec;
        // A clip can carry its own channel (multichannel files); otherwise the track-wide one applies.
        var ch = clip.channel !== undefined ? clip.channel : channel;
        return analyzeRange(clip.mediaPath, clip.inPointSec || 0, tlDur * speed, ch, hop).catch(function (err) {
          // One odd clip (fewer channels, unreadable) shouldn't stop the whole analysis: fall back to its full mix.
          if (ch === null || ch === undefined) throw err;
          if (opts.onWarning) opts.onWarning(err.message + " Using that clip's full mix instead.");
          return analyzeRange(clip.mediaPath, clip.inPointSec || 0, tlDur * speed, null, hop);
        }).then(function (vals) {
          var startIdx = Math.round(clip.startSec / hop);
          var n = Math.round(tlDur / hop);
          for (var k = 0; k < n; k++) {
            var src = Math.floor(k * speed);
            var dst = startIdx + k;
            if (dst >= 0 && dst < total && src < vals.length) curve[dst] = Math.max(curve[dst], vals[src]);
          }
          done++;
          if (opts.onProgress) opts.onProgress(done, clips.length);
        });
      });
    }, Promise.resolve()).then(function () { return curve; });
  }

  /** Run tasks (functions returning promises) with a concurrency limit. */
  function pool(tasks, limit) {
    var results = new Array(tasks.length), next = 0;
    function worker() {
      if (next >= tasks.length) return Promise.resolve();
      var i = next++;
      return tasks[i]().then(function (r) { results[i] = r; return worker(); });
    }
    var workers = [];
    for (var w = 0; w < Math.min(limit, tasks.length); w++) workers.push(worker());
    return Promise.all(workers).then(function () { return results; });
  }

  return {
    RATE: RATE, DEFAULT_HOP: DEFAULT_HOP,
    findFfmpeg: findFfmpeg, analyzeRange: analyzeRange, audioLayout: audioLayout, locateChannel: locateChannel, parseLayout: parseLayout, analyzeTrack: analyzeTrack,
    pool: pool, clearCache: clearCache,
    ffmpegPath: function () { return state.ffmpeg; }
  };
});
