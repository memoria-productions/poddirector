#!/usr/bin/env node
// CI smoke test: run the *installed* extension's bundled ffmpeg + whisper on a speech sample.
//   PD_EXT=<installed extension folder> node scripts/smoke-test.js sample.wav
"use strict";
const path = require("path");
const ext = process.env.PD_EXT || path.resolve(__dirname, "..");
const A = require(path.join(ext, "engine", "analyzer.js"));
const W = require(path.join(ext, "engine", "transcriber.js"));
const T = require(path.join(ext, "engine", "transcript.js"));
const M = require(path.join(ext, "engine", "motion.js"));
const cp = require("child_process");
const os = require("os");
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

  // Camera-motion analysis with the bundled ffmpeg (video decode path). LGPL ffmpeg has no x264: use mpeg4.
  const vid = path.join(os.tmpdir(), "pd-smoke-pan.avi"), still = path.join(os.tmpdir(), "pd-smoke-still.png");
  cp.spawnSync(f.path, ["-loglevel", "error", "-y", "-f", "lavfi", "-i", "nullsrc=s=1920x1080,geq=lum='random(1)*255':cb=128:cr=128,gblur=sigma=4", "-frames:v", "1", still]);
  const g = cp.spawnSync(f.path, ["-loglevel", "error", "-y", "-loop", "1", "-framerate", "30", "-t", "6", "-i", still,
    "-vf", "crop=960:540:x='200+min(t,3)*150':y=200", "-c:v", "mpeg4", "-q:v", "3", vid]);
  if (g.status !== 0) throw new Error("could not make test video: " + g.stderr);
  const m = await M.analyzeTrack({ clips: [{ startSec: 0, endSec: 6, inPointSec: 0, mediaPath: vid }] }, 6, { ffmpegPath: f.path });
  const avg = (a, b) => { const v = Array.from(m.values.slice(Math.round(a / m.hopSec), Math.round(b / m.hopSec))).filter((x) => !isNaN(x)); return v.length ? v.reduce((s, x) => s + x, 0) / v.length : NaN; };
  console.log("camera motion while panning: " + avg(0.5, 2.5).toFixed(1) + " %/s, after: " + avg(3.5, 5.5).toFixed(1) + " %/s");
  if (!(avg(0.5, 2.5) > 6) || !(avg(3.5, 5.5) < 3)) throw new Error("camera motion analysis looks wrong");
  console.log("SMOKE TEST PASSED");
})().catch((e) => { console.error("SMOKE TEST FAILED:", e.message); process.exit(1); });
