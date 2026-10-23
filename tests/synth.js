// Synthetic podcast curves for tests: speech with syllable gaps, bleed, noise floor.
"use strict";

function makeCurves(script, opts) {
  opts = opts || {};
  const hop = opts.hopSec || 0.025;
  const duration = opts.durationSec || Math.max.apply(null, script.map((s) => s[2])) + 2;
  const frames = Math.ceil(duration / hop);
  const ids = opts.speakers || ["A", "B"];
  const gain = opts.gain || {}; // per-mic gain offset in dB
  const bleedDb = opts.bleedDb === undefined ? -18 : opts.bleedDb;
  let seed = 12345;
  const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const speech = {};
  ids.forEach((id) => (speech[id] = new Float32Array(frames).fill(-120)));
  // script: [speakerId, startSec, endSec, levelDb?]
  script.forEach(([id, a, b, level]) => {
    const lv = level === undefined ? -18 : level;
    for (let t = Math.round(a / hop); t < Math.min(frames, Math.round(b / hop)); t++) {
      const syll = Math.sin((t * hop) * 2 * Math.PI * 4) > -0.6; // short dips between syllables
      speech[id][t] = Math.max(speech[id][t], syll ? lv + (rand() - 0.5) * 6 : lv - 25);
    }
  });
  const curves = {};
  ids.forEach((id) => {
    const c = new Array(frames);
    for (let t = 0; t < frames; t++) {
      let p = Math.pow(10, (-62 + (rand() - 0.5) * 4) / 10); // noise floor
      ids.forEach((other) => {
        const lv = speech[other][t];
        if (lv <= -100) return;
        p += Math.pow(10, (lv + (other === id ? 0 : bleedDb)) / 10);
      });
      c[t] = 10 * Math.log10(p) + (gain[id] || 0);
    }
    curves[id] = c;
  });
  return { durationSec: duration, hopSec: hop, fps: 30, curves };
}

module.exports = { makeCurves };
