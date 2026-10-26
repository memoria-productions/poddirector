/*
 * PodDirector — multicam cutting engine.
 *
 * Pure JavaScript, no dependencies. Runs in the Premiere CEP panel, in Node
 * (CLI + tests) and anywhere else. Given one loudness curve (dB over time) per
 * speaker microphone and a description of which camera shows whom, it decides
 * which camera is on screen at every moment.
 *
 * Pipeline
 *   1. calibrate     per-mic noise floor / speech level -> auto threshold
 *   2. detect        per-frame "is talking", with bleed rejection
 *   3. smooth        hold (bridge word gaps) + attack (ignore clicks/coughs)
 *   4. classify      speech runs -> turns vs interjections
 *   5. floor model   who has the floor: solo / crosstalk / silence segments
 *   6. shots         segment -> camera (close-up rotation, wides, two-shots)
 *   7. interjections reaction shots of the person who laughed / said "yeah"
 *   8. cutaways      break up long monologues at the quietest breath
 *   9. timing        cut early (anticipate) or late (react), opening wide
 *  10. cleanup       minimum shot length, manual locks, frame snapping
 *
 * Ideas for steps 1, 8 and 10 are adapted from Cutcast (MIT, BoazCohenJ);
 * camera "shows" tagging is adapted from Podclip (MIT, Podclip contributors).
 */
