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
      durationSec: sec(seq.end), inSec: null, outSec: null, audioTracks: [], videoTracks: []
    };
    // Sequence In/Out marks (unset marks come back as 0 / the end, or as large negative numbers).
    try {
      var inS = parseFloat(seq.getInPoint()), outS = parseFloat(seq.getOutPoint());
      if (isFinite(inS) && inS > 0.01 && inS < info.durationSec) info.inSec = inS;
      if (isFinite(outS) && outS > 0 && outS < info.durationSec - 0.01 && outS > (info.inSec || 0)) info.outSec = outS;
    } catch (eIO) { /* older Premiere: whole sequence */ }
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
      var hidden = false;
      try { hidden = track.isMuted(); } catch (e6) { hidden = false; } // a video track's "mute" is its eye (track output)
      info.videoTracks.push({ index: i, name: track.name || ("V" + (i + 1)), clipCount: n, firstClip: first, endSec: endMax, mediaPaths: media, clips: vclips, hidden: hidden });
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

  /** json: { inSec?, outSec? } -> sets the active sequence's In and/or Out point. */
  function setInOut(json) {
    var seq = seqOrFail();
    if (!seq) return fail("No active sequence.");
    var o = JSON.parse(json);
    function put(fn, v) {
      try { seq[fn](Number(v)); return; } catch (e) { /* older versions want a string or a Time */ }
      try { seq[fn](String(v)); return; } catch (e2) { /* fall through */ }
      var t = new Time(); t.seconds = Number(v); seq[fn](t);
    }
    try {
      if (o.inSec !== undefined && o.inSec !== null) put("setInPoint", o.inSec);
      if (o.outSec !== undefined && o.outSec !== null) put("setOutPoint", o.outSec);
    } catch (e3) { return fail("Couldn't set In/Out: " + e3); }
    return ok({ inSec: parseFloat(seq.getInPoint()), outSec: parseFloat(seq.getOutPoint()) });
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

  /** json: { sequenceID, tracks: [{track, segments:[{startFrame,endFrame,enabled}]}] }
   *  or (older payloads) { sequenceID, cameraTracks: [..], shots: [{startFrame,endFrame,videoTrack}] } */
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
    // Per-track stretches (layered edits: the bottom camera stays enabled, cameras above switch on and off).
    if (p.tracks) {
      for (var k = 0; k < p.tracks.length; k++) {
        var tr = p.tracks[k], vt2 = seq.videoTracks[tr.track], sg = tr.segments;
        if (!vt2) continue;
        for (var c2 = 0; c2 < vt2.clips.numItems; c2++) {
          var clip2 = vt2.clips[c2];
          var f = Math.floor((parseFloat(clip2.start.ticks) + parseFloat(clip2.end.ticks)) / 2 / tpf), seg = null;
          for (var lo = 0, hi = sg.length - 1; lo <= hi;) {
            var m = (lo + hi) >> 1;
            if (sg[m].endFrame <= f) lo = m + 1; else if (sg[m].startFrame > f) hi = m - 1; else { seg = sg[m]; break; }
          }
          if (!seg) continue;
          try { if (clip2.disabled !== !seg.enabled) { clip2.disabled = !seg.enabled; toggled++; } } catch (e6) { /* not toggleable */ }
        }
      }
      return ok({ toggled: toggled });
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

  /**
   * For the keystroke trial: is there a multicam clip under the playhead in the active sequence? A multicam
   * source sequence counts; so does a nested sequence (Multi-Camera > Enable can't be read from scripts, so
   * the panel asks the user to check it). Multicam clips win over nests.
   * -> { sequenceID, name, playheadSec, fps, multicam: { track, name, startSec, endSec, multicam: bool } | null }
   */
  function multicamAtPlayhead() {
    var seq = seqOrFail();
    if (!seq) return fail("No active sequence.");
    var at = sec(seq.getPlayerPosition()), found = null, nest = null;
    for (var i = 0; i < seq.videoTracks.numTracks && !found; i++) {
      var vt = seq.videoTracks[i];
      for (var c = 0; c < vt.clips.numItems; c++) {
        var clip = vt.clips[c];
        if (sec(clip.start) > at || sec(clip.end) <= at) continue;
        var mc = false, isSeq = false;
        try { mc = !!(clip.projectItem && clip.projectItem.isMulticamClip && clip.projectItem.isMulticamClip()); } catch (e) { mc = false; }
        try { isSeq = !!(clip.projectItem && clip.projectItem.isSequence && clip.projectItem.isSequence()); } catch (e3) { isSeq = false; }
        var hit = { track: i, name: clip.name, startSec: sec(clip.start), endSec: sec(clip.end), multicam: mc };
        if (mc) { found = hit; break; }
        if (isSeq && !nest) nest = hit;
      }
    }
    if (!found) found = nest;
    var fps = 30;
    try { fps = Math.round(TPS / parseFloat(seq.timebase) * 1000) / 1000; } catch (e2) { fps = 30; }
    return ok({ sequenceID: seq.sequenceID, name: seq.name, playheadSec: at, fps: fps, multicam: found });
  }

  /**
   * For Build as multicam: the multicam (or nested) clips on one track that together cover [startSec, endSec].
   * Picks the track with the most multicam/nest coverage of the range; a real multicam source wins over a nest.
   * json: { startSec, endSec } -> { sequenceID, name, fps, track, multicam, coveredSec, gaps: [[a,b]], clips }
   */
  function multicamCovering(json) {
    var seq = seqOrFail();
    if (!seq) return fail("No active sequence.");
    var p = JSON.parse(json), best = null;
    for (var i = 0; i < seq.videoTracks.numTracks; i++) {
      var vt = seq.videoTracks[i], covered = 0, mcAll = true, spans = [], n = 0;
      for (var c = 0; c < vt.clips.numItems; c++) {
        var clip = vt.clips[c], a = sec(clip.start), b = sec(clip.end);
        if (b <= p.startSec || a >= p.endSec) continue;
        var mc = false, isSeq = false;
        try { mc = !!(clip.projectItem && clip.projectItem.isMulticamClip && clip.projectItem.isMulticamClip()); } catch (e) { mc = false; }
        try { isSeq = !!(clip.projectItem && clip.projectItem.isSequence && clip.projectItem.isSequence()); } catch (e2) { isSeq = false; }
        if (!mc && !isSeq) continue;
        if (!mc) mcAll = false;
        n++;
        spans.push([Math.max(a, p.startSec), Math.min(b, p.endSec)]);
        covered += Math.min(b, p.endSec) - Math.max(a, p.startSec);
      }
      if (!n) continue;
      if (!best || covered > best.coveredSec + 0.01 || (Math.abs(covered - best.coveredSec) <= 0.01 && mcAll && !best.multicam)) {
        var gaps = [], at = p.startSec;
        spans.sort(function (x, y) { return x[0] - y[0]; });
        for (var s = 0; s < spans.length; s++) { if (spans[s][0] > at + 0.05) gaps.push([at, spans[s][0]]); at = Math.max(at, spans[s][1]); }
        if (at < p.endSec - 0.05) gaps.push([at, p.endSec]);
        best = { track: i, multicam: mcAll, coveredSec: covered, gaps: gaps, clips: n };
      }
    }
    var fps = 30;
    try { fps = Math.round(TPS / parseFloat(seq.timebase) * 1000) / 1000; } catch (e3) { fps = 30; }
    var r = { sequenceID: seq.sequenceID, name: seq.name, fps: fps, inSec: null, outSec: null };
    try {
      // The sequence's own In/Out marks (for building only part of it); unset marks read as 0 / the end.
      var inS = parseFloat(seq.getInPoint()), outS = parseFloat(seq.getOutPoint()), endS = sec(seq.end);
      if (isFinite(inS) && inS > 0.01) r.inSec = inS;
      if (isFinite(outS) && outS > 0 && outS < endS - 0.01 && outS > (r.inSec || 0)) r.outSec = outS;
    } catch (eIO) { /* older Premiere */ }
    if (best) for (var k in best) if (best.hasOwnProperty(k)) r[k] = best[k];
    return ok(r);
  }

  /** json: { track, startSec, endSec } -> { clips }: how many pieces a track has inside a range (after cutting). */
  function countClips(json) {
    var seq = seqOrFail();
    if (!seq) return fail("No active sequence.");
    var p = JSON.parse(json), vt = seq.videoTracks[p.track], n = 0;
    if (!vt) return fail("Video track V" + (p.track + 1) + " not found.");
    for (var c = 0; c < vt.clips.numItems; c++) {
      var a = sec(vt.clips[c].start), b = sec(vt.clips[c].end);
      if (b > p.startSec + 0.02 && a < p.endSec - 0.02) n++;
    }
    return ok({ clips: n });
  }

  /** json: { sequenceID, tracks: [index] } — turn track output (the eye) on for these video tracks. */
  function showTracks(json) {
    var seq = seqOrFail();
    if (!seq) return fail("No active sequence.");
    var p = JSON.parse(json);
    if (p.sequenceID && seq.sequenceID !== p.sequenceID) return fail("Refusing to edit: the PodDirector copy is not the active sequence.");
    var shown = [];
    for (var i = 0; i < p.tracks.length; i++) {
      var vt = seq.videoTracks[p.tracks[i]];
      if (!vt) continue;
      try { if (vt.isMuted()) { vt.setMute(0); shown.push(p.tracks[i]); } } catch (e) { /* older Premiere: leave it */ }
    }
    return ok({ shown: shown });
  }

  /** Open a sequence by ID (used to recut an earlier PodDirector copy). */
  function openSequenceById(id) {
    for (var i = 0; i < app.project.sequences.numSequences; i++) {
      var s = app.project.sequences[i];
      if (s.sequenceID === id) {
        app.project.openSequence(id);
        return ok({ sequenceID: id, name: s.name });
      }
    }
    return fail("That PodDirector copy no longer exists in this project.");
  }

  return { ping: ping, getSequenceInfo: getSequenceInfo, getPlayhead: getPlayhead, setPlayhead: setPlayhead,
           addMarkers: addMarkers, clearMarkers: clearMarkers, duplicateActive: duplicateActive,
           razorTrack: razorTrack, applyEnables: applyEnables, showTracks: showTracks, multicamAtPlayhead: multicamAtPlayhead,
           multicamCovering: multicamCovering, countClips: countClips, openSequenceById: openSequenceById, setInOut: setInOut };
})();
