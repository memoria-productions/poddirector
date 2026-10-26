"use strict";
// Integration tests that need ffmpeg on PATH (skipped otherwise).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const cp = require("child_process");
const A = require("../engine/analyzer.js");
const W = require("../engine/transcriber.js");
const T = require("../engine/transcript.js");
const D = require("../engine/director.js");
const M = require("../engine/motion.js");

const hasFfmpeg = cp.spawnSync("ffmpeg", ["-version"]).status === 0;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pd-test-"));
const wav = path.join(dir, "two-mics.wav");

test.before(() => {
  if (!hasFfmpeg) return;
  // Stereo file: ch0 = host talks 0-5s, ch1 = guest talks 5.5-11s, each with -34 dB bleed of the other.
  cp.spawnSync("ffmpeg", ["-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "sine=f=220:d=12,volume='if(lt(t,5),1,0.02)':eval=frame",
    "-f", "lavfi", "-i", "sine=f=330:d=12,volume='if(between(t,5.5,11),1,0.02)':eval=frame",
    "-filter_complex", "[0][1]amerge=inputs=2", "-ar", "48000", wav]);
});

test("analyzer reads per-channel loudness in sequence time", { skip: !hasFfmpeg }, async () => {
  const f = await A.findFfmpeg();
  assert.ok(f.ok);
  A.clearCache();
  const track = { clips: [{ startSec: 10, endSec: 22, inPointSec: 0, mediaPath: wav }] };
  const [host, guest] = await Promise.all([0, 1].map((ch) => A.analyzeTrack(track, 24, { channel: ch })));
  const v = (c, s) => c[Math.round(s / A.DEFAULT_HOP)];
  assert.ok(v(host, 12) > -30 && v(guest, 12) < -45, "host loud at 12s");
  assert.ok(v(guest, 18) > -30 && v(host, 18) < -45, "guest loud at 18s");
  assert.equal(v(host, 5), -120, "silence before the clip");
  // second read comes from cache and is identical
  const again = await A.analyzeTrack(track, 24, { channel: 0 });
  assert.deepEqual(Array.from(again), Array.from(host));
  // end-to-end: plan from real decoded audio
  const r = D.plan({ durationSec: 24, hopSec: A.DEFAULT_HOP, fps: 25, curves: { H: host, G: guest } }, {
    speakers: [{ id: "H", name: "Host" }, { id: "G", name: "Guest" }],
    cameras: [{ id: "c1", videoTrack: 0, shows: ["H"] }, { id: "c2", videoTrack: 1, shows: ["G"] }, { id: "w", videoTrack: 2, shows: ["H", "G"] }],
    style: { openOnWideSec: 0 }
  });
  const at = (t) => r.shots.find((s) => s.startSec <= t && s.endSec > t).cameraId;
  assert.equal(at(12), "c1");
  assert.equal(at(18), "c2");
});

test("transcriber renders a timeline mix at 16 kHz", { skip: !hasFfmpeg }, async () => {
  const out = path.join(dir, "mix.wav");
  await W.renderMix("ffmpeg", [
    { mediaPath: wav, startSec: 2, endSec: 8, inPointSec: 0, channel: 0 },
    { mediaPath: wav, startSec: 2, endSec: 14, inPointSec: 0, channel: 1 }
  ], 16, out);
  const probe = cp.spawnSync("ffprobe", ["-v", "error", "-show_entries", "stream=sample_rate,channels:format=duration", "-of", "json", out]);
  const info = JSON.parse(probe.stdout);
  assert.equal(info.streams[0].sample_rate, "16000");
  assert.equal(info.streams[0].channels, 1);
  assert.ok(Math.abs(+info.format.duration - 16) < 0.1);
});

test("transcript parser handles SRT, VTT and Premiere text exports", () => {
  const srt = fs.readFileSync(path.join(__dirname, "fixtures", "sample.srt"), "utf8");
  assert.equal(T.parse(srt).length, 12);
  const vtt = "WEBVTT\n\n00:00:01.000 --> 00:00:03.500\n<v Host>Hello there\n\n00:00:04.000 --> 00:00:06.000\nScratch that.\n";
  const v = T.parse(vtt);
  assert.equal(v.length, 2);
  assert.equal(v[1].startSec, 4);
  const pr = "00:00:01:15 - 00:00:04:00\nSpeaker 1\nSo let me start over.\n\n00:00:05:00 - 00:00:07:00\nSpeaker 2\nSure.\n";
  const p = T.parse(pr, { fps: 30 });
  assert.equal(p[0].speaker, "Speaker 1");
  assert.equal(p[0].startSec, 1.5);
  const whisper = JSON.stringify({ transcription: [{ offsets: { from: 1000, to: 2500 }, text: " cut that out" }] });
  assert.equal(T.parse(whisper)[0].endSec, 2.5);
});

test("transcript analyzer flags cues, restarts and off-the-record talk without false alarms", () => {
  const segs = T.parse(fs.readFileSync(path.join(__dirname, "fixtures", "sample.srt"), "utf8"));
  const r = T.analyze(segs);
  const types = r.suggestions.map((s) => s.type);
  assert.ok(types.includes("restart"));
  assert.ok(types.includes("edit-cue"));
  assert.ok(types.includes("off-record"));
  const insult = r.suggestions.find((s) => s.type === "edit-cue");
  assert.ok(insult.startSec <= 22 && insult.endSec >= 28, "cut covers the insult and the cue");
  assert.ok(!r.suggestions.some((s) => s.startSec < 19 && s.endSec > 17), "'they cut the art program' is not a cue");
  const restart = r.suggestions.find((s) => s.type === "restart");
  assert.ok(restart.startSec <= 6.2 && restart.endSec >= 10.8 && restart.endSec <= 11.8, "removes the first attempt only");
});

