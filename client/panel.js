/* PodDirector panel controller. */
(function () {
  "use strict";

  var cs = new CSInterface();
  var inPremiere = !!window.__adobe_cep__;
  var hasNode = typeof require === "function" && typeof process !== "undefined";
  var D = window.PodDirector, T = window.PodTranscript, A = window.PodAnalyzer, W = window.PodTranscriber, UI = window.PD_UI;
  var fs = hasNode ? require("fs") : null, path = hasNode ? require("path") : null, os = hasNode ? require("os") : null;
  var MARK_CAM = "[PD] ", MARK_CUT = "[PD cut] ";
  var HOP = 0.025;

  var state = {
    seq: null,
    config: null,
    curves: {},        // "track:channel" -> Float32Array
    result: null,
    busy: false,
    tx: { segments: null, suggestions: [], off: {}, nudges: {} },
    cleanupOpts: copy(T.DEFAULTS),
    tools: { ffmpeg: null, whisper: null },
    extRoot: null, docsDir: null,
    selection: null
  };

  // ------------------------------------------------------------ helpers
  function $(id) { return document.getElementById(id); }
  function copy(o) { return JSON.parse(JSON.stringify(o)); }
  function el(tag, attrs, kids) {
    var e = document.createElement(tag);
    for (var k in (attrs || {})) {
      if (k === "class") e.className = attrs[k];
      else if (k === "text") e.textContent = attrs[k];
      else if (k === "html") e.innerHTML = attrs[k];
      else if (k.indexOf("on") === 0) e.addEventListener(k.slice(2), attrs[k]);
      else if (attrs[k] !== null && attrs[k] !== undefined && attrs[k] !== false) e.setAttribute(k, attrs[k]);
    }
    (kids || []).forEach(function (c) { if (c) e.appendChild(typeof c === "string" ? document.createTextNode(c) : c); });
    return e;
  }
  function log(msg) {
    var line = new Date().toLocaleTimeString() + "  " + msg;
    var pre = $("log"); pre.textContent += line + "\n"; pre.scrollTop = pre.scrollHeight;
    if (window.console) console.log("[PodDirector] " + msg);
  }
  function status(text, kind, pct) {
    var s = $("statusText"); s.textContent = text; s.className = kind || "";
    if (pct !== undefined && pct !== null) $("progFill").style.width = Math.round(pct * 100) + "%";
    if (kind === "err") log("ERROR: " + text);
  }
  function fmt(t) { return T.formatTime(t); }
  function store(key, val) { try { localStorage.setItem("pd." + key, JSON.stringify(val)); } catch (e) { /* ignore */ } }
  function load(key, def) { try { var v = localStorage.getItem("pd." + key); return v ? JSON.parse(v) : def; } catch (e) { return def; } }
  var timers = {};
  function debounce(name, fn, ms) { clearTimeout(timers[name]); timers[name] = setTimeout(fn, ms || 120); }

  function callHost(fn, args) {
    var call = "PD." + fn + "(" + (args || []).map(function (a) { return JSON.stringify(a); }).join(",") + ")";
    return new Promise(function (resolve, reject) {
      if (!inPremiere) return reject(new Error("Not running inside Premiere Pro."));
      cs.evalScript(call, function (res) {
        if (!res || res === "EvalScript error.") return reject(new Error("Premiere script error in " + fn + ". Is host.jsx loaded?"));
        var o;
        try { o = JSON.parse(res); } catch (e) { return reject(new Error("Unexpected reply from Premiere: " + String(res).slice(0, 200))); }
        if (!o.ok) return reject(new Error(o.error || "Unknown Premiere error"));
        resolve(o);
      });
    });
  }
  function guard(fn) {
    return function () {
      if (state.busy) return;
      var args = arguments;
      state.busy = true; setButtons();
      Promise.resolve().then(function () { return fn.apply(null, args); })
        .catch(function (e) { status(e.message || String(e), "err", 0); })
        .then(function () { state.busy = false; setButtons(); });
    };
  }

  // -------------------------------------------------------------- setup
  function init() {
    $("ver").textContent = "v" + D.VERSION;
    if (hasNode) {
      state.extRoot = (inPremiere && cs.getExtensionPath()) || path.resolve(__dirname || ".", "..");
      var docs = (inPremiere && cs.getUserDocuments()) || path.join(os.homedir(), "Documents");
      state.docsDir = path.join(docs, "PodDirector");
      try { fs.mkdirSync(path.join(state.docsDir, "presets"), { recursive: true }); } catch (e) { /* ignore */ }
      $("docsDir").textContent = state.docsDir;
    }
    $("ffmpegCustom").value = load("ffmpegCustom", "");
    $("modelCustom").value = load("modelCustom", "");
    $("txPrompt").value = load("txPrompt", "");
    state.cleanupOpts = Object.assign(copy(T.DEFAULTS), load("cleanupOpts", {}));

    // tabs
    Array.prototype.forEach.call(document.querySelectorAll(".tab"), function (b) {
      b.addEventListener("click", function () {
        Array.prototype.forEach.call(document.querySelectorAll(".tab"), function (x) { x.classList.toggle("active", x === b); });
        Array.prototype.forEach.call(document.querySelectorAll(".page"), function (p) { p.classList.toggle("active", p.id === "page-" + b.dataset.tab); });
        if (b.dataset.tab === "multicam") viz.render();
      });
    });
    $("btnLog").addEventListener("click", function () { $("log").classList.toggle("hidden"); });

    state.config = defaultConfig();
    renderAll();
    renderCleanupControls();
    checkTools();
    if (!inPremiere) {
      status("Not running in Premiere — demo mode. Click Scan to load a sample podcast.", "", 0);
    }
  }

  function defaultConfig() {
    return { preset: "balanced", userPreset: null, style: {}, speakers: [], cameras: [], overrides: [] };
  }

  function checkTools() {
    if (!hasNode) { $("ffmpegPath").textContent = "Node.js unavailable"; return Promise.resolve(); }
    return A.findFfmpeg({ customPath: $("ffmpegCustom").value.trim(), extensionRoot: state.extRoot }).then(function (r) {
      state.tools.ffmpeg = r.ok ? r.path : null;
      $("ffmpegPath").textContent = r.ok ? r.path : "NOT FOUND";
      if (!r.ok) { log("ffmpeg lookup tried: " + (r.tried || []).join(" | ")); status(r.error, "err"); }
      var w = W.locate({ extensionRoot: state.extRoot, modelPath: $("modelCustom").value.trim() });
      state.tools.whisper = w.ok ? w : null;
      $("whisperPath").textContent = w.whisper || "not found";
      $("modelPath").textContent = w.model ? path.basename(w.model) : "not found";
      if (!w.ok) log("Transcriber: " + w.error);
    });
  }

  // --------------------------------------------------------------- scan
  var scan = guard(function () {
    status("Reading the active sequence…", "", 0.05);
    var p = inPremiere ? callHost("getSequenceInfo") : Promise.resolve(window.PD_DEMO.sequence());
    return p.then(function (info) {
      var changed = !state.seq || state.seq.sequenceID !== info.sequenceID;
      state.seq = info;
      $("seqLabel").textContent = info.name + " · " + info.fps.toFixed(2) + " fps · " + fmt(info.durationSec);
      log("Sequence " + info.name + ": " + info.audioTracks.length + " audio, " + info.videoTracks.length + " video tracks, " + fmt(info.durationSec));
      if (changed) {
        var saved = load("seq." + info.name, null);
        state.config = saved && validConfig(saved, info) ? saved : guessConfig(info);
        state.result = null; state.curves = {};
        state.tx = { segments: null, suggestions: [], off: {}, nudges: {} };
        loadCachedTranscript();
      }
      renderAll();
      status("Sequence ready. Check speakers and cameras, then Analyze waveforms.", "ok", 0);
    });
  });

  function validConfig(c, info) {
    return c.speakers && c.cameras && c.speakers.every(function (s) { return s.audioTrack < info.audioTracks.length; }) &&
      c.cameras.every(function (cm) { return cm.videoTrack < info.videoTracks.length; });
  }

  function guessConfig(info) {
    var cfg = defaultConfig();
    var camMedia = {};
    info.videoTracks.forEach(function (v) { (v.mediaPaths || []).forEach(function (m) { camMedia[m] = true; }); });
    var audio = info.audioTracks.filter(function (a) { return a.clips.length && !a.muted; });
    // Audio that comes from a camera file is scratch audio, not a speaker mic.
    var mics = audio.filter(function (a) { return !a.clips.some(function (c) { return camMedia[c.mediaPath]; }); });
    if (!mics.length) mics = audio;
    mics.slice(0, 8).forEach(function (a, i) {
      var generic = /^(audio|a)\s*\d+$/i.test(a.name);
      cfg.speakers.push({ id: "S" + (i + 1), name: generic ? "Speaker " + (i + 1) : a.name, audioTrack: a.index, channel: null,
        thresholdDb: null, biasDb: 0, minShotSec: null, interjections: true, reactionShots: true, enabled: true });
    });
    var vids = info.videoTracks.filter(function (v) { return v.clipCount > 0; });
    var GENERIC = { mic: 1, microphone: 1, audio: 1, lav: 1, track: 1, speaker: 1, cam: 1, camera: 1 };
    function tokens(n) { return n.toLowerCase().split(/[^a-z0-9]+/).filter(function (w) { return w && !GENERIC[w] && !/^\d+$/.test(w); }); }
    var allIds = cfg.speakers.map(function (s) { return s.id; });
    var next = 0;
    vids.forEach(function (v, i) {
      var nm = (v.name && !/^(video|v)\s*\d+$/i.test(v.name)) ? v.name : (v.firstClip || ("V" + (v.index + 1)));
      var words = tokens(nm);
      var shows;
      var byName = cfg.speakers.filter(function (s) { return tokens(s.name).some(function (w) { return words.indexOf(w) >= 0; }); });
      if (/wide|master|group|2.?shot|two.?shot|\ball\b/i.test(nm)) shows = allIds.slice();
      else if (byName.length) shows = byName.map(function (s) { return s.id; });
      else if (next < cfg.speakers.length) shows = [cfg.speakers[next++].id];
      else shows = allIds.slice();
      cfg.cameras.push({ id: "C" + (i + 1), name: nm.replace(/\.[a-z0-9]{2,4}$/i, ""), videoTrack: v.index, shows: shows, enabled: true });
    });
    return cfg;
  }

  function saveConfig() { if (state.seq) store("seq." + state.seq.name, state.config); }

  // ------------------------------------------------------------ render
  function renderAll() {
    renderSpeakers(); renderCameras(); renderPresetSelect(); renderStyle(); renderLocks(); setButtons();
  }

  function colorOf(i) { return UI.colors[i % UI.colors.length]; }
  function trackOptions(kind) {
    if (!state.seq) return [];
    var list = kind === "audio" ? state.seq.audioTracks : state.seq.videoTracks;
    return list.map(function (t) { return [t.index, (kind === "audio" ? "A" : "V") + (t.index + 1) + (t.name && !/^(audio|video|a|v)\s*\d+$/i.test(t.name) ? " · " + t.name : "")]; });
  }
  function select(options, value, onchange, cls) {
    var s = el("select", { class: cls || "", onchange: function () { onchange(s.value); } });
    options.forEach(function (o) { var op = el("option", { value: o[0], text: o[1] }); if (String(o[0]) === String(value)) op.selected = true; s.appendChild(op); });
    return s;
  }
  function changed(replanOnly) { saveConfig(); if (!replanOnly) setButtons(); debounce("plan", replan, 120); }

  function renderSpeakers() {
    var box = $("speakerList"); box.innerHTML = "";
    if (!state.config.speakers.length) { box.appendChild(el("div", { class: "muted", text: state.seq ? "No speaker mics found. Add one." : "Scan a sequence to begin." })); return; }
    state.config.speakers.forEach(function (sp, i) {
      var row = el("div", { class: "row" + (sp._open ? " open" : "") });
      row.style.setProperty("--sw", colorOf(i));
      var name = el("input", { class: "name", value: sp.name, oninput: function () { sp.name = name.value; renderCameras(); changed(true); } });
      var chans = [["mix", "All ch"], [0, "Ch 1"], [1, "Ch 2"], [2, "Ch 3"], [3, "Ch 4"], [4, "Ch 5"], [5, "Ch 6"], [6, "Ch 7"], [7, "Ch 8"]];
      var main = el("div", { class: "row-main" }, [
        name,
        select(trackOptions("audio"), sp.audioTrack, function (v) { sp.audioTrack = +v; changed(); }),
        select(chans, sp.channel === null ? "mix" : sp.channel, function (v) { sp.channel = v === "mix" ? null : +v; changed(); }),
        el("button", { class: "icon", title: "More settings", text: sp._open ? "▾" : "⚙", onclick: function () { sp._open = !sp._open; renderSpeakers(); } })
      ]);
      row.appendChild(main);
      var cal = state.result && calFor(sp.id);
      if (cal) {
        var lv = el("div", { class: "level", title: "noise floor → speech level; white line = threshold" });
        var lo = -70, hi = -6, pos = function (db) { return Math.max(0, Math.min(100, (db - lo) / (hi - lo) * 100)); };
        var bar = el("i"); bar.style.left = pos(cal.floorDb) + "%"; bar.style.width = (pos(cal.speechDb) - pos(cal.floorDb)) + "%";
        var th = el("b"); th.style.left = pos(cal.thresholdDb) + "%";
        lv.appendChild(bar); lv.appendChild(th); row.appendChild(lv);
      }
      var more = el("div", { class: "row-more" });
      var auto = sp.thresholdDb === null || sp.thresholdDb === undefined;
      var autoVal = cal ? cal.autoThresholdDb : -45;
      more.appendChild(slider({ label: "Threshold", min: -75, max: -10, step: 1, unit: "dB",
        help: "Level above which this mic counts as talking. Auto calibrates from the noise floor and speech level." },
        auto ? autoVal : sp.thresholdDb, function (v) { sp.thresholdDb = v; changed(true); },
        { autoToggle: auto, onAuto: function (on) { sp.thresholdDb = on ? null : Math.round(autoVal); renderSpeakers(); changed(true); } }));
      more.appendChild(slider({ label: "Priority", min: -10, max: 10, step: 0.5, unit: "dB",
        help: "Wins close calls and overlaps. Give the host +3 to favor them, or a guest −3 to cut to them less." },
        sp.biasDb || 0, function (v) { sp.biasDb = v; changed(true); }));
      more.appendChild(slider({ label: "Min shot", min: 0, max: 8, step: 0.1, unit: "s", zero: "global",
        help: "Minimum length for this speaker's shots. 0 = use the global setting." },
        sp.minShotSec || 0, function (v) { sp.minShotSec = v > 0 ? v : null; changed(true); }));
      var chips = el("div", { class: "chips" }, [
        chip("Reacts on screen", sp.interjections !== false, function (on) { sp.interjections = on; changed(true); },
          "Their laughs / “yeah”s can trigger a reaction shot of them"),
        chip("Use as listener", sp.reactionShots !== false, function (on) { sp.reactionShots = on; changed(true); },
          "Can be shown listening during someone else's monologue"),
        chip("Enabled", sp.enabled !== false, function (on) { sp.enabled = on; changed(); }, "Turn off to ignore this mic"),
        el("button", { class: "btn ghost small", text: "Remove", onclick: function () {
          state.config.speakers.splice(i, 1);
          state.config.cameras.forEach(function (c) { c.shows = c.shows.filter(function (id) { return id !== sp.id; }); });
          renderAll(); changed();
        } })
      ]);
      more.appendChild(chips);
      row.appendChild(more);
      box.appendChild(row);
    });
  }
  function calFor(id) {
    if (!state.result) return null;
    return state.result.calibration.filter(function (c) { return c.id === id; })[0] || null;
  }

  function chip(label, on, cb, title) {
    var c = el("label", { class: "chip" + (on ? " on" : ""), title: title || null });
    var box = el("input", { type: "checkbox" }); box.checked = on;
    box.addEventListener("change", function () { c.classList.toggle("on", box.checked); cb(box.checked); });
    c.appendChild(box); c.appendChild(document.createTextNode(label));
    return c;
  }

  function renderCameras() {
    var box = $("cameraList"); box.innerHTML = "";
    if (!state.config.cameras.length) { box.appendChild(el("div", { class: "muted", text: state.seq ? "No camera tracks. Add one." : "" })); return; }
    var spk = state.config.speakers;
    state.config.cameras.forEach(function (cm, i) {
      var row = el("div", { class: "row" });
      row.style.setProperty("--sw", camColor(i));
      var name = el("input", { class: "name", value: cm.name, oninput: function () { cm.name = name.value; changed(true); } });
      var role = cm.shows.length === 0 ? "unused" : cm.shows.length === 1 ? "close-up" : (cm.shows.length === spk.length ? "wide" : cm.shows.length + "-shot");
      row.appendChild(el("div", { class: "row-main" }, [
        name,
        select(trackOptions("video"), cm.videoTrack, function (v) { cm.videoTrack = +v; changed(); }),
        el("span", { class: "muted small", text: role }),
        el("button", { class: "icon", title: "Remove camera", text: "✕", onclick: function () { state.config.cameras.splice(i, 1); renderCameras(); changed(); } })
      ]));
      var chips = el("div", { class: "chips" });
      spk.forEach(function (sp) {
        chips.appendChild(chip(sp.name, cm.shows.indexOf(sp.id) >= 0, function (on) {
          cm.shows = cm.shows.filter(function (id) { return id !== sp.id; });
          if (on) cm.shows.push(sp.id);
          renderCameras(); changed();
        }));
      });
      chips.appendChild(chip("Enabled", cm.enabled !== false, function (on) { cm.enabled = on; changed(); }));
      row.appendChild(chips);
      box.appendChild(row);
    });
  }
  // Close-ups take their speaker's colour; wides/group shots get neutral tones.
  function camColor(i) {
    var cm = state.config.cameras[i];
    if (cm && cm.shows.length === 1) {
      var si = -1;
      state.config.speakers.forEach(function (s, k) { if (s.id === cm.shows[0]) si = k; });
      if (si >= 0) return colorOf(si);
    }
    var neutrals = ["#b8bec7", "#8d939c", "#d9d2c3", "#a7b8a8"];
    var n = 0;
    for (var k = 0; k < i; k++) { var c = state.config.cameras[k]; if (!c || c.shows.length !== 1) n++; }
    return neutrals[n % neutrals.length];
  }

  // ----------------------------------------------------- style controls
  function effectiveStyle() { return D.styleFromPreset(state.config.preset, state.config.style); }

  function slider(def, value, onchange, opts) {
    opts = opts || {};
    var wrap = el("div", { class: "ctl", title: def.help || "" });
    var lab = el("label", { text: def.label });
    var out = el("output");
    var input = el("input", { type: "range", min: def.min, max: def.max, step: def.step });
    input.value = value;
    function show(v) {
      v = +v;
      if (opts.autoToggle) { out.textContent = "auto " + Math.round(v); return; }
      if (def.zero && v === 0) out.textContent = def.zero;
      else if (def.pct) out.textContent = Math.round(v * 100) + "%";
      else out.textContent = (Math.abs(v) < 10 && def.step < 1 ? v.toFixed(def.step < 0.1 ? 2 : 1) : String(Math.round(v * 10) / 10)) + (def.unit && def.unit !== "%" ? " " + def.unit : "");
    }
    show(value);
    input.addEventListener("input", function () {
      if (opts.autoToggle && opts.onAuto) { opts.autoToggle = false; opts.onAuto(false); return; }
      show(input.value); onchange(+input.value);
    });
    wrap.appendChild(lab); wrap.appendChild(input); wrap.appendChild(out);
    if (opts.onAuto) {
      out.style.cursor = "pointer"; out.title = "Click to toggle Auto";
      out.addEventListener("click", function () { opts.onAuto(!opts.autoToggle); });
    }
    return wrap;
  }

  function renderStyle() {
    var box = $("styleControls"); box.innerHTML = "";
    var st = effectiveStyle();
    var base = D.styleFromPreset(state.config.preset, {});
    UI.styleGroups.forEach(function (g) {
      var det = el("details", { class: "group" });
      if (g.open) det.open = true;
      det.appendChild(el("summary", { text: g.title }));
      g.controls.forEach(function (def) {
        var node;
        var set = function (v) { state.config.style[def.key] = v; node.classList.toggle("changed", v !== base[def.key]); changed(true); };
        if (def.type === "select") {
          node = el("div", { class: "ctl", title: def.help || "" }, [el("label", { text: def.label }),
            select(def.options, st[def.key], function (v) { set(v); })]);
        } else node = slider(def, st[def.key], set);
        if (state.config.style[def.key] !== undefined && state.config.style[def.key] !== base[def.key]) node.classList.add("changed");
        det.appendChild(node);
      });
      box.appendChild(det);
    });
  }

  function userPresets() {
    var list = load("userPresets", {});
    if (hasNode && state.docsDir) {
      try {
        fs.readdirSync(path.join(state.docsDir, "presets")).forEach(function (f) {
          if (!/\.json$/.test(f)) return;
          try { var p = JSON.parse(fs.readFileSync(path.join(state.docsDir, "presets", f), "utf8")); list[p.name || f.replace(/\.json$/, "")] = p; } catch (e) { /* skip bad */ }
        });
      } catch (e) { /* no folder */ }
    }
    return list;
  }

  function renderPresetSelect() {
    var s = $("presetSelect"); s.innerHTML = "";
    Object.keys(D.PRESETS).forEach(function (k) { s.appendChild(el("option", { value: "b:" + k, text: D.PRESETS[k].label })); });
    var ups = userPresets();
    Object.keys(ups).forEach(function (k) { s.appendChild(el("option", { value: "u:" + k, text: "★ " + k })); });
    s.value = state.config.userPreset ? "u:" + state.config.userPreset : "b:" + state.config.preset;
    s.onchange = function () {
      var v = s.value;
      if (v.indexOf("b:") === 0) { state.config.preset = v.slice(2); state.config.style = {}; state.config.userPreset = null; }
      else {
        var p = userPresets()[v.slice(2)];
        state.config.preset = p.basePreset || "balanced"; state.config.style = copy(p.style || {}); state.config.userPreset = v.slice(2);
      }
      renderStyle(); changed(true);
    };
  }

  function savePreset() {
    var row = $("presetSelect").parentNode;
    if (row.querySelector(".preset-name")) return;
    var input = el("input", { class: "preset-name", placeholder: "Preset name" });
    var okBtn = el("button", { class: "btn primary small", text: "OK", onclick: function () {
      var name = input.value.trim(); if (!name) return;
      var p = { name: name, basePreset: state.config.preset, style: copy(state.config.style), savedAt: new Date().toISOString() };
      var all = load("userPresets", {}); all[name] = p; store("userPresets", all);
      if (hasNode && state.docsDir) fs.writeFileSync(path.join(state.docsDir, "presets", name.replace(/[^\w -]/g, "_") + ".json"), JSON.stringify(p, null, 2));
      state.config.userPreset = name; saveConfig();
      input.remove(); okBtn.remove(); renderPresetSelect();
      status("Saved preset “" + name + "”.", "ok");
    } });
    row.insertBefore(okBtn, row.firstChild); row.insertBefore(input, row.firstChild); input.focus();
  }

  // ------------------------------------------------------------ analyze
  function curveKey(sp) { return sp.audioTrack + ":" + (sp.channel === null || sp.channel === undefined ? "mix" : sp.channel); }

  var analyze = guard(function () {
    if (!state.seq) throw new Error("Scan a sequence first.");
    var spk = state.config.speakers.filter(function (s) { return s.enabled !== false; });
    if (!spk.length) throw new Error("Add at least one speaker mic.");
    if (!inPremiere) { // demo
      state.curves = window.PD_DEMO.curves(state.seq, state.config, HOP);
      replan(); status("Demo analysis ready.", "ok", 1); return;
    }
    if (!state.tools.ffmpeg) throw new Error("ffmpeg is not available. See Settings.");
    var keys = {}, jobs = [];
    spk.forEach(function (sp) { keys[curveKey(sp)] = sp; });
    var dur = state.seq.durationSec, done = 0, total = Object.keys(keys).length;
    var t0 = Date.now();
    status("Reading waveforms (0/" + total + ")…", "", 0.02);
    Object.keys(keys).forEach(function (k) {
      var sp = keys[k], track = state.seq.audioTracks[sp.audioTrack];
      jobs.push(function () {
        return A.analyzeTrack(track, dur, { hopSec: HOP, channel: sp.channel, onProgress: function (i, n) {
          status("Reading " + track.name + " clip " + i + "/" + n + " (" + done + "/" + total + " tracks done)…", "", (done + i / n) / total);
        } }).then(function (curve) { state.curves[k] = curve; done++; });
      });
    });
    return A.pool(jobs, 3).then(function () {
      log("Analyzed " + total + " mic track(s) in " + ((Date.now() - t0) / 1000).toFixed(1) + " s");
      replan();
      renderSpeakers();
      status("Analysis ready — tweak the style and watch the preview update.", "ok", 1);
    });
  });

  function curvesReady() {
    return state.config.speakers.filter(function (s) { return s.enabled !== false; }).every(function (s) { return state.curves[curveKey(s)]; });
  }

  function replan() {
    if (!state.seq || !curvesReady()) { viz.setData(null); state.result = null; setButtons(); $("vizHint").textContent = state.seq ? "analyze to see the cut" : ""; return; }
    var curves = {};
    state.config.speakers.forEach(function (s) { if (state.curves[curveKey(s)]) curves[s.id] = state.curves[curveKey(s)]; });
    try {
      state.result = D.plan({ durationSec: state.seq.durationSec, hopSec: HOP, fps: state.seq.fps, curves: curves }, state.config);
    } catch (e) { status(e.message, "err"); state.result = null; setButtons(); return; }
    var spk = state.config.speakers.filter(function (s) { return s.enabled !== false; });
    var cams = state.config.cameras.map(function (c, i) { return { id: c.id, name: c.name, color: camColor(i) }; });
    viz.setData({
      durationSec: state.seq.durationSec, hopSec: HOP, curves: curves,
      speakers: spk.map(function (s) { return { id: s.id, name: s.name, color: colorOf(state.config.speakers.indexOf(s)) }; }),
      calibration: state.result.calibration, speech: state.result.speech, shots: state.result.shots,
      cameras: cams, cleanup: acceptedCuts()
    });
    $("vizHint").textContent = "click = jump playhead · drag = lock a camera · wheel = zoom";
    renderStats(); setButtons();
    refreshSpeakerLevels();
  }
  // Calibration bars live in the speaker rows; redraw them when the user isn't typing/dragging there.
  function refreshSpeakerLevels() {
    debounce("spk", function () {
      var a = document.activeElement;
      if (a && $("speakerList").contains(a) && (a.tagName === "INPUT" || a.tagName === "SELECT")) return refreshSpeakerLevels();
      renderSpeakers();
    }, 400);
  }

  function renderStats() {
    var box = $("stats"); box.innerHTML = "";
    if (!state.result) return;
    var s = state.result.stats;
    [[s.cuts, "cuts"], [s.cutsPerMinute, "cuts / min"], [s.avgShotSec + "s", "avg shot"], [s.longestShotSec + "s", "longest"]].forEach(function (p) {
      box.appendChild(el("div", { class: "stat" }, [el("b", { text: String(p[0]) }), el("span", { text: p[1] })]));
    });
    var bars = el("div", { class: "bars" });
    state.config.cameras.forEach(function (c, i) {
      var pct = s.screenTimePct[c.id] || 0;
      var fill = el("i"); fill.style.width = pct + "%"; fill.style.background = camColor(i);
      bars.appendChild(el("div", { class: "bar" }, [el("span", { text: c.name }), el("div", {}, [fill]), el("span", { text: pct + "%" })]));
    });
    state.config.speakers.forEach(function (sp, i) {
      if (s.talkTimePct[sp.id] === undefined) return;
      var fill = el("i"); fill.style.width = s.talkTimePct[sp.id] + "%"; fill.style.background = colorOf(i); fill.style.opacity = ".5";
      bars.appendChild(el("div", { class: "bar" }, [el("span", { class: "muted", text: sp.name + " talks" }), el("div", {}, [fill]), el("span", { class: "muted", text: s.talkTimePct[sp.id] + "%" })]));
    });
    box.appendChild(bars);
  }

  // -------------------------------------------------------------- locks
  function onSelect(a, b) {
    state.selection = [a, b];
    $("lockLabel").textContent = fmt(a) + " – " + fmt(b) + "  lock to:";
    var btns = $("lockButtons"); btns.innerHTML = "";
    state.config.cameras.forEach(function (c, i) {
      var bt = el("button", { class: "btn small", text: c.name, onclick: function () { addLock(c.id); } });
      bt.style.borderColor = camColor(i);
      btns.appendChild(bt);
    });
    btns.appendChild(el("button", { class: "btn ghost small", text: "Auto (unlock)", onclick: function () { addLock(null); } }));
    $("lockBar").classList.remove("hidden");
  }
  function addLock(camId) {
    var a = state.selection[0], b = state.selection[1];
    var keep = [];
    state.config.overrides.forEach(function (o) {
      if (o.endSec <= a || o.startSec >= b) { keep.push(o); return; }
      if (o.startSec < a) keep.push({ startSec: o.startSec, endSec: a, cameraId: o.cameraId });
      if (o.endSec > b) keep.push({ startSec: b, endSec: o.endSec, cameraId: o.cameraId });
    });
    if (camId) keep.push({ startSec: a, endSec: b, cameraId: camId });
    keep.sort(function (x, y) { return x.startSec - y.startSec; });
    state.config.overrides = keep;
    clearSelection(); renderLocks(); changed(true);
  }
  function clearSelection() { state.selection = null; viz.sel = null; $("lockBar").classList.add("hidden"); viz.render(); }
  function renderLocks() {
    var box = $("lockList"); box.innerHTML = "";
    var byId = {}; state.config.cameras.forEach(function (c) { byId[c.id] = c.name; });
    state.config.overrides.forEach(function (o, i) {
      box.appendChild(el("span", { class: "lock" }, [
        el("span", { text: "🔒 " + fmt(o.startSec) + "–" + fmt(o.endSec) + " " + (byId[o.cameraId] || "?"), style: "cursor:pointer",
          onclick: function () { seek(o.startSec); } }),
        el("button", { class: "icon", text: "✕", onclick: function () { state.config.overrides.splice(i, 1); renderLocks(); changed(true); } })
      ]));
    });
  }

  // ----------------------------------------------------- write to Premiere
  function seek(t) {
    viz.setPlayhead(t);
    if (inPremiere && !state.busy) callHost("setPlayhead", [t]).catch(function (e) { log(e.message); });
  }

  var previewMarkers = guard(function () {
    if (!state.result) return;
    var byId = {}; state.config.cameras.forEach(function (c, i) { byId[c.id] = { name: c.name, color: UI.markerColors[i % UI.markerColors.length] }; });
    var spkName = {}; state.config.speakers.forEach(function (s) { spkName[s.id] = s.name; });
    var markers = state.result.shots.map(function (s) {
      var c = byId[s.cameraId] || { name: s.cameraId, color: 5 };
      return { startSec: s.startSec, name: c.name, color: c.color,
        comment: s.reason + (s.speakers.length ? " — " + s.speakers.map(function (id) { return spkName[id]; }).join(", ") : "") };
    });
    status("Adding " + markers.length + " markers…", "", 0.3);
    return callHost("clearMarkers", [MARK_CAM]).then(function () {
      return callHost("addMarkers", [JSON.stringify({ prefix: MARK_CAM, markers: markers })]);
    }).then(function (r) { status("Added " + r.added + " camera markers. Scrub through to review, then Build cut.", "ok", 1); });
  });

  var clearCamMarkers = guard(function () {
    return callHost("clearMarkers", [MARK_CAM]).then(function (r) { status("Removed " + r.removed + " PodDirector markers.", "ok"); });
  });

  var applyCut = guard(function () {
    if (!state.result) return;
    var cams = state.config.cameras.filter(function (c) { return c.enabled !== false; });
    var payload = D.toEditPayload(state.result, cams, state.seq.fps);
    var tracks = [];
    payload.cameraTracks.forEach(function (t) { if (tracks.indexOf(t) < 0) tracks.push(t); });
    var newSeq;
    status("Duplicating the sequence…", "", 0.02);
    return callHost("duplicateActive", [state.seq.sequenceID, " - PodDirector"]).then(function (r) {
      newSeq = r; log("Created " + r.name);
      var CHUNK = 250, steps = [];
      tracks.forEach(function (t) {
        for (var i = 0; i < payload.cutFrames.length; i += CHUNK) steps.push({ track: t, frames: payload.cutFrames.slice(i, i + CHUNK) });
      });
      var n = 0, razored = 0;
      return steps.reduce(function (p, st) {
        return p.then(function () {
          return callHost("razorTrack", [JSON.stringify({ sequenceID: newSeq.sequenceID, track: st.track, frames: st.frames })]).then(function (r) {
            razored += r.razored; n++;
            status("Cutting V" + (st.track + 1) + "… (" + Math.round(100 * n / steps.length) + "%)", "", 0.05 + 0.85 * n / steps.length);
          });
        });
      }, Promise.resolve()).then(function () {
        log("Razored " + razored + " edit points");
        status("Switching cameras…", "", 0.93);
        return callHost("applyEnables", [JSON.stringify({ sequenceID: newSeq.sequenceID, cameraTracks: tracks, shots: payload.shots })]);
      });
    }).then(function (r) {
      status("Done: “" + newSeq.name + "” has " + state.result.stats.cuts + " cuts (" + r.toggled + " clips switched). Your original is untouched.", "ok", 1);
    });
  });

  function exportForClaude() {
    if (!state.result || !hasNode) return;
    var down = 4; // 25 ms -> 100 ms
    var curves = {};
    state.config.speakers.forEach(function (s) {
      var c = state.curves[curveKey(s)]; if (!c) return;
      var out = [];
      for (var i = 0; i < c.length; i += down) { var m = -120; for (var k = i; k < Math.min(c.length, i + down); k++) m = Math.max(m, c[k]); out.push(Math.round(m)); }
      curves[s.id] = out;
    });
    var doc = {
      about: "PodDirector analysis export. Re-plan with: node cli/poddirector.js plan <this file> [--preset lively] [--set key=value]. " +
        "Edit `config` (speakers, cameras, preset, style, overrides) and import it back via Settings > Import settings.",
      exportedAt: new Date().toISOString(), engineVersion: D.VERSION,
      sequence: { name: state.seq.name, fps: state.seq.fps, durationSec: state.seq.durationSec },
      input: { durationSec: state.seq.durationSec, hopSec: HOP * down, fps: state.seq.fps, curves: curves },
      config: cleanConfig(state.config),
      result: { calibration: state.result.calibration, stats: state.result.stats, shots: state.result.shots },
      cleanup: state.tx.suggestions.length ? state.tx.suggestions : undefined
    };
    var file = path.join(state.docsDir, safe(state.seq.name) + ".poddirector.json");
    fs.writeFileSync(file, JSON.stringify(doc));
    status("Exported to " + file, "ok");
  }
  function cleanConfig(c) {
    var o = copy(c);
    o.speakers.forEach(function (s) { delete s._open; });
    return o;
  }
  function safe(n) { return String(n).replace(/[\\/:*?"<>|]+/g, "_").slice(0, 80); }

  function importSettings(file) {
    var r = new FileReader();
    r.onload = function () {
      try {
        var o = JSON.parse(r.result);
        var cfg = o.config || o;
        if (!cfg.speakers || !cfg.cameras) throw new Error("No speakers/cameras in that file.");
        state.config = cfg; saveConfig(); renderAll(); replan();
        status("Imported settings from " + file.name, "ok");
      } catch (e) { status("Import failed: " + e.message, "err"); }
    };
    r.readAsText(file);
  }

  // ------------------------------------------------------------ cleanup
  function renderCleanupControls() {
    var box = $("cleanupControls"); box.innerHTML = "";
    UI.cleanupControls.forEach(function (def) {
      box.appendChild(slider(def, state.cleanupOpts[def.key], function (v) {
        state.cleanupOpts[def.key] = v; store("cleanupOpts", state.cleanupOpts); debounce("clean", runCleanup, 150);
      }));
    });
  }

  function txCachePath() { return state.seq && hasNode ? path.join(state.docsDir, safe(state.seq.name) + ".transcript.json") : null; }
  function loadCachedTranscript() {
    var p = txCachePath();
    if (!p) return;
    try {
      var o = JSON.parse(fs.readFileSync(p, "utf8"));
      setSegments(o.segments, "Loaded saved transcript (" + o.segments.length + " lines, " + (o.source || "file") + ").");
    } catch (e) { $("txStatus").textContent = ""; }
  }
  function saveTranscript(segs, source) {
    var p = txCachePath();
    if (p) try { fs.writeFileSync(p, JSON.stringify({ source: source, savedAt: new Date().toISOString(), segments: segs })); } catch (e) { log(e.message); }
  }

  function setSegments(segs, msg) {
    state.tx.segments = segs; state.tx.off = {}; state.tx.nudges = {};
    $("txStatus").textContent = msg || "";
    runCleanup();
  }

  function speakerRunsByName() {
    if (!state.result) return null;
    var names = {}; state.config.speakers.forEach(function (s) { names[s.id] = s.name; });
    return state.result.speech.map(function (r) { return { speakerId: names[r.speakerId] || r.speakerId, runs: r.runs }; });
  }

  function runCleanup() {
    if (!state.tx.segments) return;
    var segs = T.assignSpeakers(state.tx.segments, speakerRunsByName());
    var res = T.analyze(segs, state.cleanupOpts);
    state.tx.suggestions = res.suggestions;
    renderSuggestions(); refreshVizCleanup(); setButtons();
  }

  function sugRange(s) {
    var n = state.tx.nudges[s.id] || [0, 0];
    return [Math.max(0, s.startSec + n[0]), Math.max(s.startSec + n[0] + 0.1, s.endSec + n[1])];
  }
  function acceptedCuts() {
    return state.tx.suggestions.filter(function (s) { return !state.tx.off[s.id]; }).map(function (s) {
      var r = sugRange(s); return { startSec: r[0], endSec: r[1] };
    });
  }
  function refreshVizCleanup() { if (viz.data) { viz.data.cleanup = acceptedCuts(); viz.render(); } }

  function renderSuggestions() {
    var box = $("sugList"); box.innerHTML = "";
    var list = state.tx.suggestions;
    var on = list.filter(function (s) { return !state.tx.off[s.id]; });
    var secs = on.reduce(function (a, s) { var r = sugRange(s); return a + r[1] - r[0]; }, 0);
    $("sugCount").textContent = list.length ? on.length + " of " + list.length + " selected · " + secs.toFixed(0) + " s" : "";
    if (!list.length) { box.appendChild(el("div", { class: "muted", text: state.tx.segments ? "Nothing flagged. Lower Min confidence to see weaker matches." : "No transcript loaded." })); return; }
    list.forEach(function (s) {
      var r = sugRange(s);
      var conf = s.confidence >= 0.75 ? "" : s.confidence >= 0.55 ? " mid" : " low";
      var item = el("div", { class: "sug" + (state.tx.off[s.id] ? " off" : ""), onclick: function (e) {
        if (e.target.tagName === "INPUT" || e.target.tagName === "BUTTON") return;
        seek(r[0]);
      } });
      var box2 = el("input", { type: "checkbox" }); box2.checked = !state.tx.off[s.id];
      box2.addEventListener("change", function () { state.tx.off[s.id] = !box2.checked; renderSuggestions(); refreshVizCleanup(); setButtons(); });
      function nudge(which, d) {
        return el("button", { class: "btn ghost", text: (which === 0 ? "←" : "") + (d < 0 ? "−" : "+") + (which === 1 ? "→" : ""),
          title: (which === 0 ? "Start " : "End ") + (d < 0 ? "earlier" : "later") + " by 0.5 s",
          onclick: function () { var n = state.tx.nudges[s.id] || [0, 0]; n[which] += d; state.tx.nudges[s.id] = n; renderSuggestions(); refreshVizCleanup(); } });
      }
      item.appendChild(el("div", { class: "sug-top" }, [
        box2,
        el("span", { class: "time", text: fmt(r[0]) + " – " + fmt(r[1]) }),
        el("span", { class: "badge" + conf, text: s.type + " " + Math.round(s.confidence * 100) + "%" }),
        el("span", { class: "sug-nudge" }, [nudge(0, -0.5), nudge(0, 0.5), nudge(1, -0.5), nudge(1, 0.5)])
      ]));
      item.appendChild(el("div", { class: "small", text: s.reason }));
      item.appendChild(el("div", { class: "sug-text", text: s.text }));
      box.appendChild(item);
    });
  }

  var transcribe = guard(function () {
    if (!state.seq) throw new Error("Scan a sequence first.");
    if (!inPremiere) { setSegments(window.PD_DEMO.transcript(), "Demo transcript loaded."); return; }
    if (!state.tools.ffmpeg) throw new Error("ffmpeg is not available. See Settings.");
    if (!state.tools.whisper) throw new Error("The bundled transcriber was not found. See Settings.");
    var spk = state.config.speakers.filter(function (s) { return s.enabled !== false; });
    var tracks = spk.length ? spk.map(function (s) { return { t: s.audioTrack, ch: s.channel }; })
      : state.seq.audioTracks.filter(function (a) { return !a.muted; }).map(function (a) { return { t: a.index, ch: null }; });
    var clips = [];
    tracks.forEach(function (x) { state.seq.audioTracks[x.t].clips.forEach(function (c) { var cc = copy(c); cc.channel = x.ch; clips.push(cc); }); });
    var t0 = Date.now();
    log("Transcribing " + clips.length + " clips with " + path.basename(state.tools.whisper.model));
    return W.transcribeTimeline({
      ffmpegPath: state.tools.ffmpeg, clips: clips, durationSec: state.seq.durationSec, prompt: $("txPrompt").value.trim(),
      onProgress: function (stage, f) {
        if (stage === "mix") status("Preparing audio for transcription… " + Math.round(f * 100) + "%", "", 0.15 * f);
        else status("Transcribing offline… " + Math.round(f * 100) + "% (" + Math.round((Date.now() - t0) / 1000) + " s)", "", 0.15 + 0.85 * f);
      }
    }).then(function (segs) {
      saveTranscript(segs, "whisper");
      setSegments(segs, "Transcribed " + segs.length + " lines in " + Math.round((Date.now() - t0) / 1000) + " s.");
      status("Transcript ready — " + state.tx.suggestions.length + " suggested cuts.", "ok", 1);
    });
  });

  function loadTranscriptFile(file) {
    var r = new FileReader();
    r.onload = function () {
      try {
        var segs = T.parse(r.result, { fps: state.seq ? state.seq.fps : 30 });
        if (!segs.length) throw new Error("No timecoded lines found.");
        saveTranscript(segs, file.name);
        setSegments(segs, "Loaded " + file.name + " (" + segs.length + " lines).");
        status(state.tx.suggestions.length + " suggested cuts.", "ok");
      } catch (e) { status("Could not read transcript: " + e.message, "err"); }
    };
    r.readAsText(file);
  }

  var markCuts = guard(function () {
    var list = state.tx.suggestions.filter(function (s) { return !state.tx.off[s.id]; });
    var markers = list.map(function (s) {
      var r = sugRange(s);
      return { startSec: r[0], endSec: r[1], name: s.type, color: 1, comment: s.reason + "\n" + s.text };
    });
    return callHost("clearMarkers", [MARK_CUT]).then(function () {
      return callHost("addMarkers", [JSON.stringify({ prefix: MARK_CUT, markers: markers })]);
    }).then(function (r) { status("Marked " + r.added + " sections in red. Review them, then lift/ripple-delete the ones you agree with.", "ok", 1); });
  });
  var clearCuts = guard(function () {
    return callHost("clearMarkers", [MARK_CUT]).then(function (r) { status("Removed " + r.removed + " cleanup markers.", "ok"); });
  });

  function exportCsv() {
    var list = state.tx.suggestions.filter(function (s) { return !state.tx.off[s.id]; }).map(function (s) {
      var r = sugRange(s); var c = copy(s); c.startSec = r[0]; c.endSec = r[1]; return c;
    });
    var file = path.join(state.docsDir, safe(state.seq ? state.seq.name : "transcript") + ".cuts.csv");
    fs.writeFileSync(file, T.toCsv(list));
    status("Saved " + file, "ok");
  }

  function copyForClaude() {
    var lines = ["I'm editing a podcast in Premiere. Below are sections an automatic analyzer flagged for removal",
      "(spoken edit cues, restarts, off-the-record talk). For each, tell me: keep or cut, and adjust the start/end",
      "if the cut should begin or end elsewhere so the edit sounds natural. Then list any other spots in the transcript",
      "that sound like they were meant to be cut.", "", "FLAGGED:"];
    state.tx.suggestions.forEach(function (s) {
      var r = sugRange(s);
      lines.push("- " + s.id + " [" + fmt(r[0]) + " – " + fmt(r[1]) + "] " + s.type + " (" + Math.round(s.confidence * 100) + "%): " + s.reason);
    });
    lines.push("", "TRANSCRIPT:");
    T.assignSpeakers(state.tx.segments, speakerRunsByName()).forEach(function (sg) {
      lines.push("[" + fmt(sg.startSec) + "] " + (sg.speaker ? sg.speaker + ": " : "") + sg.text);
    });
    var text = lines.join("\n");
    var ta = el("textarea"); ta.value = text; document.body.appendChild(ta); ta.select();
    var ok = false; try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
    ta.remove();
    if (hasNode) {
      var file = path.join(state.docsDir, safe(state.seq ? state.seq.name : "transcript") + ".claude-review.txt");
      fs.writeFileSync(file, text);
      status((ok ? "Copied to clipboard and saved " : "Saved ") + file, "ok");
    } else status(ok ? "Copied to clipboard." : "Copy failed.", ok ? "ok" : "err");
  }

  // ------------------------------------------------------------ wiring
  function setButtons() {
    var has = !!state.result, b = state.busy;
    $("btnScan").disabled = b;
    $("btnAnalyze").disabled = b || !state.seq;
    $("btnMarkers").disabled = b || !has || !inPremiere;
    $("btnApply").disabled = b || !has || !inPremiere;
    $("btnClearMarkers").disabled = b || !inPremiere;
    $("btnExportPlan").disabled = b || !has || !hasNode;
    var sel = state.tx.suggestions.some(function (s) { return !state.tx.off[s.id]; });
    $("btnTranscribe").disabled = b || !state.seq;
    $("btnSugMarkers").disabled = b || !sel || !inPremiere;
    $("btnSugClear").disabled = b || !inPremiere;
    $("btnSugCsv").disabled = !sel || !hasNode;
    $("btnSugClaude").disabled = !state.tx.segments;
  }

  var viz = new window.PDViz($("viz"), $("vizScroll"));
  viz.onSeek = seek;
  viz.onSelect = onSelect;
  $("zoomIn").onclick = function () { viz.zoom(0.5); };
  $("zoomOut").onclick = function () { viz.zoom(2); };
  $("zoomFit").onclick = function () { viz.fit(); };
  $("lockClear").onclick = clearSelection;
  $("btnScan").onclick = scan;
  $("btnAnalyze").onclick = analyze;
  $("btnMarkers").onclick = previewMarkers;
  $("btnClearMarkers").onclick = clearCamMarkers;
  // Two-step confirm inside the panel (native dialogs are unreliable in CEP).
  var armed = null;
  $("btnApply").onclick = function () {
    var b = $("btnApply");
    if (!armed) {
      b.textContent = "Click again to build on a copy";
      status("This duplicates “" + state.seq.name + "” and cuts the copy. Your original stays untouched.", "");
      armed = setTimeout(function () { armed = null; b.textContent = "Build cut on a copy"; }, 4000);
      return;
    }
    clearTimeout(armed); armed = null; b.textContent = "Build cut on a copy";
    applyCut();
  };
  $("btnExportPlan").onclick = exportForClaude;
  $("btnSavePreset").onclick = savePreset;
  $("btnAddSpeaker").onclick = function () {
    if (!state.seq) return;
    var n = state.config.speakers.length + 1, id = "S" + Date.now().toString(36);
    state.config.speakers.push({ id: id, name: "Speaker " + n, audioTrack: 0, channel: null, thresholdDb: null, biasDb: 0, minShotSec: null, interjections: true, reactionShots: true, enabled: true, _open: true });
    renderAll(); changed();
  };
  $("btnAddCamera").onclick = function () {
    if (!state.seq) return;
    state.config.cameras.push({ id: "C" + Date.now().toString(36), name: "Camera " + (state.config.cameras.length + 1), videoTrack: 0, shows: [], enabled: true });
    renderCameras(); changed();
  };
  $("btnTranscribe").onclick = transcribe;
  $("txFile").onchange = function () { if (this.files[0]) loadTranscriptFile(this.files[0]); this.value = ""; };
  $("sugAll").onclick = function () { state.tx.off = {}; renderSuggestions(); refreshVizCleanup(); setButtons(); };
  $("sugNone").onclick = function () { state.tx.suggestions.forEach(function (s) { state.tx.off[s.id] = true; }); renderSuggestions(); refreshVizCleanup(); setButtons(); };
  $("btnSugMarkers").onclick = markCuts;
  $("btnSugClear").onclick = clearCuts;
  $("btnSugCsv").onclick = exportCsv;
  $("btnSugClaude").onclick = copyForClaude;
  $("btnRecheck").onclick = function () {
    store("ffmpegCustom", $("ffmpegCustom").value.trim()); store("modelCustom", $("modelCustom").value.trim());
    checkTools().then(function () { status("Tools re-checked.", "ok"); });
  };
  $("txPrompt").onchange = function () { store("txPrompt", $("txPrompt").value.trim()); };
  $("btnClearCache").onclick = function () { var n = A.clearCache(); state.curves = {}; replan(); status("Cleared " + n + " cached waveforms.", "ok"); };
  $("btnOpenDocs").onclick = function () {
    if (!hasNode) return;
    var cmd = process.platform === "win32" ? "explorer" : "open";
    require("child_process").spawn(cmd, [state.docsDir], { detached: true });
  };
  $("importFile").onchange = function () { if (this.files[0]) importSettings(this.files[0]); this.value = ""; };

  // Follow Premiere's playhead while the panel is idle.
  setInterval(function () {
    if (!inPremiere || state.busy || !state.result || document.hidden) return;
    callHost("getPlayhead").then(function (r) {
      if (state.seq && r.sequenceID === state.seq.sequenceID && Math.abs((viz.playhead || -1) - r.sec) > 0.05) viz.setPlayhead(r.sec);
    }).catch(function () { /* sequence closed */ });
  }, 500);

  init();
})();
