/* Demo data so the panel can be explored outside Premiere (and for screenshots/tests). */
(function () {
  var DUR = 360;
  function sequence() {
    function at(i, name) { return { index: i, name: name, muted: false, clips: [{ name: name + ".wav", startSec: 0, endSec: DUR, inPointSec: 0, mediaPath: "/demo/" + name + ".wav", speed: 1 }] }; }
    return {
      name: "Demo Episode 42", sequenceID: "demo", fps: 29.97, ticksPerFrame: "8475667200", durationSec: DUR,
      audioTracks: [at(0, "Host mic"), at(1, "Cohost mic"), at(2, "Guest mic")],
      videoTracks: [
        { index: 0, name: "Wide", clipCount: 1, firstClip: "CAM_WIDE.mp4", endSec: DUR, mediaPaths: ["/demo/wide.mp4"] },
        { index: 1, name: "Host CU", clipCount: 1, firstClip: "CAM_A.mp4", endSec: DUR, mediaPaths: ["/demo/a.mp4"] },
        { index: 2, name: "Cohost CU", clipCount: 1, firstClip: "CAM_B.mp4", endSec: DUR, mediaPaths: ["/demo/b.mp4"] },
        { index: 3, name: "Guest CU", clipCount: 1, firstClip: "CAM_C.mp4", endSec: DUR, mediaPaths: ["/demo/c.mp4"] }
      ]
    };
  }

  function script() {
    // [speakerIndex, start, end]
    var s = [], t = 2, seed = 9;
    function r() { seed = (seed * 16807) % 2147483647; return seed / 2147483647; }
    var who = 0;
    while (t < DUR - 5) {
      var len = who === 2 ? 8 + r() * 30 : 3 + r() * 14;
      s.push([who, t, Math.min(DUR - 3, t + len)]);
      // interjections from listeners
      for (var k = 0; k < 3; k++) if (r() < 0.35 && len > 6) {
        var o = (who + 1 + Math.floor(r() * 2)) % 3, a = t + 2 + r() * (len - 4);
        s.push([o, a, a + 0.4 + r() * 0.6]);
      }
      // occasional crosstalk
      if (r() < 0.15) { var o2 = (who + 1) % 3; s.push([o2, t + len - 1.5, t + len + 1]); }
      t += len + (r() < 0.12 ? 3.5 + r() * 3 : 0.2 + r() * 0.8);
      who = r() < 0.5 ? (who + 1) % 3 : (who + 2) % 3;
    }
    return s;
  }

  function curves(seq, config, hop) {
    var frames = Math.ceil(DUR / hop), lines = script(), seed = 3;
    function r() { seed = (seed * 16807) % 2147483647; return seed / 2147483647; }
    var speech = [0, 1, 2].map(function () { var a = new Float32Array(frames); a.fill(-120); return a; });
    var gains = [-16, -20, -14];
    lines.forEach(function (l) {
      for (var f = Math.round(l[1] / hop); f < Math.min(frames, Math.round(l[2] / hop)); f++) {
        var syll = Math.sin(f * hop * 2 * Math.PI * (3.5 + l[0] * 0.4)) > -0.5;
        speech[l[0]][f] = Math.max(speech[l[0]][f], syll ? gains[l[0]] + (r() - 0.5) * 8 : gains[l[0]] - 24);
      }
    });
    var out = {};
    config.speakers.forEach(function (sp) {
      var k = sp.audioTrack + ":" + (sp.channel === null || sp.channel === undefined ? "mix" : sp.channel);
      var c = new Float32Array(frames);
      for (var f = 0; f < frames; f++) {
        var p = Math.pow(10, (-60 + (r() - 0.5) * 5) / 10);
        for (var o = 0; o < 3; o++) if (speech[o][f] > -100) p += Math.pow(10, (speech[o][f] + (o === sp.audioTrack ? 0 : -19)) / 10);
        c[f] = 10 * Math.log10(p);
      }
      out[k] = c;
    });
    return out;
  }

  function transcript() {
    return [
      { startSec: 3, endSec: 7, text: "Welcome back to the show, everybody." },
      { startSec: 41.2, endSec: 44, text: "So the thing about the new curriculum is that it" },
      { startSec: 44.3, endSec: 46, text: "sorry, let me start that over." },
      { startSec: 46.8, endSec: 52, text: "So the thing about the new curriculum is that it actually starts with Latin." },
      { startSec: 120, endSec: 125, text: "And frankly the publisher's rep was a complete disaster to deal with." },
      { startSec: 125.2, endSec: 127.5, text: "Actually, cut that out, we can't air that." },
      { startSec: 210, endSec: 214, text: "This is off the record, but we're launching a new course next fall." },
      { startSec: 214.3, endSec: 219, text: "Nobody knows yet, so keep it quiet." },
      { startSec: 219.6, endSec: 221, text: "Okay, we're back." },
      { startSec: 300, endSec: 303, text: "Hold on, is the camera still recording?" }
    ];
  }

  window.PD_DEMO = { sequence: sequence, curves: curves, transcript: transcript };
})();