test("motion analyzer separates camera moves from people moving in frame", { skip: !hasFfmpeg }, async () => {
  const bg = path.join(dir, "bg.png"), subj = path.join(dir, "subj.png"), vid = path.join(dir, "dolly.mp4");
  cp.spawnSync("ffmpeg", ["-loglevel", "error", "-y", "-f", "lavfi", "-i",
    "nullsrc=s=1280x720,geq=lum='random(1)*255':cb=128:cr=128,gblur=sigma=5,eq=contrast=3", "-frames:v", "1", bg]);
  cp.spawnSync("ffmpeg", ["-loglevel", "error", "-y", "-f", "lavfi", "-i",
    "nullsrc=s=200x240,geq=lum='random(1)*255':cb=90:cr=170,gblur=sigma=3", "-frames:v", "1", subj]);
  // 0-3 s: camera still, "person" moving around; 3-5 s: fast pan; 5-6 s: slow drift; 6-9 s: still.
  const r = cp.spawnSync("ffmpeg", ["-loglevel", "error", "-y", "-loop", "1", "-framerate", "30", "-t", "9", "-i", bg,
    "-loop", "1", "-framerate", "30", "-t", "9", "-i", subj, "-filter_complex",
    "[0]crop=640:360:x='100+150*clip(t-3,0,2)+12*clip(t-5,0,1)':y=100[b];[b][1]overlay=x='if(lt(t,3),220+90*sin(t*4),220)':y=60[v]",
    "-map", "[v]", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", vid]);
  assert.equal(r.status, 0, String(r.stderr));
  const m = await M.analyzeTrack({ clips: [{ startSec: 0, endSec: 9, inPointSec: 0, mediaPath: vid }] }, 9, {});
  const avg = (a, b) => { const v = Array.from(m.values.slice(Math.round(a / m.hopSec), Math.round(b / m.hopSec))).filter((x) => !isNaN(x)); return v.reduce((s, x) => s + x, 0) / v.length; };
  assert.ok(avg(0.2, 2.8) < 1.2, "person moving, camera still: " + avg(0.2, 2.8));
  assert.ok(avg(3.3, 4.7) > 15, "fast pan: " + avg(3.3, 4.7));       // 150 px/s on 640 px = 23 %/s
  assert.ok(avg(5.2, 5.8) > 0.8 && avg(5.2, 5.8) < 6, "slow drift: " + avg(5.2, 5.8)); // 12 px/s = 1.9 %/s
  assert.ok(avg(6.3, 8.8) < 1.2, "still again: " + avg(6.3, 8.8));
});

test("identical frames never read as camera motion (incl. stripes / test patterns)", () => {
  const I = M._internal, W = M.W, H = M.H;
  let seed = 5; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const noise = new Uint8Array(W * H).map(() => rnd() * 255);
  const stripes = new Uint8Array(W * H).map((_, i) => ((i % W) >> 3) % 2 ? 230 : 20);
  [noise, stripes].forEach((f) => {
    const v = I.frameMotion(f, f, I.downsample(f), I.downsample(f));
    assert.ok(v === 0 || Number.isNaN(v), "got " + v);
  });
});

test("audio layout parsing and channel addressing across streams", () => {
  const out = [
    "  Stream #0:0[0x1](und): Video: h264 (High) (avc1 / 0x31637661), yuv420p, 3840x2160, 23.98 fps",
    "  Stream #0:1[0x2](und): Audio: pcm_s16be (twos / 0x736F7774), 48000 Hz, 4 channels, s16, 3072 kb/s",
    "  Stream #1:0: Audio: pcm_s24le ([1][0][0][0] / 0x0001), 48000 Hz, 4.0, s32 (24 bit), 4608 kb/s",
    "  Stream #0:2[0x3](und): Audio: aac (LC) (mp4a / 0x6134706D), 48000 Hz, stereo, fltp, 317 kb/s",
    "  Stream #0:3: Audio: aac, 48000 Hz, 5.1(side), fltp"
  ].join("\n");
  assert.deepEqual(A.parseLayout(out), [4, 4, 2, 6]);
  assert.deepEqual(A.locateChannel([2, 2], 0), { stream: 0, chan: 0 });
  assert.deepEqual(A.locateChannel([2, 2], 3), { stream: 1, chan: 1 });
  assert.equal(A.locateChannel([4], 4), null);
});

test("each channel of a multichannel file is analyzed separately", { skip: !hasFfmpeg }, async () => {
  const f = path.join(dir, "four.wav");
  cp.spawnSync("ffmpeg", ["-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "sine=f=200:d=2,volume=1", "-f", "lavfi", "-i", "sine=f=300:d=2,volume=0.1",
    "-f", "lavfi", "-i", "sine=f=400:d=2,volume=0.01", "-f", "lavfi", "-i", "sine=f=500:d=2,volume=0.001",
    "-filter_complex", "[0][1][2][3]amerge=inputs=4[a]", "-map", "[a]", "-c:a", "pcm_s16le", f]);
  await A.findFfmpeg();
  const lv = [];
  for (const ch of [0, 1, 2, 3]) lv.push((await A.analyzeRange(f, 0, 1.5, ch))[20]);
  for (let i = 1; i < 4; i++) assert.ok(lv[i - 1] - lv[i] > 15, "channel " + i + " should be ~20 dB quieter: " + lv.map((x) => x.toFixed(1)));
});
