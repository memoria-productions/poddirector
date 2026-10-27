/* Demo data so the panel can be explored outside Premiere (and for screenshots/tests). */
(function () {
  var DUR = 360;
  function sequence() {
    // VOX tracks are the channels of one multichannel recorder file, like a camera with an XLR adapter.
    function at(i, name) {
      var media = /^VOX/.test(name) ? "/demo/recorder-4ch.wav" : "/demo/" + name + ".wav";
      var clips = [{ name: name + ".wav", startSec: 0, endSec: DUR - 20, inPointSec: 0, mediaPath: media, speed: 1 }];
      if (/^VOX/.test(name)) clips.push({ name: "outro_" + name + ".wav", startSec: DUR - 20, endSec: DUR, inPointSec: 0, mediaPath: "/demo/outro-" + name + ".wav", speed: 1 });
      return { index: i, name: name, muted: false, clips: clips };
    }
    return {
      name: "Demo Episode 42", sequenceID: "demo", fps: 29.97, ticksPerFrame: "8475667200", durationSec: DUR, inSec: 8, outSec: DUR - 22,
      audioTracks: [at(0, "VOX1"), at(1, "VOX2"), at(2, "VOX3"), at(3, "SFX"), at(4, "Music")],
      videoTracks: [
        { index: 0, name: "Wide", clipCount: 1, firstClip: "CAM_WIDE.mp4", endSec: DUR, mediaPaths: ["/demo/wide.mp4"] },
        { index: 1, name: "Dolly", clipCount: 1, firstClip: "CAM_DOLLY.mp4", endSec: DUR, mediaPaths: ["/demo/dolly.mp4"] }
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
      var k = sp.audioTrack + ":" + (sp.channel === null || sp.channel === undefined ? "mix" : sp.channel) + (sp.channelManual ? "m" : "a");
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

  /**
   * An operated dolly: after someone starts talking the operator moves to them (1-2 s late, a 1.5 s move);
   * now and then they hold on a listener instead. Returns motion + colour thumbnails of who's in frame.
   */
  var LOOKS = [[[50, 70, 170], [215, 175, 150]], [[175, 45, 55], [205, 165, 140]], [[60, 150, 80], [190, 150, 125]]];
  function motion(seq, track) {
    var hop = 1 / 6, n = Math.ceil(DUR / hop), v = new Float32Array(n), seed = 11 + track;
    function r() { seed = (seed * 16807) % 2147483647; return seed / 2147483647; }
    for (var i = 0; i < n; i++) v[i] = r() * 0.5;
    var on = new Int8Array(DUR).fill(0), lines = script().filter(function (l) { return l[2] - l[1] > 4; }), cur = 0;
    lines.forEach(function (l) {
      var who = r() < 0.15 ? (l[0] + 1) % 3 : l[0]; // sometimes the operator holds on a listener
      if (who === cur) return;
      var a = l[1] + 1 + r(), b = a + 1.5;
      for (i = Math.round(a / hop); i < Math.min(n, Math.round(b / hop)); i++) v[i] = 9 + r() * 6;
      for (var sec = Math.ceil(b); sec < DUR; sec++) on[sec] = who;
      cur = who;
    });
    var W = 32, H = 18, size = W * H * 3, data = new Uint8Array(DUR * size), valid = new Uint8Array(DUR).fill(1);
    for (var sec2 = 0; sec2 < DUR; sec2++) {
      var look = LOOKS[on[sec2]], jit = sec2 % 3 - 1;
      for (var y = 0; y < H; y++) for (var x = 0; x < W; x++) {
        var k = sec2 * size + (y * W + x) * 3, c = (x > 9 + jit && x < 23 + jit) ? (y < 7 ? look[1] : look[0]) : [92, 86, 80];
        data[k] = c[0]; data[k + 1] = c[1]; data[k + 2] = c[2];
      }
    }
    return { hopSec: hop, values: v, thumbs: { w: W, h: H, hopSec: 1, data: data, valid: valid } };
  }

  window.PD_DEMO = { sequence: sequence, curves: curves, transcript: transcript, motion: motion };
})();
