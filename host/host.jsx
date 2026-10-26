/*
 * PodDirector — ExtendScript host (runs inside Premiere Pro).
 *
 * Everything returns a JSON string: { ok: true, ... } or { ok: false, error }.
 * Sequence reading / duplication approach adapted from Podclip (MIT).
 *
 *   PD.ping()
 *   PD.getSequenceInfo()                 tracks, clips, media paths, fps, duration
 *   PD.getPlayhead() / PD.setPlayhead(sec)
 *   PD.addMarkers(json) / PD.clearMarkers(prefix)
 *   PD.duplicateActive(expectedID)       clone + open the copy
 *   PD.razorTrack(json)                  QE-razor one video track at frame numbers
 *   PD.applyEnables(json)                enable exactly one camera track per shot
 */

#target premierepro

if (typeof JSON === "undefined") {
  JSON = {
    parse: function (s) { return eval("(" + s + ")"); },
    stringify: function (v) {
      var t = typeof v;
      if (v === null || t === "undefined") return "null";
      if (t === "number" || t === "boolean") return isFinite(v) || t === "boolean" ? String(v) : "null";
      if (t === "string") return '"' + v.replace(/[\\"]/g, "\\$&").replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t") + '"';
      var out = [], k;
      if (v instanceof Array) { for (k = 0; k < v.length; k++) out.push(JSON.stringify(v[k])); return "[" + out.join(",") + "]"; }
      for (k in v) if (v.hasOwnProperty(k) && typeof v[k] !== "function") out.push(JSON.stringify(k) + ":" + JSON.stringify(v[k]));
      return "{" + out.join(",") + "}";
    }
  };
}

var PD = (function () {
  var TPS = 254016000000; // Premiere ticks per second

  function ok(o) { o = o || {}; o.ok = true; return JSON.stringify(o); }
  function fail(msg) { return JSON.stringify({ ok: false, error: String(msg) }); }
  function sec(t) {
    // Track items expose Time objects; sequence.end is a plain tick string.
    return parseFloat(typeof t === "object" && t !== null ? t.ticks : t) / TPS;
  }

  function ping() { return ok({ version: app.version, project: app.project ? app.project.name : null }); }

  function seqOrFail() {
    var seq = app.project && app.project.activeSequence;
    return seq || null;
  }

  function getSequenceInfo() {
    var seq = seqOrFail();
    if (!seq) return fail("Open a sequence first (no active sequence).");
    var tpf = parseFloat(seq.timebase);
    var info = {
      name: seq.name, sequenceID: seq.sequenceID, fps: TPS / tpf, ticksPerFrame: seq.timebase,
      durationSec: sec(seq.end), audioTracks: [], videoTracks: []
    };
    var i, j, track, clip, clips, mp, speed;
    for (i = 0; i < seq.audioTracks.numTracks; i++) {
      track = seq.audioTracks[i];
      clips = [];
      for (j = 0; j < track.clips.numItems; j++) {
        clip = track.clips[j];
        mp = null; speed = 1;
        try { mp = clip.projectItem ? clip.projectItem.getMediaPath() : null; } catch (e1) { mp = null; }
        try { if (typeof clip.getSpeed === "function") speed = clip.getSpeed(); } catch (e2) { speed = 1; }
        clips.push({ name: clip.name, startSec: sec(clip.start), endSec: sec(clip.end),
          inPointSec: sec(clip.inPoint), mediaPath: mp, speed: speed });
      }
      var muted = false;
      try { muted = track.isMuted(); } catch (e3) { muted = false; }
      info.audioTracks.push({ index: i, name: track.name || ("A" + (i + 1)), muted: muted, clips: clips });
    }
    for (i = 0; i < seq.videoTracks.numTracks; i++) {
      track = seq.videoTracks[i];
      var first = null, n = track.clips.numItems, endMax = 0, media = [], seen = {}, vclips = [];
      for (j = 0; j < n; j++) {
        clip = track.clips[j];
        if (!first) first = clip.name;
        endMax = Math.max(endMax, sec(clip.end));
        mp = null; speed = 1;
        try {
          mp = clip.projectItem ? clip.projectItem.getMediaPath() : null;
          if (mp && !seen[mp] && media.length < 50) { seen[mp] = true; media.push(mp); }
        } catch (e4) { /* graphics, nested sequences */ }
        try { if (typeof clip.getSpeed === "function") speed = clip.getSpeed(); } catch (e5) { speed = 1; }
        // Clip list for camera-motion analysis (capped: camera tracks rarely have more).
        if (vclips.length < 400) vclips.push({ startSec: sec(clip.start), endSec: sec(clip.end), inPointSec: sec(clip.inPoint), mediaPath: mp, speed: speed });
      }
      info.videoTracks.push({ index: i, name: track.name || ("V" + (i + 1)), clipCount: n, firstClip: first, endSec: endMax, mediaPaths: media, clips: vclips });
    }
    return ok(info);
  }

  function getPlayhead() {
    var seq = seqOrFail();
    if (!seq) return fail("No active sequence.");
    return ok({ sec: sec(seq.getPlayerPosition()), sequenceID: seq.sequenceID });
  }

  function setPlayhead(s) {
    var seq = seqOrFail();
    if (!seq) return fail("No active sequence.");
    var ticks = Math.round(Number(s) * TPS);
    seq.setPlayerPosition(String(ticks));
    return ok();
  }

  /** json: { prefix, markers: [{ startSec, endSec?, name, comment, color }] }  color = 0..7 */
  function addMarkers(json) {
    var seq = seqOrFail();
    if (!seq) return fail("No active sequence.");
    var p = JSON.parse(json), n = 0;
    for (var i = 0; i < p.markers.length; i++) {
      var m = p.markers[i];
      var mk = seq.markers.createMarker(m.startSec);
      mk.name = (p.prefix || "") + (m.name || "");
      if (m.comment) mk.comments = m.comment;
      if (m.endSec && m.endSec > m.startSec) mk.end = m.endSec;
      try { if (typeof mk.setColorByIndex === "function") mk.setColorByIndex(m.color || 0); } catch (e) { /* older versions */ }
      n++;
    }
    return ok({ added: n });
  }

  function clearMarkers(prefix) {
    var seq = seqOrFail();
    if (!seq) return fail("No active sequence.");
    var removed = 0, doomed = [];
    var mk = seq.markers.getFirstMarker();
    while (mk) {
      if (mk.name && mk.name.indexOf(prefix) === 0) doomed.push(mk);
      mk = seq.markers.getNextMarker(mk);
    }
    for (var i = 0; i < doomed.length; i++) { seq.markers.deleteMarker(doomed[i]); removed++; }
    return ok({ removed: removed });
  }

  function seqIDs() {
    var ids = {};
    for (var i = 0; i < app.project.sequences.numSequences; i++) ids[app.project.sequences[i].sequenceID] = true;
    return ids;
  }

  function duplicateActive(expectedID, suffix) {
    var seq = seqOrFail();
    if (!seq) return fail("No active sequence.");
    if (expectedID && seq.sequenceID !== expectedID) return fail("The analyzed sequence is no longer active. Re-scan the sequence you want to cut.");
    try {
      app.enableQE();
      var q = qe.project.getActiveSequence();
      var qt = q && q.getVideoTrackAt(0);
      if (!qt || typeof qt.razor !== "function") return fail("This Premiere version does not expose the razor tool to scripts. Nothing was changed.");
    } catch (eq) { return fail("Premiere's QE scripting layer is unavailable: " + eq); }
    var before = seqIDs();
    try { seq.clone(); } catch (e) { return fail("Could not duplicate the sequence: " + e); }
    var copy = null;
    for (var i = 0; i < app.project.sequences.numSequences; i++) {
      var s = app.project.sequences[i];
      if (!before[s.sequenceID]) { copy = s; break; }
    }
    if (!copy) return fail("Premiere did not create the duplicate.");
    try { copy.name = seq.name + (suffix || " - PodDirector"); } catch (en) { /* name is cosmetic */ }
    app.project.openSequence(copy.sequenceID);
    return ok({ sequenceID: copy.sequenceID, name: copy.name, originalName: seq.name });
  }

  function timecodeFor(seq, frame) {
    var t = new Time();
    t.ticks = String(Math.round(frame * parseFloat(seq.timebase)));
    try {
      var st = seq.getSettings();
      return t.getFormatted(st.videoFrameRate, st.videoDisplayFormat);
    } catch (e) {
      // Fallback: non-drop timecode from frame count.
      var fps = Math.round(TPS / parseFloat(seq.timebase));
      var ff = frame % fps, ts = Math.floor(frame / fps);
      function p2(n) { return n < 10 ? "0" + n : "" + n; }
      return p2(Math.floor(ts / 3600)) + ":" + p2(Math.floor(ts / 60) % 60) + ":" + p2(ts % 60) + ":" + p2(ff);
    }
  }

  /** json: { sequenceID, track, frames: [..] } — razor one video track at each frame. */
  function razorTrack(json) {
    var seq = seqOrFail();
    if (!seq) return fail("No active sequence.");
    var p = JSON.parse(json);
    if (p.sequenceID && seq.sequenceID !== p.sequenceID) return fail("Refusing to edit: the PodDirector copy is not the active sequence.");
    app.enableQE();
    var q = qe.project.getActiveSequence();
    var qt = q.getVideoTrackAt(p.track);
    if (!qt) return fail("Video track V" + (p.track + 1) + " not found.");
    var vt = seq.videoTracks[p.track];
    // Only razor where a clip actually spans the cut (avoids QE errors in gaps).
    var spans = [];
    for (var c = 0; c < vt.clips.numItems; c++) {
      spans.push([parseFloat(vt.clips[c].start.ticks), parseFloat(vt.clips[c].end.ticks)]);
    }
    var tpf = parseFloat(seq.timebase), n = 0, skipped = 0;
    for (var i = 0; i < p.frames.length; i++) {
      var tk = p.frames[i] * tpf, inside = false;
      for (var s = 0; s < spans.length; s++) if (tk > spans[s][0] + tpf / 2 && tk < spans[s][1] - tpf / 2) { inside = true; break; }
      if (!inside) { skipped++; continue; }
      try { qt.razor(timecodeFor(seq, p.frames[i])); n++; } catch (e) { skipped++; }
    }
    return ok({ razored: n, skipped: skipped });
  }

  /** json: { sequenceID, cameraTracks: [..], shots: [{startFrame,endFrame,videoTrack}] } */
  function applyEnables(json) {
    var seq = seqOrFail();
    if (!seq) return fail("No active sequence.");
    var p = JSON.parse(json);
    if (p.sequenceID && seq.sequenceID !== p.sequenceID) return fail("Refusing to edit: the PodDirector copy is not the active sequence.");
    var tpf = parseFloat(seq.timebase), shots = p.shots, toggled = 0;
    function shotAt(frame) {
      var lo = 0, hi = shots.length - 1;
      while (lo <= hi) {
        var mid = (lo + hi) >> 1;
        if (shots[mid].endFrame <= frame) lo = mid + 1;
        else if (shots[mid].startFrame > frame) hi = mid - 1;
        else return shots[mid];
      }
      return null;
    }
    for (var t = 0; t < p.cameraTracks.length; t++) {
      var idx = p.cameraTracks[t], vt = seq.videoTracks[idx];
      if (!vt) continue;
      for (var c = 0; c < vt.clips.numItems; c++) {
        var clip = vt.clips[c];
        var mid = (parseFloat(clip.start.ticks) + parseFloat(clip.end.ticks)) / 2 / tpf;
        var shot = shotAt(Math.floor(mid));
        if (!shot) continue;
        var want = shot.videoTrack === idx;
        try { if (clip.disabled !== !want) { clip.disabled = !want; toggled++; } } catch (e) { /* not toggleable */ }
      }
    }
    return ok({ toggled: toggled });
  }

  return { ping: ping, getSequenceInfo: getSequenceInfo, getPlayhead: getPlayhead, setPlayhead: setPlayhead,
           addMarkers: addMarkers, clearMarkers: clearMarkers, duplicateActive: duplicateActive,
           razorTrack: razorTrack, applyEnables: applyEnables };
})();