(function (root, factory) {
  // CEP panels with Node enabled define both window and module: export to both.
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (typeof window !== "undefined") window.PodDirector = api;
  else if (root) root.PodDirector = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var SILENT_DB = -120;

  // ---------------------------------------------------------------- presets

  var DEFAULT_STYLE = {
    // Detection
    sensitivity: 0.5,          // 0..1, higher = quieter speech counts (auto thresholds)
    crosstalkWindowDb: 6,      // mics within this many dB of the loudest both count; further below = bleed
    attackSec: 0.2,            // speech must last this long to register (ignores clicks, coughs)
    holdSec: 0.6,              // bridge gaps between words shorter than this
    // Switching
    reactionDelaySec: 0.4,     // a new speaker must hold the floor this long before we switch
    cutTimingSec: -0.12,       // where the cut lands vs speech onset: negative = before (anticipate)
    minShotSec: 2.0,           // shortest shot allowed (absorbed into neighbours otherwise)
    // Group / wide behaviour
    crosstalkMode: "wide",     // "wide" | "loudest" | "hold"
    crosstalkMinSec: 1.0,      // overlap must last this long before it counts as crosstalk
    wideAfterSilenceSec: 3.0,  // go wide after this much silence (0 = never)
    openOnWideSec: 3.0,        // open the show on the wide for this long (0 = off)
    // Interjections ("yeah", laughs, quick questions)
    interjectionMaxSec: 1.2,   // speech bursts shorter than this, over someone else, are interjections
    interjectionMode: "reaction", // "ignore" | "reaction" | "wide"
    interjectionChance: 0.6,   // 0..1 share of eligible interjections that get a shot
    reactionShotSec: 1.6,      // length of a reaction shot
    // Long monologues
    maxShotSec: 18,            // break a single shot longer than this (0 = never)
    cutawayMode: "mix",        // "wide" | "reaction" | "alternate" | "mix"
    cutawaySec: 3.0,           // cutaway length
    // Angles
    angleVariety: "rotate",    // "first" | "rotate" | "random"  (speakers with several close-ups)
    // Moving cameras (dolly, slider, handheld, operated cams) — needs camera motion analysis
    steadyMaxPct: 1.2,         // below this much camera motion (% of frame width per second) = steady
    fastMinPct: 6,             // above this = a real move/reposition; never on air
    settleSec: 0.6,            // camera must have been steady this long before we cut to it
    maxWaitSec: 1.5,           // hold the previous shot up to this long waiting for the camera to settle
    slowMovesOnAir: true,      // once on the shot, gentle moves (push-ins, drifts) may stay on air
    movePadSec: 0.2,           // leave a move this early / come back this late
    // Misc
    seed: 7,
    snapToFrames: true
  };

  var PRESETS = {
    calm: {
      label: "Calm (interview / long-form)",
      style: { reactionDelaySec: 0.8, minShotSec: 3.5, crosstalkMinSec: 1.6, wideAfterSilenceSec: 4,
               interjectionMode: "ignore", interjectionChance: 0.3, maxShotSec: 30, cutawayMode: "wide",
               cutawaySec: 4, cutTimingSec: -0.05, holdSec: 0.9 }
    },
    balanced: { label: "Balanced (default)", style: {} },
    lively: {
      label: "Lively (banter / comedy)",
      style: { reactionDelaySec: 0.25, minShotSec: 1.4, crosstalkMinSec: 0.7, wideAfterSilenceSec: 2,
               interjectionMode: "reaction", interjectionChance: 0.85, reactionShotSec: 1.3, maxShotSec: 12,
               cutawayMode: "mix", cutawaySec: 2.4, cutTimingSec: -0.15, holdSec: 0.45 }
    },
    social: {
      label: "Social clips (fast)",
      style: { reactionDelaySec: 0.15, minShotSec: 1.0, crosstalkMinSec: 0.6, wideAfterSilenceSec: 1.5,
               openOnWideSec: 0, interjectionMode: "reaction", interjectionChance: 1, reactionShotSec: 1.0,
               maxShotSec: 7, cutawayMode: "alternate", cutawaySec: 2, cutTimingSec: -0.18, holdSec: 0.35 }
    },
    hostFocus: {
      label: "Host focus (stay on speaker, few cutaways)",
      style: { reactionDelaySec: 0.6, minShotSec: 2.5, crosstalkMode: "loudest", wideAfterSilenceSec: 0,
               interjectionMode: "ignore", maxShotSec: 0, openOnWideSec: 2 }
    },
    solo: {
      label: "1 subject (solo host / monologue)",
      style: { reactionDelaySec: 0.6, minShotSec: 3, crosstalkMode: "hold", wideAfterSilenceSec: 0, interjectionMode: "ignore",
               maxShotSec: 20, cutawayMode: "mix", cutawaySec: 4, openOnWideSec: 3 }
    },
    trio: {
      label: "3 subjects",
      style: { reactionDelaySec: 0.35, minShotSec: 1.8, crosstalkMinSec: 0.9, interjectionChance: 0.5, maxShotSec: 16,
               wideAfterSilenceSec: 3 }
    },
    panel: {
      label: "4+ subjects (panel / roundtable)",
      style: { reactionDelaySec: 0.35, minShotSec: 1.8, crosstalkMinSec: 0.7, wideAfterSilenceSec: 2.5, interjectionChance: 0.4,
               maxShotSec: 15, cutawayMode: "wide", openOnWideSec: 4 }
    }
  };
  /** Style preset that suits a given number of people on mic. */
  function presetForSubjects(n) { return n <= 1 ? "solo" : n === 2 ? "balanced" : n === 3 ? "trio" : "panel"; }

  var DEFAULT_SPEAKER = {
    thresholdDb: null,      // null = auto-calibrate
    biasDb: 0,              // priority: positive wins close calls, negative yields
    minShotSec: null,       // override global minimum for this speaker's shots
    interjections: true,    // can this speaker's "yeah"/laughs trigger reaction shots
    reactionShots: true,    // may be shown listening (cutaways / reactions)
    enabled: true           // false = ignore this mic entirely
  };

  function merge(base) {
    var out = {};
    for (var i = 0; i < arguments.length; i++) {
      var src = arguments[i];
      if (!src) continue;
      for (var k in src) if (Object.prototype.hasOwnProperty.call(src, k) && src[k] !== undefined) out[k] = src[k];
    }
    return out;
  }

  function styleFromPreset(name, overrides) {
    var preset = PRESETS[name] || PRESETS.balanced;
    return merge(DEFAULT_STYLE, preset.style, overrides);
  }

  // ------------------------------------------------------------------ utils

  function percentile(values, p) {
    if (!values.length) return SILENT_DB;
    var sorted = values.slice().sort(function (a, b) { return a - b; });
    return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(p * sorted.length)))];
  }

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  // Small deterministic RNG (mulberry32) so the same settings give the same cut.
  function rng(seed) {
    var a = (seed >>> 0) || 1;
    return function () {
      a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function sameSet(a, b) {
    if (a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) if (b.indexOf(a[i]) < 0) return false;
    return true;
  }
  function isSuperset(big, small) {
    for (var i = 0; i < small.length; i++) if (big.indexOf(small[i]) < 0) return false;
    return true;
  }

  // ------------------------------------------------------ 1. calibration

  function calibrate(curves, speakers, style) {
    var stats = speakers.map(function (sp) {
      var c = curves[sp.id] || [];
      var valid = [];
      // Subsample long curves for speed; percentiles don't need every frame.
      var stride = Math.max(1, Math.floor(c.length / 40000));
      for (var i = 0; i < c.length; i += stride) if (c[i] > -100) valid.push(c[i]);
      return { floor: percentile(valid, 0.10), speech: percentile(valid, 0.98), coverage: valid.length };
    });
    var loudest = -Infinity;
    stats.forEach(function (s) { if (s.coverage && s.speech > loudest) loudest = s.speech; });
    var sens = clamp(style.sensitivity, 0, 1);
    return speakers.map(function (sp, i) {
      var s = stats[i];
      // A mic that only ever hears the others would otherwise treat bleed as its speech level.
      var reference = Math.max(s.speech, loudest - 10);
      var range = Math.max(12, reference - s.floor);
      var auto = s.floor + range * (0.6 - 0.4 * sens);
      var threshold = (sp.thresholdDb === null || sp.thresholdDb === undefined || sp.thresholdDb === "auto")
        ? auto : Number(sp.thresholdDb);
      return {
        id: sp.id, floorDb: round1(s.floor), speechDb: round1(s.speech), referenceDb: round1(reference),
        autoThresholdDb: round1(auto), thresholdDb: round1(threshold)
      };
    });
  }
  function round1(v) { return Math.round(v * 10) / 10; }
  function round3(v) { return Math.round(v * 1000) / 1000; }

  // ------------------------------------------------- 2+3. detect + smooth

  function detectActivity(curves, speakers, cal, style, frames) {
    var n = speakers.length;
    var raw = speakers.map(function () { return new Uint8Array(frames); });
    var rel = new Float32Array(n);
    var above = new Uint8Array(n);
    for (var t = 0; t < frames; t++) {
      var loudestRel = -Infinity;
      for (var s = 0; s < n; s++) {
        var c = curves[speakers[s].id];
        var db = c && t < c.length ? c[t] : SILENT_DB;
        above[s] = db > cal[s].thresholdDb ? 1 : 0;
        rel[s] = db - cal[s].referenceDb + (speakers[s].biasDb || 0);
        if (above[s] && rel[s] > loudestRel) loudestRel = rel[s];
      }
      for (s = 0; s < n; s++) {
        if (above[s] && rel[s] >= loudestRel - style.crosstalkWindowDb) raw[s][t] = 1;
      }
    }
    return raw;
  }

  /** Fill gaps <= maxGap frames, then drop runs < minRun frames. Returns runs [[start,end), ...]. */
  function smoothRuns(active, maxGap, minRun) {
    var runs = [];
    var start = -1;
    for (var t = 0; t <= active.length; t++) {
      var on = t < active.length && active[t] === 1;
      if (on && start < 0) start = t;
      if (!on && start >= 0) { runs.push([start, t]); start = -1; }
    }
    var bridged = [];
    for (var i = 0; i < runs.length; i++) {
      var last = bridged[bridged.length - 1];
      if (last && runs[i][0] - last[1] <= maxGap) last[1] = runs[i][1];
      else bridged.push([runs[i][0], runs[i][1]]);
    }
    return bridged.filter(function (r) { return r[1] - r[0] >= minRun; });
  }

  // ---------------------------------------------------- 4. classify runs

  function classifyRuns(runsBySpeaker, speakers, style, fr) {
    var maxInterj = Math.round(style.interjectionMaxSec * fr);
    var near = Math.round(Math.max(style.holdSec, 0.5) * fr);
    // A run is an interjection if it's short and someone else is talking around it.
    function othersTalking(si, a, b) {
      for (var o = 0; o < runsBySpeaker.length; o++) {
        if (o === si) continue;
        var rs = runsBySpeaker[o];
        for (var k = 0; k < rs.length; k++) {
          var r = rs[k];
          if (r[1] - r[0] <= maxInterj) continue; // another short burst doesn't hold the floor
          if (r[0] <= a + near && r[1] >= b - near) return true;
        }
      }
      return false;
    }
    var main = [], interj = [];
    runsBySpeaker.forEach(function (runs, si) {
      main.push([]);
      runs.forEach(function (r) {
        if (r[1] - r[0] <= maxInterj && othersTalking(si, r[0], r[1])) {
          interj.push({ speaker: si, start: r[0], end: r[1] });
        } else {
          main[si].push(r);
        }
      });
    });
    interj.sort(function (a, b) { return a.start - b.start; });
    return { main: main, interjections: interj };
  }

  // ------------------------------------------------------ 5. floor model

  function floorSegments(mainRuns, speakers, style, fr, frames) {
    var n = speakers.length;
    // Per-frame active set (bitmask) from the main runs.
    var mask = new Uint32Array(frames);
    for (var s = 0; s < n; s++) {
      mainRuns[s].forEach(function (r) {
        for (var t = r[0]; t < Math.min(r[1], frames); t++) mask[t] |= (1 << s);
      });
    }
    // Run-length encode.
    var segs = [];
    var cur = -1, start = 0;
    for (var t = 0; t <= frames; t++) {
      var m = t < frames ? mask[t] : -2;
      if (m !== cur) {
        if (t > 0) segs.push({ start: start, end: t, mask: cur });
        cur = m; start = t;
      }
    }
    segs.forEach(function (sg) {
      sg.speakers = [];
      for (var s2 = 0; s2 < n; s2++) if (sg.mask & (1 << s2)) sg.speakers.push(s2);
      sg.kind = sg.speakers.length === 0 ? "silence" : (sg.speakers.length === 1 ? "solo" : "group");
      sg.onset = true;
    });

    // Short overlaps are not crosstalk: give them to whoever already had the floor.
    var minX = Math.round(style.crosstalkMinSec * fr);
    for (var i = 0; i < segs.length; i++) {
      var g = segs[i];
      if (g.kind !== "group" || g.end - g.start >= minX) continue;
      var prev = segs[i - 1], next = segs[i + 1];
      var holder = null;
      if (prev && prev.kind === "solo" && g.speakers.indexOf(prev.speakers[0]) >= 0) holder = prev.speakers[0];
      else if (next && next.kind === "solo" && g.speakers.indexOf(next.speakers[0]) >= 0) holder = next.speakers[0];
      else holder = g.speakers[0];
      g.kind = "solo"; g.speakers = [holder];
    }
    segs = mergeSegs(segs);

    // Silence: hold the shot, or go wide once it has lasted wideAfterSilenceSec.
    var wideAfter = Math.round(style.wideAfterSilenceSec * fr);
    var minShot = Math.round(style.minShotSec * fr);
    var out = [];
    segs.forEach(function (sg, idx) {
      if (sg.kind !== "silence") { out.push(sg); return; }
      var isLeading = idx === 0;
      if (wideAfter > 0 && sg.end - sg.start > wideAfter && !isLeading) {
        // Start the wide early enough that it survives the minimum shot length.
        var wideStart = sg.start + wideAfter;
        if (sg.end - wideStart < minShot) wideStart = Math.max(sg.start + Math.round(0.5 * fr), sg.end - minShot);
        out.push({ start: sg.start, end: wideStart, kind: "hold", speakers: [], onset: false });
        out.push({ start: wideStart, end: sg.end, kind: "pause", speakers: [], onset: false });
      } else {
        out.push({ start: sg.start, end: sg.end, kind: isLeading ? "pause" : "hold", speakers: [], onset: false });
      }
    });
    segs = mergeSegs(out);

    // Reaction delay: a speaker change that doesn't last long enough isn't a switch.
    var delay = Math.round(style.reactionDelaySec * fr);
    for (i = 1; i < segs.length; i++) {
      var sgm = segs[i];
      if (sgm.kind === "solo" && sgm.end - sgm.start < delay) {
        // keep only if the speaker keeps talking after a brief hold (handled by merge)
        var after = segs[i + 1];
        var continues = after && after.kind === "hold" && segs[i + 2] && segs[i + 2].kind === "solo" &&
          segs[i + 2].speakers[0] === sgm.speakers[0];
        if (!continues) { sgm.kind = "hold"; sgm.speakers = []; sgm.onset = false; }
      }
    }
    return mergeSegs(segs);
  }

  function segKey(sg) { return sg.kind + ":" + sg.speakers.join(","); }
  function mergeSegs(segs) {
    var out = [];
    segs.forEach(function (sg) {
      if (sg.end <= sg.start) return;
      var last = out[out.length - 1];
      if (last && segKey(last) === segKey(sg) && last.end === sg.start) last.end = sg.end;
      else out.push({ start: sg.start, end: sg.end, kind: sg.kind, speakers: sg.speakers.slice(), onset: sg.onset });
    });
    return out;
  }

  // ------------------------------------------------------- 6. cameras

  function cameraIndex(cameras, speakers) {
    var ids = speakers.map(function (s) { return s.id; });
    var cams = cameras.filter(function (c) { return c.enabled !== false; }).map(function (c) {
      var shows = (c.shows || []).map(function (id) { return ids.indexOf(id); }).filter(function (x) { return x >= 0; });
      return { cam: c, shows: shows };
    });
    // "Follow" cams (an operator re-frames on whoever is talking) count as a close-up of every speaker,
    // but never as a group shot and never as a listener/reaction shot.
    var fixed = cams.filter(function (c) { return !c.cam.follows; });
    var follow = cams.filter(function (c) { return c.cam.follows; });
    var widest = null;
    (fixed.length ? fixed : cams).forEach(function (c) { if (!widest || c.shows.length > widest.shows.length) widest = c; });
    function fixedCloseups(si) {
      return fixed.filter(function (c) { return c.shows.length === 1 && c.shows[0] === si; }).map(function (c) { return c.cam.id; });
    }
    return {
      list: cams,
      widest: widest ? widest.cam.id : null,
      hasWide: !!(widest && widest.shows.length > 1),
      isFollow: function (id) { return follow.some(function (c) { return c.cam.id === id; }); },
      fixedCloseups: fixedCloseups,
      closeups: function (si) {
        return fixedCloseups(si).concat(follow.map(function (c) { return c.cam.id; }));
      },
      cover: function (set) {
        if (set.length === 1 && follow.length && !fixedCloseups(set[0]).length) {
          var direct = fixed.filter(function (c) { return sameSet(c.shows, set); });
          if (!direct.length) return follow[0].cam.id;
        }
        var best = null;
        fixed.forEach(function (c) {
          if (sameSet(c.shows, set)) { if (!best || best.exact !== true) best = { id: c.cam.id, size: c.shows.length, exact: true }; return; }
          if (isSuperset(c.shows, set) && (!best || (!best.exact && c.shows.length < best.size))) best = { id: c.cam.id, size: c.shows.length };
        });
        return best ? best.id : null;
      }
    };
  }

  function buildShots(segs, speakers, cameras, style, ctx) {
    var ci = cameraIndex(cameras, speakers);
    var rand = ctx.rand;
    var rotation = {};
    var current = null;
    var shots = [];

    function closeupFor(si, avoid) {
      var list = ci.closeups(si);
      if (!list.length) return ci.cover([si]);
      if (list.length === 1 || style.angleVariety === "first") return list[0];
      if (style.angleVariety === "random") {
        var pool = list.filter(function (id) { return id !== avoid; });
        return pool[Math.floor(rand() * pool.length)] || list[0];
      }
      rotation[si] = ((rotation[si] === undefined ? -1 : rotation[si]) + 1) % list.length;
      return list[rotation[si]];
    }

    segs.forEach(function (sg) {
      var cam = null, reason = sg.kind;
      if (sg.kind === "solo") {
        var si = sg.speakers[0];
        var already = current && current.speakers && current.speakers.length === 1 && current.speakers[0] === si;
        cam = already ? current.cameraId : closeupFor(si, current && current.cameraId);
        reason = "speaker";
      } else if (sg.kind === "group") {
        reason = "crosstalk";
        if (style.crosstalkMode === "wide") cam = ci.cover(sg.speakers) || ci.widest;
        else if (style.crosstalkMode === "loudest") {
          var loud = loudestOver(ctx, sg.speakers, sg.start, sg.end);
          cam = (current && current.speakers && current.speakers.length === 1 && current.speakers[0] === loud)
            ? current.cameraId : closeupFor(loud);
        } else cam = current ? current.cameraId : ci.cover(sg.speakers);
      } else if (sg.kind === "pause") {
        reason = "pause";
        cam = ci.hasWide ? ci.widest : (current ? current.cameraId : ci.widest);
      } else { // hold
        reason = current ? current.reason : "pause";
        cam = current ? current.cameraId : ci.widest;
      }
      if (!cam) cam = current ? current.cameraId : ci.widest;
      var shot = { start: sg.start, end: sg.end, cameraId: cam, reason: reason,
                   speakers: sg.kind === "hold" && current ? current.speakers : sg.speakers.slice(),
                   onset: sg.onset && sg.kind !== "hold" };
      if (sg.kind === "hold" && current) shot.reason = current.reason;
      shots.push(shot);
      current = shot;
    });
    return { shots: mergeShots(shots), ci: ci };
  }

  function loudestOver(ctx, set, a, b) {
    var best = set[0], bestV = -Infinity;
    set.forEach(function (si) {
      var c = ctx.curves[ctx.speakers[si].id] || [];
      var sum = 0, n = 0;
      for (var t = a; t < b && t < c.length; t++) { sum += c[t] - ctx.cal[si].referenceDb; n++; }
      var v = (n ? sum / n : -Infinity) + (ctx.speakers[si].biasDb || 0);
      if (v > bestV) { bestV = v; best = si; }
    });
    return best;
  }

  function mergeShots(shots) {
    var out = [];
    shots.forEach(function (s) {
      if (s.end <= s.start) return;
      var last = out[out.length - 1];
      if (last && last.cameraId === s.cameraId && last.end === s.start && !last.locked && !s.locked) {
        last.end = s.end;
        // A shot that opens on a breath or overlap but settles on one speaker is a speaker shot.
        if ((last.reason === "pause" || last.reason === "hold" || last.reason === "crosstalk") && s.reason === "speaker") {
          last.reason = s.reason; last.speakers = s.speakers.slice();
        } else if (last.reason === "speaker" && s.reason === "speaker") {
          // e.g. a follow cam that stays up across a change of speaker
          (s.speakers || []).forEach(function (x) { if (last.speakers.indexOf(x) < 0) last.speakers.push(x); });
        }
      } else out.push(copyShot(s));
    });
    return out;
  }
  function copyShot(s) {
    return { start: s.start, end: s.end, cameraId: s.cameraId, reason: s.reason,
             speakers: (s.speakers || []).slice(), onset: !!s.onset, locked: !!s.locked, keepShort: !!s.keepShort };
  }

  /** Replace [a,b) with a new shot, splitting whatever was there. */
  function insertShot(shots, ins) {
    var out = [];
    shots.forEach(function (s) {
      if (s.end <= ins.start || s.start >= ins.end) { out.push(s); return; }
      if (s.start < ins.start) { var l = copyShot(s); l.end = ins.start; out.push(l); }
      if (s.end > ins.end) { var r = copyShot(s); r.start = ins.end; r.onset = false; out.push(r); }
    });
    out.push(ins);
    out.sort(function (x, y) { return x.start - y.start; });
    return out;
  }

  function shotAt(shots, t) {
    var lo = 0, hi = shots.length - 1;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (shots[mid].end <= t) lo = mid + 1;
      else if (shots[mid].start > t) hi = mid - 1;
      else return shots[mid];
    }
    return null;
  }

  // ---------------------------------------------------- 7. interjections

  function applyInterjections(shots, interj, speakers, style, ctx) {
    if (style.interjectionMode === "ignore") return shots;
    var fr = ctx.fr;
    var len = Math.round(style.reactionShotSec * fr);
    var lead = Math.round(0.15 * fr);
    var lastEnd = -Infinity;
    interj.forEach(function (ij) {
      var sp = speakers[ij.speaker];
      if (!sp.interjections) return;
      if (ctx.rand() > style.interjectionChance) return;
      var host = shotAt(shots, ij.start);
      if (!host || host.locked || host.reason === "crosstalk" || host.reason === "pause") return;
      if (host.speakers.length === 1 && host.speakers[0] === ij.speaker) return; // already on them
      var a = Math.max(ij.start - lead, host.start);
      var b = Math.min(Math.max(ij.end + lead, a + len), host.end);
      if (a < lastEnd + Math.round(style.minShotSec * fr)) return; // don't stack reactions
      // Leave room so the host shot survives on both sides.
      var room = Math.round(Math.min(style.minShotSec, 1.0) * fr);
      if (a - host.start < room || host.end - b < room) return;
      var cam = style.interjectionMode === "wide" ? ctx.ci.widest : ctx.ci.fixedCloseups(ij.speaker)[0];
      if (!cam || cam === host.cameraId) return;
      shots = insertShot(shots, { start: a, end: b, cameraId: cam,
        reason: style.interjectionMode === "wide" ? "interjection-wide" : "reaction",
        speakers: [ij.speaker], onset: false, locked: false, keepShort: true });
      lastEnd = b;
    });
    return shots;
  }

  // ------------------------------------------------------- 8. cutaways

  function applyCutaways(shots, speakers, style, ctx) {
    if (!(style.maxShotSec > 0)) return shots;
    var fr = ctx.fr;
    var maxLen = Math.round(style.maxShotSec * fr);
    var cutLen = Math.round(style.cutawaySec * fr);
    var minShot = Math.round(style.minShotSec * fr);
    var result = [];
    var pick = 0;
    shots.forEach(function (s) {
      var length = s.end - s.start;
      if (s.locked || s.reason !== "speaker" || length <= maxLen) { result.push(s); return; }
      var count = Math.floor(length / maxLen);
      var cursor = s.start;
      var first = true;
      for (var k = 1; k <= count; k++) {
        var target = s.start + Math.round(length * k / (count + 1)) - (cutLen >> 1);
        var at = quietestFrame(ctx, target, cursor + minShot, s.end - minShot - cutLen);
        if (at === null) continue;
        var cam = cutawayCamera(s, speakers, style, ctx, pick++);
        if (!cam || cam === s.cameraId) continue;
        var left = copyShot(s); left.start = cursor; left.end = at; left.onset = first && s.onset; first = false;
        result.push(left);
        result.push({ start: at, end: at + cutLen, cameraId: cam, reason: "cutaway", speakers: s.speakers.slice(), onset: false, locked: false });
        cursor = at + cutLen;
      }
      var rest = copyShot(s); rest.start = cursor; rest.onset = first && s.onset;
      result.push(rest);
    });
    return result;
  }

  function cutawayCamera(s, speakers, style, ctx, n) {
    var ci = ctx.ci;
    var si = s.speakers[0];
    var listeners = [];
    for (var i = 0; i < speakers.length; i++) {
      if (i !== si && speakers[i].reactionShots !== false && ci.fixedCloseups(i).length) listeners.push(i);
    }
    var alt = ci.closeups(si).filter(function (id) { return id !== s.cameraId; });
    var options = {
      wide: ci.hasWide ? ci.widest : null,
      reaction: listeners.length ? ci.fixedCloseups(listeners[Math.floor(ctx.rand() * listeners.length)])[0] : null,
      alternate: alt.length ? alt[n % alt.length] : null
    };
    var order;
    if (style.cutawayMode === "mix") {
      var cycle = ["wide", "reaction", "alternate"];
      order = cycle.slice(n % 3).concat(cycle.slice(0, n % 3));
    } else order = [style.cutawayMode, "wide", "alternate", "reaction"];
    for (var k = 0; k < order.length; k++) if (options[order[k]]) return options[order[k]];
    return null;
  }

  /** Frame in [min,max] closest to target where all mics are quietest (cut on a breath). */
  function quietestFrame(ctx, target, min, max) {
    if (max < min) return null;
    var win = Math.round(4 * ctx.fr);
    var from = Math.max(min, target - win), to = Math.min(max, target + win);
    if (to < from) return clamp(target, min, max);
    var best = from, bestScore = Infinity;
    var step = Math.max(1, Math.round(ctx.fr / 20));
    for (var t = from; t <= to; t += step) {
      var loud = -Infinity;
      for (var s = 0; s < ctx.speakers.length; s++) {
        var c = ctx.curves[ctx.speakers[s].id];
        if (c && t < c.length && c[t] > loud) loud = c[t];
      }
      var score = loud + Math.abs(t - target) / ctx.fr * 1.5;
      if (score < bestScore) { bestScore = score; best = t; }
    }
    return best;
  }

  // -------------------------------------------------------- 9. timing

  function applyTiming(shots, style, ctx) {
    var off = Math.round(style.cutTimingSec * ctx.fr);
    if (off !== 0) {
      for (var i = 1; i < shots.length; i++) {
        var s = shots[i];
        if (!s.onset || s.locked || shots[i - 1].locked) continue;
        var prev = shots[i - 1];
        var nb = clamp(s.start + off, prev.start + 1, s.end - 1);
        prev.end = nb; s.start = nb;
      }
    }
    var open = Math.round(style.openOnWideSec * ctx.fr);
    if (open > 0 && ctx.ci.hasWide && shots.length) {
      var firstEnd = Math.min(open, shots[shots.length - 1].end);
      // Extend to the next natural cut if it's close, to avoid a tiny leftover.
      var s0 = shotAt(shots, firstEnd);
      if (s0 && s0.end - firstEnd < Math.round(style.minShotSec * ctx.fr)) firstEnd = s0.end;
      shots = insertShot(shots, { start: 0, end: firstEnd, cameraId: ctx.ci.widest, reason: "opening", speakers: [], onset: false, locked: false });
    }
    return shots;
  }

  // ------------------------------------------------ 9b. moving cameras

  var STEADY = 0, SLOW = 1, FAST = 2;

  /** Per moving camera: motion curve -> steady/slow/fast state on the decision grid. */
  function buildStability(input, cameras, style, ctx) {
    var out = {}, info = {};
    var motion = input.cameraMotion || {};
    cameras.forEach(function (c) {
      var m = motion[c.id];
      if (!c.moving || !m || !m.values || !m.values.length) return;
      var v = m.values, n = v.length, mhop = m.hopSec;
      // Median over ~0.8 s ignores single-frame glitches (a hand crossing frame, a compression hiccup).
      var med = new Float32Array(n), known = 0;
      for (var i = 0; i < n; i++) {
        var win = [];
        for (var k = Math.max(0, i - 2); k <= Math.min(n - 1, i + 2); k++) if (!isNaN(v[k])) win.push(v[k]);
        win.sort(function (a, b) { return a - b; });
        med[i] = win.length ? win[win.length >> 1] : NaN;
        if (!isNaN(v[i])) known++;
      }
      // If the picture is usually readable, an unreadable stretch means something big is changing:
      // treat it as a slow move. If it's rarely readable (plain backdrop), we can't judge: assume steady.
      var readable = known / n >= 0.5;
      var st = new Uint8Array(n), counts = [0, 0, 0];
      for (i = 0; i < n; i++) {
        var x = med[i];
        st[i] = isNaN(x) ? (readable ? SLOW : STEADY) : (x >= style.fastMinPct ? FAST : (x > style.steadyMaxPct ? SLOW : STEADY));
        counts[st[i]]++;
      }
      var grid = new Uint8Array(ctx.frames);
      for (var f = 0; f < ctx.frames; f++) { var j = Math.floor(f / ctx.fr / mhop); grid[f] = j < n ? st[j] : STEADY; }
      out[c.id] = grid;
      info[c.id] = { hopSec: mhop, states: Array.prototype.slice.call(st),
        steadyPct: round1(100 * counts[0] / n), slowPct: round1(100 * counts[1] / n), fastPct: round1(100 * counts[2] / n),
        lowDetail: !readable };
    });
    return { grid: out, info: info };
  }

  function stabilityHelpers(stab, style, ctx) {
    var settle = Math.max(1, Math.round(style.settleSec * ctx.fr));
    var pad = Math.round(style.movePadSec * ctx.fr);
    function state(cam, f) { var g = stab.grid[cam]; return g && f >= 0 && f < g.length ? g[f] : STEADY; }
    function onAir(cam, f) { var s = state(cam, f); return s === STEADY || (s === SLOW && style.slowMovesOnAir); }
    function settled(cam, f) {
      if (!stab.grid[cam]) return true;
      for (var k = Math.max(0, f - settle); k <= f; k++) if (state(cam, k) !== STEADY) return false;
      return true;
    }
    function okFrom(cam, f) { for (var k = f; k <= f + pad; k++) if (!onAir(cam, k)) return false; return true; }
    function canShow(cam, a, b) {
      if (!stab.grid[cam]) return true;
      for (var f = a; f < b; f++) if (!onAir(cam, f)) return false;
      return true;
    }
    return { state: state, onAir: onAir, settled: settled, okFrom: okFrom, canShow: canShow, has: function (c) { return !!stab.grid[c]; } };
  }

  /** Only cut to a moving camera once it has settled; cut away while it moves. */
  function applyStability(shots, style, ctx) {
    var H = ctx.stable;
    if (!Object.keys(ctx.stability.grid).length) return shots;
    var maxWait = Math.round(style.maxWaitSec * ctx.fr);
    var out = [];
    function fallbackFor(s, a, b) {
      var ci = ctx.ci, cands = [ci.widest];
      (s.speakers || []).forEach(function (si) { cands = cands.concat(ci.fixedCloseups(si)); });
      cands = cands.concat(ci.list.map(function (c) { return c.cam.id; }));
      for (var i = 0; i < cands.length; i++) if (cands[i] && cands[i] !== s.cameraId && H.canShow(cands[i], a, b)) return cands[i];
      return null;
    }
    shots.forEach(function (s) {
      var cam = s.cameraId;
      if (s.locked || !H.has(cam)) { out.push(s); return; }
      var start = s.start;
      // 1) Cutting in mid-move: wait for the camera to settle by holding the previous shot a little longer.
      var prev = out[out.length - 1];
      if (!H.settled(cam, start) && prev && !prev.locked && prev.end === start) {
        for (var t = start + 1; t <= Math.min(s.end - 1, start + maxWait); t++) {
          if (H.settled(cam, t) && H.okFrom(cam, t)) {
            if (H.canShow(prev.cameraId, start, t)) { prev.end = t; start = t; }
            break;
          }
        }
      }
      // 2) Walk the shot: on air while the camera is usable, cut away while it moves, return once settled.
      var pieces = [], on = H.settled(cam, start) && H.okFrom(cam, start), from = start;
      for (var f = start; f < s.end; f++) {
        var want = on ? H.okFrom(cam, f) : (H.settled(cam, f) && H.okFrom(cam, f));
        if (want !== on) { pieces.push({ a: from, b: f, on: on }); from = f; on = want; }
      }
      pieces.push({ a: from, b: s.end, on: on });
      pieces.forEach(function (p, i) {
        if (p.b <= p.a) return;
        var piece = copyShot(s);
        piece.start = p.a; piece.end = p.b; piece.onset = s.onset && p.a === s.start;
        if (!p.on) {
          var fb = fallbackFor(s, p.a, p.b);
          if (fb) { piece.cameraId = fb; piece.reason = "camera-move"; piece.keepShort = true; piece.onset = false; }
        }
        out.push(piece);
        void i;
      });
    });
    return mergeShots(out);
  }

  // ------------------------------------------------------- 10. cleanup

  function enforceMinShot(shots, speakers, style, ctx) {
    var fr = ctx.fr;
    function minFor(s) {
      if (s.keepShort) return Math.round(Math.min(style.minShotSec, style.reactionShotSec) * fr * 0.8);
      var si = s.speakers && s.speakers.length === 1 ? s.speakers[0] : -1;
      var sp = si >= 0 ? speakers[si] : null;
      var v = sp && sp.minShotSec !== null && sp.minShotSec !== undefined && sp.minShotSec !== "" ? Number(sp.minShotSec) : style.minShotSec;
      return Math.round(v * fr);
    }
    shots = mergeShots(shots);
    var guard = shots.length * 4 + 10;
    while (shots.length > 1 && guard-- > 0) {
      var worst = -1, worstDef = 0;
      for (var i = 0; i < shots.length; i++) {
        var s = shots[i];
        if (s.locked) continue;
        var deficit = minFor(s) - (s.end - s.start);
        if (deficit > 0 && (worst < 0 || (s.end - s.start) < (shots[worst].end - shots[worst].start))) { worst = i; worstDef = deficit; }
      }
      if (worst < 0) break;
      var sh = shots[worst], before = shots[worst - 1], after = shots[worst + 1];
      var target = null;
      var canShow = ctx.stable ? ctx.stable.canShow : function () { return true; };
      var okB = before && !before.locked && canShow(before.cameraId, sh.start, sh.end);
      var okA = after && !after.locked && canShow(after.cameraId, sh.start, sh.end);
      if (okB && okA) target = (before.cameraId === after.cameraId || (before.end - before.start) >= (after.end - after.start)) ? before : after;
      else if (okB) target = before; else if (okA) target = after;
      if (!target) { sh.locked = true; sh._pinned = true; continue; }
      sh.cameraId = target.cameraId; sh.reason = target.reason; sh.speakers = target.speakers.slice(); sh.keepShort = false;
      shots = mergeShots(shots);
    }
    shots.forEach(function (s) { if (s._pinned) { s.locked = false; delete s._pinned; } });
    return shots;
  }

  function applyOverrides(shots, overrides, ctx) {
    (overrides || []).forEach(function (o) {
      var a = Math.round(Math.min(o.startSec, o.endSec) * ctx.fr);
      var b = Math.round(Math.max(o.startSec, o.endSec) * ctx.fr);
      a = Math.max(0, a); b = Math.min(ctx.frames, b);
      if (b <= a) return;
      shots = insertShot(shots, { start: a, end: b, cameraId: o.cameraId, reason: "locked", speakers: [], onset: false, locked: true });
    });
    return shots;
  }

  // ------------------------------------------------------------- main

  /**
   * plan(input, config)
   *   input:  { durationSec, hopSec, fps, curves: { speakerId: number[] (dB per hop) } }
   *   config: { speakers: [{id,name,...DEFAULT_SPEAKER}], cameras: [{id,name,videoTrack,shows:[speakerId]}],
   *             preset: "balanced", style: {...overrides}, overrides: [{startSec,endSec,cameraId}] }
   */
  function plan(input, config) {
    var style = styleFromPreset(config.preset, config.style);
    var hop = input.hopSec;
    var fr = 1 / hop; // analysis frames per second
    var frames = Math.max(1, Math.ceil(input.durationSec / hop));
    var speakers = (config.speakers || []).filter(function (s) { return s.enabled !== false; })
      .map(function (s) { return merge(DEFAULT_SPEAKER, s); });
    var cameras = (config.cameras || []).filter(function (c) { return c.enabled !== false; });
    if (!cameras.length) throw new Error("No cameras configured.");
    if (!speakers.length) throw new Error("No speakers configured.");

    var curves = input.curves;
    var cal = calibrate(curves, speakers, style);
    var raw = detectActivity(curves, speakers, cal, style, frames);
    var runs = raw.map(function (r) {
      return smoothRuns(r, Math.round(style.holdSec * fr), Math.max(1, Math.round(style.attackSec * fr)));
    });
    var classified = classifyRuns(runs, speakers, style, fr);
    var segs = floorSegments(classified.main, speakers, style, fr, frames);

    var ctx = { fr: fr, frames: frames, curves: curves, speakers: speakers, cal: cal, rand: rng(style.seed) };
    var built = buildShots(segs, speakers, cameras, style, ctx);
    ctx.ci = built.ci;
    var shots = built.shots;
    shots = applyInterjections(shots, classified.interjections, speakers, style, ctx);
    shots = applyCutaways(shots, speakers, style, ctx);
    shots = applyTiming(shots, style, ctx);
    ctx.stability = buildStability(input, cameras, style, ctx);
    ctx.stable = stabilityHelpers(ctx.stability, style, ctx);
    shots = applyStability(shots, style, ctx);
    shots = enforceMinShot(shots, speakers, style, ctx);
    shots = applyOverrides(shots, config.overrides, ctx);
    shots = mergeShots(shots);

    // Convert to seconds, snap to video frames.
    var fps = input.fps || 30;
    var outShots = shots.map(function (s) {
      var a = s.start * hop, b = Math.min(s.end * hop, input.durationSec);
      if (style.snapToFrames) { a = Math.round(a * fps) / fps; b = s.end >= frames ? input.durationSec : Math.round(b * fps) / fps; }
      return { startSec: round3(a), endSec: round3(b), cameraId: s.cameraId, reason: s.reason,
               speakers: (s.speakers || []).map(function (i) { return speakers[i].id; }), locked: !!s.locked };
    }).filter(function (s) { return s.endSec > s.startSec; });
    // Re-stitch after snapping so shots stay contiguous.
    for (var i = 1; i < outShots.length; i++) outShots[i].startSec = outShots[i - 1].endSec;
    outShots = outShots.filter(function (s) { return s.endSec > s.startSec + 1e-6; });
    if (outShots.length) { outShots[0].startSec = 0; }

    return {
      shots: outShots,
      calibration: cal,
      speech: runs.map(function (rs, si) {
        return { speakerId: speakers[si].id, runs: rs.map(function (r) { return [round3(r[0] * hop), round3(r[1] * hop)]; }) };
      }),
      interjections: classified.interjections.map(function (ij) {
        return { speakerId: speakers[ij.speaker].id, startSec: round3(ij.start * hop), endSec: round3(ij.end * hop) };
      }),
      stats: computeStats(outShots, runs, speakers, cameras, input.durationSec, hop),
      stability: ctx.stability.info,
      style: style
    };
  }

  function computeStats(shots, runs, speakers, cameras, duration, hop) {
    var lengths = shots.map(function (s) { return s.endSec - s.startSec; }).sort(function (a, b) { return a - b; });
    var screen = {}, reasons = {};
    cameras.forEach(function (c) { screen[c.id] = 0; });
    shots.forEach(function (s) {
      screen[s.cameraId] = (screen[s.cameraId] || 0) + (s.endSec - s.startSec);
      reasons[s.reason] = (reasons[s.reason] || 0) + 1;
    });
    var talk = {};
    runs.forEach(function (rs, si) {
      var sum = 0; rs.forEach(function (r) { sum += r[1] - r[0]; });
      talk[speakers[si].id] = round1(100 * sum * hop / Math.max(1e-6, duration));
    });
    var pct = {};
    for (var k in screen) pct[k] = round1(100 * screen[k] / Math.max(1e-6, duration));
    return {
      shots: shots.length,
      cuts: Math.max(0, shots.length - 1),
      cutsPerMinute: round1(Math.max(0, shots.length - 1) / Math.max(1 / 60, duration / 60)),
      avgShotSec: round1(lengths.reduce(function (a, b) { return a + b; }, 0) / Math.max(1, lengths.length)),
      medianShotSec: round1(lengths.length ? lengths[Math.floor(lengths.length / 2)] : 0),
      shortestShotSec: round3(lengths[0] || 0),
      longestShotSec: round1(lengths[lengths.length - 1] || 0),
      screenTimePct: pct,
      talkTimePct: talk,
      reasons: reasons
    };
  }

  /** Per video track: which ranges are enabled. Boundaries are video frame numbers. */
  function toEditPayload(result, cameras, fps) {
    var camById = {};
    cameras.forEach(function (c) { camById[c.id] = c; });
    var cuts = [];
    var shots = result.shots.map(function (s) {
      var a = Math.round(s.startSec * fps), b = Math.round(s.endSec * fps);
      if (a > 0) cuts.push(a);
      return { startFrame: a, endFrame: b, videoTrack: camById[s.cameraId] ? camById[s.cameraId].videoTrack : -1, cameraId: s.cameraId };
    });
    return {
      cameraTracks: cameras.map(function (c) { return c.videoTrack; }),
      cutFrames: cuts,
      shots: shots
    };
  }

  return {
    VERSION: "0.3.0",
    DEFAULT_STYLE: DEFAULT_STYLE,
    DEFAULT_SPEAKER: DEFAULT_SPEAKER,
    PRESETS: PRESETS,
    styleFromPreset: styleFromPreset,
    presetForSubjects: presetForSubjects,
    plan: plan,
    toEditPayload: toEditPayload,
    _internal: { smoothRuns: smoothRuns, calibrate: calibrate, percentile: percentile, shotAt: shotAt }
  };
});
