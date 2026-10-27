/*
 * PodDirector — transcript analyzer.
 *
 * Finds sections the hosts meant to cut: spoken edit cues ("cut that",
 * "scratch that", "let me start over", "we'll fix it in post"), off-the-record
 * stretches, and false starts (a sentence begun, abandoned, and restarted with
 * the same words). Produces suggested remove-ranges with a confidence score
 * and the reason, for review in the panel or by Claude.
 *
 * Inputs: SRT, WebVTT, Premiere transcript .txt (timecoded blocks), or Whisper
 * JSON (segments, optional word timestamps). Pure JS, no dependencies.
 */
(function (root, factory) {
  // CEP panels with Node enabled define both window and module: export to both.
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (typeof window !== "undefined") window.PodTranscript = api;
  else if (root) root.PodTranscript = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // ------------------------------------------------------------- parsing

  var TC = /(\d{1,2}):(\d{2}):(\d{2})(?:([.,])(\d{1,3})|[:;](\d{2}))?/;
  var TC_G = new RegExp(TC.source, "g");

  function tcToSec(m, fps) {
    var h = +m[1], mi = +m[2], s = +m[3];
    var frac = 0;
    if (m[5] !== undefined) frac = parseFloat("0." + m[5]);
    else if (m[6] !== undefined) frac = (+m[6]) / (fps || 30);
    return h * 3600 + mi * 60 + s + frac;
  }

  /** Parse transcript text in any supported format. Returns [{startSec,endSec,speaker,text,words?}] */
  function parse(text, opts) {
    opts = opts || {};
    var fps = opts.fps || 30;
    text = String(text || "").replace(/^﻿/, "");
    var trimmed = text.trim();
    if (trimmed.charAt(0) === "{" || trimmed.charAt(0) === "[") return parseJson(JSON.parse(trimmed));

    var lines = text.split(/\r?\n/);
    var segs = [];
    var cur = null;
    function flush() {
      if (cur && cur.text.trim()) {
        cur.text = cur.text.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
        var sp = /^\s*(?:\[([^\]]{1,40})\]|([A-Z][\w .'-]{0,30}?)\s*:)\s+/.exec(cur.text);
        if (!cur.speaker && sp) { cur.speaker = (sp[1] || sp[2]).trim(); cur.text = cur.text.slice(sp[0].length); }
        if (/^>>\s*/.test(cur.text)) cur.text = cur.text.replace(/^>>\s*/, "");
        segs.push(cur);
      }
      cur = null;
    }
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (/^WEBVTT/.test(line) || /^NOTE\b/.test(line)) continue;
      var tcs = [];
      var m;
      TC_G.lastIndex = 0;
      while ((m = TC_G.exec(line)) !== null) tcs.push(m);
      var isTimeLine = tcs.length >= 1 && line.replace(TC_G, "").replace(/-->|-|–|\s|\[|\]|\(|\)/g, "").length === 0;
      if (isTimeLine) {
        flush();
        var start = tcToSec(tcs[0], fps);
        cur = { startSec: start, endSec: tcs[1] ? tcToSec(tcs[1], fps) : null, speaker: null, text: "" };
        continue;
      }
      if (!cur) continue;
      if (/^\d+$/.test(line.trim()) && !cur.text) continue; // SRT index
      if (!line.trim()) { if (cur.text) flush(); continue; }
      // Premiere .txt puts the speaker name alone on the line after the timecode.
      if (!cur.text && !cur.speaker && /^(Speaker \d+|[A-Z][\w .'-]{0,30})$/.test(line.trim()) && lines[i + 1] && lines[i + 1].trim()) {
        cur.speaker = line.trim();
        continue;
      }
      cur.text += (cur.text ? " " : "") + line.trim();
    }
    flush();
    // Fill missing end times from the next segment.
    for (var k = 0; k < segs.length; k++) {
      if (segs[k].endSec === null || segs[k].endSec <= segs[k].startSec) {
        segs[k].endSec = segs[k + 1] ? segs[k + 1].startSec : segs[k].startSec + estimateDuration(segs[k].text);
      }
    }
    segs.forEach(function (sg) { if (isSound(sg.text)) sg.sound = true; });
    return segs.sort(function (a, b) { return a.startSec - b.startSec; });
  }

  /** Whisper and caption files mark non-speech sounds as [phone ringing], (laughs), *buzzing*. */
  function isSound(text) { return /^\s*[\[(*][^\])*]{1,60}[\])*]\s*$/.test(text || ""); }

  function estimateDuration(text) { return Math.max(1, text.split(/\s+/).length / 2.7); }

  function parseJson(obj) {
    var segs = obj.segments || obj.transcription || obj.results || obj;
    if (!Array.isArray(segs)) throw new Error("Unrecognized transcript JSON.");
    return segs.map(function (s) {
      var start = num(s.start, s.startSec, s.offsets && s.offsets.from / 1000, s.timestamps && parseTs(s.timestamps.from));
      var end = num(s.end, s.endSec, s.offsets && s.offsets.to / 1000, s.timestamps && parseTs(s.timestamps.to));
      var words = (s.words || []).map(function (w) {
        return { startSec: num(w.start, w.startSec), endSec: num(w.end, w.endSec), text: String(w.word || w.text || "").trim() };
      });
      var text = String(s.text || "").trim();
      return { startSec: start, endSec: end, speaker: s.speaker || null, text: text, words: words.length ? words : undefined, sound: isSound(text) || undefined };
    }).filter(function (s) { return isFinite(s.startSec) && s.text; });
  }
  function parseTs(t) { var m = TC.exec(t || ""); return m ? tcToSec(m) : NaN; }
  function num() {
    for (var i = 0; i < arguments.length; i++) { var v = Number(arguments[i]); if (arguments[i] !== undefined && arguments[i] !== null && isFinite(v)) return v; }
    return NaN;
  }

  // --------------------------------------------------------------- cues

  // weight: how sure we are this phrase means "remove something".
  // scope: "before" = the mistake precedes the cue, "after" = what follows is off-limits.
  var CUES = [
    // Explicit edit instructions
    { re: /\b(cut|edit|strike|delete|remove|chop|trim)\s+(that|this|all that|all of that|that part|this part|that bit|this bit|that section|that one)\b/, type: "edit-cue", weight: 0.95, scope: "before" },
    { re: /\b(cut|edit|take|leave|keep|chop|trim|bleep)\s+(it|that|this|all that|that part|this part|that bit|this bit)\s+out\b/, type: "edit-cue", weight: 0.95, scope: "before" },
    { re: /\b(we('ll| will| can| should| gotta|'re gonna| are going to)|you can|can (we|you)|please|gonna|going to)\s+(cut|edit|trim|chop)\b/, type: "edit-cue", weight: 0.85, scope: "before" },
    { re: /\b(fix|clean|sort|deal with) (it|that|this) (up )?in post\b|\bin post\b/, type: "edit-cue", weight: 0.75, scope: "before" },
    { re: /\b(scratch|strike|disregard|ignore) (that|this|all that)\b/, type: "edit-cue", weight: 0.9, scope: "before" },
    { re: /\b(don't|do not|can't|cannot) (use|include|air|publish) (that|this|it)\b/, type: "edit-cue", weight: 0.9, scope: "before" },
    { re: /\b(don't|do not|can't|cannot) put (that|this|it) (on (the )?air|in (the )?(show|episode|podcast|edit))\b/, type: "edit-cue", weight: 0.9, scope: "before" },
    // A bare "cut." addressed to the editor ("So David, cut."), checked on the raw text so punctuation counts.
    { raw: /(?:^|[.!?]\s+)(?:(?:so|and|okay|ok|alright|all right)\s*,?\s*)?(?:[A-Z][a-z]+,\s*)?cut(?:\s+(?:it|there|here))?\s*[.!]?\s*$/i, type: "edit-cue", weight: 0.8, scope: "before" },
    { raw: /(?:^|[.!?]\s+)(?:(?:so|and|okay|ok|alright|all right)\s*,?\s*)?(?:[A-Z][a-z]+,\s*)?cut(?:\s+(?:it|there|here))?\s*[.!]/i, type: "edit-cue", weight: 0.75, scope: "before" },
    { re: /\b(bleep|beep) (that|this|it)( out)?\b/, type: "bleep", weight: 0.8, scope: "before" },
    { re: /\bthat('s| is| was) (not|n't) going in\b|\bnot for (the )?(episode|show|podcast|air|broadcast)\b/, type: "edit-cue", weight: 0.85, scope: "before" },
    // Restarts / retakes
    { re: /\b(let me|lemme|i('ll| will| need to| wanna| want to)|can i|should i|let's|lets) (start|begin|try|do|say|go|take) (that|this|it)? ?(over|again|one more time|from the top|from the beginning)\b/, type: "restart", weight: 0.9, scope: "before" },
    { re: /\b(start|begin)(ing)? (over|again)\b|\bfrom the top\b|\btake (two|2|three|3)\b|\bone more time\b/, type: "restart", weight: 0.8, scope: "before" },
    { re: /\b(let me|lemme|can i|i('ll| will| need to| wanna)) (redo|re-do|rephrase|reword|rerecord|re-record|restart|re-start) (that|this|it)?\b/, type: "restart", weight: 0.9, scope: "before" },
    { re: /\b(let me|lemme) (back up|go back)\b|\bthat came out wrong\b|\bi (messed|screwed|botched|flubbed) (that|it) up\b|\bi flubbed\b/, type: "restart", weight: 0.7, scope: "before" },
    { re: /\b(pick ?up|pickup) (from|at) \b/, type: "restart", weight: 0.6, scope: "before" },
    // Off the record
    { re: /\boff the record\b|\bbetween (us|you and me)\b|\bdon't (record|air) this\b|\bthis is(n't| not) (for|going on) (the )?(record|air|show|episode)\b/, type: "off-record", weight: 0.85, scope: "after" },
    // Interruptions: phones, alarms, someone at the door (whole interruption gets cut, not just the words)
    { re: /\b(silence|silencing|mute|muting|turn(ing)? off|switch(ing)? off|shut(ting)? off|turn(ing)? down|put(ting)?|stop(ping)?|decline|declining|ignore|ignoring|get(ting)? rid of)\b[^.?!]{0,24}\b(phone|cell ?phone|cell|ringer|alarm|timer|watch|notifications?|ringtone)\b/, type: "interruption", weight: 0.85, scope: "interruption" },
    { re: /\b(phone|cell ?phone|cell|alarm|timer|watch|ringtone)\b[^.?!]{0,20}\b(ring|rings|ringing|rang|going off|goes off|went off|buzz|buzzes|buzzing|beep|beeps|beeping|vibrat\w*|blowing up|on silent|on mute|on do not disturb|on airplane mode)\b/, type: "interruption", weight: 0.8, scope: "interruption" },
    { re: /\b(that'?s|that is|it'?s|sorry,? (that'?s|my|about (my|the)))\s*(my|his|her|your|the|someone'?s)?\s*(phone|alarm|timer|cell)\b/, type: "interruption", weight: 0.75, scope: "interruption" },
    { re: /\b(phone|ringing|ringtone|buzzing|beeping|alarm|knock(ing)?|doorbell|notification)\b/, type: "interruption", weight: 0.7, scope: "interruption", soundOnly: true },
    { re: /\b(put(ting)? (it|this|that|my phone|the phone|mine) (in|on) |turn(ing)? on )?(airplane mode|do not disturb)\b/, type: "interruption", weight: 0.7, scope: "interruption" },
    { re: /\b(someone'?s|somebody'?s) at the door\b|\bi (have|need) to (take|get) this\b|\b(let me|i'?ll|lemme) (just )?(get|grab|take) (that|this)\b/, type: "interruption", weight: 0.65, scope: "interruption" },
    // Weak signals: technical interruptions
    { re: /\b(hold on|hang on|wait wait|one sec(ond)?|give me a (sec|second|minute))\b/, type: "interruption", weight: 0.45, scope: "around" },
    { re: /\b(where was i|lost my (train of thought|place)|what was i saying)\b/, type: "interruption", weight: 0.55, scope: "before" },
    { re: /\b(is (it|this|the mic|the camera|everything) (still )?(recording|rolling|on)|are we (still )?(recording|rolling)|we('re| are) (back|rolling|recording)( again)?|(mic|camera|audio) (check|died|dropped|cut out))\b/, type: "technical", weight: 0.6, scope: "around" }
  ];
  var BACK_ON = /\b(back on the record|on the record (again|now)|ok(ay)? we('re| are) back|we('re| are) back)\b/;

  function normalize(text) {
    return String(text).toLowerCase().replace(/[’']/g, "'").replace(/[^a-z0-9' ]+/g, " ").replace(/\s+/g, " ").trim();
  }
  function words(text) { return normalize(text).split(" ").filter(Boolean); }
  var FILLER = { um: 1, uh: 1, uhm: 1, er: 1, ah: 1, like: 1, so: 1, well: 1, okay: 1, ok: 1, and: 1, but: 1, yeah: 1, i: 0 };
  function contentWords(text) { return words(text).filter(function (w) { return !FILLER[w]; }); }

  // ------------------------------------------------------------ analysis

  var DEFAULTS = {
    pauseSec: 1.2,          // a gap this long marks where a botched passage most likely began
    maxLookbackSec: 40,     // never reach further back than this from a cue
    minLookbackSec: 2.0,    // always take at least this much before a cue
    padSec: 0.15,           // breathing room around suggested ranges
    falseStartWords: 3,     // matching opening words needed to call a restart
    falseStartWindowSec: 25,
    minConfidence: 0.4,
    offRecordMaxSec: 600,
    backChainSec: 45,       // after a cut cue, "okay, we're back" must come within this of the last cut/back phrase
    backMaxSec: 240         // and within this of the first cue
  };

  /**
   * analyze(segments, opts) -> { suggestions: [...], segments }
   * Each suggestion: { id, startSec, endSec, type, confidence, reason, trigger, text, speaker }
   */
  function analyze(segments, opts) {
    var o = {};
    for (var k in DEFAULTS) o[k] = DEFAULTS[k];
    for (k in (opts || {})) if (opts[k] !== undefined) o[k] = opts[k];
    var segs = (segments || []).slice().sort(function (a, b) { return a.startSec - b.startSec; });
    var out = [];

    segs.forEach(function (sg, i) {
      var norm = normalize(sg.text);
      for (var c = 0; c < CUES.length; c++) {
        var cue = CUES[c];
        if (cue.soundOnly && !sg.sound) continue;
        var m = cue.raw ? cue.raw.exec(sg.text) : cue.re.exec(norm);
        if (!m) continue;
        var cueTime = cue.raw ? cueTimeInSegment(sg, Math.round(m.index / Math.max(1, sg.text.length) * norm.length), norm.length)
          : cueTimeInSegment(sg, m.index, norm.length);
        var sug;
        if (cue.scope === "after") sug = offRecordRange(segs, i, cueTime, o);
        else if (cue.scope === "around") sug = aroundRange(segs, i, cueTime);
        else if (cue.scope === "interruption") sug = interruptionRange(segs, i, o);
        else sug = beforeRange(segs, i, cueTime, o);
        sug.type = cue.type;
        sug.trigger = m[0];
        sug.confidence = cue.weight;
        // Phrases at the very end of a segment (a pause follows) are more likely real instructions.
        if (m.index + m[0].length >= norm.length - 3) sug.confidence = Math.min(1, sug.confidence + 0.05);
        // "cut" said mid-story ("they cut the budget") is filtered by the regexes; questions lower confidence.
        if (/\?\s*$/.test(sg.text) && cue.type === "edit-cue") sug.confidence -= 0.1;
        sug.speaker = sg.speaker || null;
        sug.reason = describe(cue.type, m[0].replace(/^[.!?\s]+/, "").trim());
        // "Let's cut this part" often starts a tangent they abandon: run on to where they say they're back.
        if (cue.type === "edit-cue") {
          var back = returnPoint(segs, i, cueTime.start, o);
          if (back && back.endSec > sug.endSec) {
            sug.endSec = back.endSec; sug.review = "both"; sug.confidence += 0.03;
            sug.reason += " \u2026 back at: \u201c" + back.trigger + "\u201d";
          }
        }
        out.push(sug);
        break; // one cue per segment is enough
      }
    });

    falseStarts(segs, o).forEach(function (s) { out.push(s); });
    showEdges(segs, o).forEach(function (s) { out.push(s); });

    var merged = mergeSuggestions(out.filter(function (s) { return s.confidence >= o.minConfidence; }));
    merged.forEach(function (s, idx) {
      s.id = "cut" + (idx + 1);
      s.startSec = Math.max(0, round2(s.startSec - o.padSec));
      s.endSec = round2(s.endSec + o.padSec);
      s.confidence = round2(Math.max(0, Math.min(1, s.confidence)));
      s.text = textBetween(segs, s.startSec, s.endSec);
    });
    return { suggestions: merged, segments: segs };
  }

  function cueTimeInSegment(sg, charIndex, len) {
    if (sg.words && sg.words.length) {
      // Find the word whose cumulative character position covers charIndex.
      var pos = 0;
      for (var w = 0; w < sg.words.length; w++) {
        pos += normalize(sg.words[w].text).length + 1;
        if (pos > charIndex) return { start: sg.words[w].startSec, end: sg.words[Math.min(sg.words.length - 1, w + 3)].endSec };
      }
    }
    var frac = len ? charIndex / len : 0;
    var t = sg.startSec + (sg.endSec - sg.startSec) * frac;
    return { start: t, end: sg.endSec };
  }

  /**
   * The mistake comes before the cue: reach back sentence by sentence to the last real pause, a change of
   * speaker, or the show's opening/sign-off line. Usually that's a sentence or two (about 8 s); when the cue
   * calls out a whole stretch ("cut this part, it's going everywhere") it may reach back maxLookbackSec.
   */
  var TANGENT = /\b(this|that|the) (whole )?(part|section|stretch|conversation|discussion|tangent|segment)\b|\bgoing (everywhere|all over)\b|\btangent\b|\brabbit (trail|hole)\b|\boff (topic|track)\b/;
  function beforeRange(segs, i, cueTime, o) {
    var list = [];
    for (var k = 0; k <= i; k++) sentences(segs[k]).forEach(function (st) { list.push({ st: st, seg: segs[k] }); });
    var c = list.length - 1;
    while (c > 0 && list[c].st.startSec > cueTime.start + 0.01) c--;
    var cueSt = list[c].st, sg = segs[i];
    var near = cueSt.norm + " " + ((list[c + 1] && list[c + 1].st.norm) || "") + " " + (sentenceStream(segs, i, cueSt.endSec)[0] || { norm: "" }).norm;
    var limit = TANGENT.test(near) ? o.maxLookbackSec : o.minLookbackSec * 4;
    var cueAtStart = cueTime.start - cueSt.startSec < 0.6;
    var start = cueSt.startSec, taken = 0;
    for (var j = c - 1; j >= 0; j--) {
      var prev = list[j], next = list[j + 1];
      if (next.st.startSec - prev.st.endSec >= o.pauseSec) break;
      if (prev.seg.speaker && sg.speaker && prev.seg.speaker !== sg.speaker && prev.seg.speaker !== "Unknown") break;
      if (INTRO.test(prev.st.norm) || OUTRO.test(prev.st.norm)) break;
      if (cueTime.start - prev.st.startSec > limit && !(cueAtStart && taken === 0)) break;
      start = prev.st.startSec; taken++;
    }
    if (cueTime.start - start < o.minLookbackSec && taken === 0 && c > 0 &&
        !INTRO.test(list[c - 1].st.norm) && !OUTRO.test(list[c - 1].st.norm)) start = Math.max(list[c - 1].st.startSec, cueTime.start - o.minLookbackSec);
    var end = Math.max(cueTime.end, cueSt.endSec);
    if (sg.words || sg.endSec - sg.startSec <= 8) end = Math.max(end, sg.endSec);
    return { startSec: start, endSec: end, review: "start" };
  }

  function offRecordRange(segs, i, cueTime, o) {
    var start = segs[i].startSec;
    var end = segs[i].endSec;
    for (var j = i + 1; j < segs.length; j++) {
      if (segs[j].startSec - start > o.offRecordMaxSec) break;
      end = segs[j].endSec;
      if (BACK_ON.test(normalize(segs[j].text))) break;
      if (j + 1 < segs.length && segs[j + 1].startSec - segs[j].endSec > 3) break;
    }
    return { startSec: start, endSec: end, review: "end" };
  }

  /**
   * An interruption (phone, alarm, door): from where the conversation broke off (the last real pause, at most
   * ~10 s back) to where it resumes, swallowing the short "sorry / okay / where were we" lines that follow.
   */
  var RESUME = /^(sorry|okay|ok|alright|all right|anyway|so|where (were|was) (we|i)|go ahead|carry on|continue|we'?re (good|back)|done|got it|there we go|that'?s better|yeah|um|uh)\b/;
  function interruptionRange(segs, i, o) {
    var sg = segs[i], start = sg.startSec, j = i;
    while (j > 0 && sg.startSec - segs[j - 1].startSec <= 10 && segs[j].startSec - segs[j - 1].endSec < o.pauseSec &&
           (segs[j - 1].sound || words(segs[j - 1].text).length <= 6)) { j--; start = segs[j].startSec; }
    var end = sg.endSec;
    for (var k = i + 1; k < segs.length && segs[k].startSec - sg.endSec <= 25; k++) {
      var t = normalize(segs[k].text);
      var n = words(segs[k].text).length;
      // Short "okay, sorry" lines belong to the interruption; a resumption with real content ("Anyway, the Aeneid...") doesn't.
      if (segs[k].sound || (n <= 4 && RESUME.test(t)) || (n <= 10 && /phone|alarm|silent|ringer|sorry about that/.test(t))) end = segs[k].endSec;
      else break;
    }
    return { startSec: start, endSec: end, review: "both" };
  }

  /** Just the sentence the cue is in (long transcript blocks hold many sentences and often several speakers). */
  function aroundRange(segs, i, cueTime) {
    var sg = segs[i];
    if (sg.endSec - sg.startSec <= 8 || !cueTime) return { startSec: sg.startSec, endSec: sg.endSec, review: "both" };
    var hit = null;
    sentences(sg).forEach(function (st) { if (!hit && st.endSec > cueTime.start + 0.01) hit = st; });
    hit = hit || { startSec: sg.startSec, endSec: sg.endSec };
    return { startSec: hit.startSec, endSec: hit.endSec, review: "both" };
  }

  // -------------------------------------------------- sentence timing

  /**
   * Sentences of a segment with estimated times. Uses word timestamps when present, otherwise spreads the
   * segment's time over its words (Premiere's transcript export gives one timecode per ~20 s block).
   */
  function sentences(sg) {
    if (sg._sentences) return sg._sentences;
    var parts = String(sg.text).match(/[^.!?]+[.!?]*/g) || [sg.text];
    var total = 0;
    parts.forEach(function (p) { total += words(p).length; });
    total = total || 1;
    var dur = sg.endSec - sg.startSec, acc = 0, out = [];
    var W = sg.words && sg.words.length ? sg.words : null;
    parts.forEach(function (p) {
      var n = words(p).length;
      if (!n) return;
      var a, b;
      if (W) {
        a = W[Math.min(W.length - 1, Math.round(acc * W.length / total))].startSec;
        b = W[Math.min(W.length - 1, Math.round((acc + n) * W.length / total) - 1)].endSec;
      } else { a = sg.startSec + dur * acc / total; b = sg.startSec + dur * (acc + n) / total; }
      acc += n;
      out.push({ text: p.trim(), norm: normalize(p), n: n, startSec: a, endSec: Math.max(a, b) });
    });
    Object.defineProperty ? Object.defineProperty(sg, "_sentences", { value: out, enumerable: false, configurable: true }) : (sg._sentences = out);
    return out;
  }
  function sentenceStream(segs, from, fromSec) {
    var list = [];
    for (var i = from; i < segs.length; i++) sentences(segs[i]).forEach(function (st) { if (st.startSec >= fromSec - 0.01) list.push(st); });
    return list;
  }

  // "Okay, bring it back", "get us back on track", "okay, we're back": the tangent is over.
  var BACK = /\b(bring(ing)? (it|us|this) back|back on track|get(ting)? (us|it|this) back|let'?s go back( now)?$|let'?s get back|ok(ay)? we'?re back|we'?re back( now)?$|where were we|back to (the|our) (topic|question|list|show|episode|conversation)|let'?s (move|keep) (on|going) (from|past) (that|this))\b/;
  var OFF_RECORD = /\boff the record\b|\bdon't (record|air) this\b/;
  var CUT_AGAIN = /\b(cut|edit|strike|delete|remove|chop|trim)\s+(it|that|this)\b|\bnot (going )?in the (show|episode)\b/;

  /**
   * After a cut cue, look ahead for where they come back. Each cut/back phrase must come within backChainSec of
   * the last one; the cut ends after the last "we're back" sentence and any one- to three-word lines right after it.
   */
  function returnPoint(segs, i, fromSec, o) {
    var list = sentenceStream(segs, i, fromSec), last = fromSec, found = null;
    for (var k = 0; k < list.length; k++) {
      var st = list[k];
      if (st.startSec - last > o.backChainSec || st.startSec - fromSec > o.backMaxSec) break;
      if (OFF_RECORD.test(st.norm)) break; // a separate off-the-record stretch has its own "we're back"

      if (BACK.test(st.norm)) { found = { endSec: st.endSec, trigger: st.text.replace(/[.!?]+$/, ""), k: k }; last = st.startSec; }
      else if (CUT_AGAIN.test(st.norm)) last = st.startSec;
    }
    if (!found) return null;
    for (var j = found.k + 1; j < list.length && list[j].n <= 3 && list[j].startSec - found.endSec < 2; j++) found.endSec = list[j].endSec;
    return found;
  }

  // ----------------------------------------------- pre- and post-show

  var INTRO = /\b((hello|hi|hey|good (morning|afternoon|evening))( everyone| everybody| all)?( and)? )?welcome (back )?to (another|the|this|our|today'?s|episode|part)\b/;
  var OUTRO = /\b(thank(s| you)( all| everyone| everybody| so much)? for (joining|listening|watching)|(we'?ll|we will) (see|be back|talk to)( with)?( you| y'?all)? (next time|next week|soon)|see you next (time|week)|until next time)\b/;

  /** Chatter before the opening line and after the sign-off. */
  function showEdges(segs, o) {
    var res = [];
    if (!segs.length) return res;
    var endT = segs[segs.length - 1].endSec, all = sentenceStream(segs, 0, 0);
    for (var k = 0; k < all.length && all[k].startSec < endT * 0.3; k++) {
      if (all[k].startSec > 30 && INTRO.test(all[k].norm)) {
        res.push({ startSec: segs[0].startSec, endSec: all[k].startSec - o.padSec * 2, type: "pre-show", confidence: 0.7, review: "end",
          trigger: all[k].text, reason: "Before the show opens: \u201c" + all[k].text.slice(0, 40) + "\u201d" });
        break;
      }
    }
    for (k = all.length - 1; k >= 0 && all[k].startSec > endT * 0.7; k--) {
      if (!OUTRO.test(all[k].norm)) continue;
      // The run of talk after the sign-off, up to the next real gap in the recording.
      var tail = [], prevEnd = all[k].endSec;
      for (var j = k + 1; j < all.length; j++) {
        if (all[j].startSec - prevEnd > 3) break;
        tail.push(all[j]); prevEnd = all[j].endSec;
      }
      var n = 0; tail.forEach(function (t) { n += t.n; });
      if (!tail.length || tail.some(function (t) { return OUTRO.test(t.norm); }) || n > 60 || prevEnd - all[k].endSec > 40) continue;
      res.push({ startSec: all[k].endSec, endSec: prevEnd, type: "post-show", confidence: 0.65, review: "start",
        trigger: all[k].text, reason: "After the sign-off: \u201c" + all[k].text.slice(0, 40) + "\u201d" });
      break;
    }
    return res;
  }

  /** "So the thing about — so the thing about budgets is..." -> cut the first attempt. */
  function falseStarts(segs, o) {
    var res = [];
    var N = o.falseStartWords;
    for (var i = 0; i < segs.length; i++) {
      var a = contentWords(segs[i].text);
      if (a.length < N) continue;
      var head = a.slice(0, N).join(" ");
      for (var j = i + 1; j < segs.length && segs[j].startSec - segs[i].startSec <= o.falseStartWindowSec; j++) {
        if (segs[i].speaker && segs[j].speaker && segs[i].speaker !== segs[j].speaker) continue;
        var b = contentWords(segs[j].text);
        if (b.length < N || b.slice(0, N).join(" ") !== head) continue;
        // Attempt i should be shorter / abandoned; if both are long, it's probably a repeated phrase.
        var abandoned = a.length <= b.length + 2 || /(—|--|\.\.\.|-)\s*$/.test(segs[i].text);
        var conf = 0.5 + Math.min(0.3, 0.06 * (commonPrefix(a, b) - N)) + (abandoned ? 0.1 : -0.2);
        if (segs[j].startSec - segs[i].endSec < 4) conf += 0.05;
        res.push({ startSec: segs[i].startSec, endSec: segs[j].startSec, type: "false-start",
          confidence: conf, trigger: head, speaker: segs[i].speaker || null, review: "end",
          reason: "Restarted with the same words (\"" + head + "…\")" });
        break;
      }
    }
    return res;
  }
  function commonPrefix(a, b) { var n = 0; while (n < a.length && n < b.length && a[n] === b[n]) n++; return n; }

  var LABELS = {
    "edit-cue": "Asked to cut", restart: "Restart / retake", "off-record": "Off the record",
    bleep: "Bleep requested", interruption: "Interruption (phone, alarm\u2026)", technical: "Technical chatter", "false-start": "False start",
    "pre-show": "Pre-show chatter", "post-show": "Post-show chatter"
  };
  function describe(type, phrase) { return (LABELS[type] || type) + ": “" + phrase + "”"; }

  function mergeSuggestions(list) {
    list.sort(function (a, b) { return a.startSec - b.startSec; });
    var out = [];
    list.forEach(function (s) {
      var last = out[out.length - 1];
      if (last && s.startSec <= last.endSec + 0.5) {
        last.endSec = Math.max(last.endSec, s.endSec);
        if (s.confidence > last.confidence) { last.type = s.type; last.trigger = s.trigger; last.reason = s.reason; }
        last.confidence = Math.max(last.confidence, s.confidence) + 0.05; // corroborated
        last.reasons = (last.reasons || [last.reason]).concat([s.reason]);
      } else out.push(s);
    });
    return out;
  }

  function textBetween(segs, a, b) {
    return segs.filter(function (s) { return s.endSec > a && s.startSec < b; })
      .map(function (s) { return (s.speaker ? s.speaker + ": " : "") + s.text; }).join(" ").slice(0, 600);
  }
  function round2(v) { return Math.round(v * 100) / 100; }

  /** Attribute speakers using mic activity runs from the multicam engine (for transcripts without labels). */
  function assignSpeakers(segs, speechRuns) {
    return segs.map(function (s) {
      if (s.speaker) return s;
      var best = null, bestOv = 0;
      (speechRuns || []).forEach(function (sr) {
        var ov = 0;
        sr.runs.forEach(function (r) { ov += Math.max(0, Math.min(r[1], s.endSec) - Math.max(r[0], s.startSec)); });
        if (ov > bestOv) { bestOv = ov; best = sr.speakerId; }
      });
      var c = {}; for (var k in s) c[k] = s[k];
      c.speaker = best;
      return c;
    });
  }

  function toCsv(suggestions) {
    var rows = [["id", "start", "end", "duration", "type", "confidence", "reason", "text"]];
    suggestions.forEach(function (s) {
      rows.push([s.id, fmt(s.startSec), fmt(s.endSec), (s.endSec - s.startSec).toFixed(2), s.type, s.confidence, s.reason, s.text]);
    });
    return rows.map(function (r) { return r.map(function (v) { return '"' + String(v).replace(/"/g, '""') + '"'; }).join(","); }).join("\n");
  }
  function fmt(sec) {
    var h = Math.floor(sec / 3600), m = Math.floor(sec / 60) % 60, s = sec % 60;
    return (h ? h + ":" : "") + (m < 10 && h ? "0" : "") + m + ":" + (s < 10 ? "0" : "") + s.toFixed(2);
  }

  return { isSound: isSound, parse: parse, analyze: analyze, assignSpeakers: assignSpeakers, toCsv: toCsv, formatTime: fmt, DEFAULTS: DEFAULTS, CUES: CUES };
});
