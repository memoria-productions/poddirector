#!/usr/bin/env node
// CI smoke test: run the *installed* extension's bundled ffmpeg + whisper on a speech sample.
//   PD_EXT=<installed extension folder> node scripts/smoke-test.js sample.wav
"use strict";
const path = require("path");
const ext = process.env.PD_EXT || path.resolve(__dirname, "..");
const A = require(path.join(ext, "engine", "analyzer.js"));
const W = require(path.join(ext, "engine", "transcriber.js"));
const T = require(path.join(ext, "engine", "transcript.js"));
const wav = path.resolve(process.argv[2]);

(async () => {
  const f = await A.findFfmpeg({ extensionRoot: ext });
  if (!f.ok) throw new Error("ffmpeg: " + f.error + " tried " + f.tried);
  console.log("ffmpeg:", f.path);
  const curve = await A.analyzeTrack({ clips: [{ startSec: 2, endSec: 13, inPointSec: 0, mediaPath: wav }] }, 15, {});
  const loud = Array.from(curve).filter((v) => v > -40).length * A.DEFAULT_HOP;
  console.log("speech seconds above -40 dB:", loud.toFixed(1));
  if (loud < 5) throw new Error("waveform analysis looks wrong");

  const w = W.locate({ extensionRoot: ext });
  if (!w.ok) throw new Error(w.error);
  console.log("whisper:", w.whisper, "model:", path.basename(w.model));
  const t0 = Date.now();
  const segs = await W.transcribeTimeline({ ffmpegPath: f.path, durationSec: 15,
    clips: [{ mediaPath: wav, startSec: 2, endSec: 13, inPointSec: 0 }] });
  console.log("transcribed in", ((Date.now() - t0) / 1000).toFixed(1) + "s");
  segs.forEach((s) => console.log(`  [${s.startSec.toFixed(2)}-${s.endSec.toFixed(2)}] ${s.text}`));
  const text = segs.map((s) => s.text).join(" ").toLowerCase();
  if (!/ask not what your country/.test(text)) throw new Error("unexpected transcript");
  if (segs[0].startSec < 1.8 || segs[0].startSec > 3) throw new Error("timestamps not aligned to sequence time");
  console.log("cleanup scan:", T.analyze(segs).suggestions.length, "suggestions (expected 0)");
  console.log("SMOKE TEST PASSED");
})().catch((e) => { console.error("SMOKE TEST FAILED:", e.message); process.exit(1); });
