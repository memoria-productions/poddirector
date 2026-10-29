"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const F = require("../engine/framing.js");
const D = require("../engine/director.js");
const { makeCurves } = require("./synth.js");

const W = 32, H = 18, SIZE = W * H * 3;
// A "person" = shirt + skin colours in the middle of frame on a shared background.
const PEOPLE = { P: [[40, 60, 160], [210, 170, 150]], J: [[170, 40, 50], [200, 160, 140]], M: [[60, 140, 70], [190, 150, 120]] };
function frame(person, jitter) {
  const f = new Uint8Array(SIZE);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const k = (y * W + x) * 3;
    let c = [90, 85, 80]; // back wall
    if (person && x > 9 + jitter && x < 23 + jitter) c = y < 7 ? PEOPLE[person][1] : PEOPLE[person][0];
    f[k] = c[0]; f[k + 1] = c[1]; f[k + 2] = c[2];
  }
  return f;
}
/** schedule: [[startSec, endSec, person]] with a 1.5 s camera move between stretches */
function dolly(duration, schedule) {
  const data = new Uint8Array(duration * SIZE), valid = new Uint8Array(duration).fill(1);
  const hop = 1 / 6, values = new Float32Array(Math.ceil(duration / hop)).fill(0.2);
  schedule.forEach(([a, b, who], i) => {
    for (let s = a; s < b && s < duration; s++) data.set(frame(who, (s % 3) - 1), s * SIZE);
    if (i > 0) for (let t = Math.round((a - 1.5) / hop); t < Math.round(a / hop); t++) values[t] = 12;
  });
  return { thumbs: { w: W, h: H, hopSec: 1, data, valid }, motion: { hopSec: hop, values } };
}

test("groups the dolly's steady stretches by who is in frame and names them from the audio", () => {
  const cam = dolly(120, [[0, 20, "P"], [22, 40, "J"], [42, 60, "P"], [62, 80, "M"], [82, 100, "J"], [102, 120, "P"]]);
  const speech = [
    { speakerId: "Paul", runs: [[1, 19], [43, 59], [83, 99], [103, 119]] }, // operator held on Jess 82-100 while Paul talked
    { speakerId: "Jess", runs: [[23, 39]] },
    { speakerId: "Martin", runs: [[63, 79]] }
  ];
  const r = F.analyze({ thumbs: cam.thumbs, motion: cam.motion, speech, speakers: [{ id: "Paul" }, { id: "Jess" }, { id: "Martin" }] });
  assert.equal(r.stretches.length, 6);
  const groupOf = (t) => r.stretches.find((s) => s.startSec <= t && s.endSec > t).group;
  assert.equal(groupOf(10), groupOf(50));
  assert.equal(groupOf(30), groupOf(90), "both Jess stretches in one group");
  assert.notEqual(groupOf(10), groupOf(30));
  const name = (t) => r.groups.find((g) => g.id === groupOf(t)).guess;
  assert.equal(name(10), "Paul");
  assert.equal(name(30), "Jess");
  assert.equal(name(70), "Martin");
  const tl = F.timeline(r, Object.fromEntries(r.groups.map((g) => [g.id, g.guess])));
  assert.equal(tl.find((s) => s.startSec <= 90 && s.endSec > 90).speakerId, "Jess");
});

test("engine: the follow cam is only used when it is on the person talking", () => {
  const input = makeCurves([["P", 1, 60]], { durationSec: 62, speakers: ["P", "J"] });
  // The operator holds on Jess for a few seconds (a listener shot) while Paul talks.
  input.framing = { F: [{ startSec: 0, endSec: 20, speakerId: "P" }, { startSec: 21.5, endSec: 27, speakerId: "J" }, { startSec: 28.5, endSec: 62, speakerId: "P" }] };
  const cameras = [{ id: "W", videoTrack: 0, shows: ["P", "J"] }, { id: "F", videoTrack: 1, shows: [], follows: true }];
  const r = D.plan(input, { speakers: [{ id: "P", name: "Paul" }, { id: "J", name: "Jess" }], cameras, style: { openOnWideSec: 0, maxShotSec: 0 } });
  const at = (t) => r.shots.find((s) => s.startSec <= t && s.endSec > t);
  assert.equal(at(10).cameraId, "F");
  assert.equal(at(24).cameraId, "W", "dolly is on Jess while Paul talks: show the wide");
  assert.equal(at(24).reason, "framing");
  assert.equal(at(50).cameraId, "F");
});

test("engine: a reaction from someone without a close-up goes to the wide (or stays put if set to skip)", () => {
  // Paul talks with the dolly on him; Jess says "yeah" at 30 s. There's no close-up of Jess.
  const input = makeCurves([["P", 1, 60], ["J", 30, 30.6]], { durationSec: 62, speakers: ["P", "J"] });
  input.framing = { F: [{ startSec: 0, endSec: 62, speakerId: "P" }] };
  const cameras = [{ id: "W", videoTrack: 0, shows: ["P", "J"] }, { id: "F", videoTrack: 1, shows: [], follows: true }];
  const sp = [{ id: "P", name: "Paul" }, { id: "J", name: "Jess" }];
  const style = { openOnWideSec: 0, maxShotSec: 0, minWideSec: 0, interjectionMode: "reaction", interjectionChance: 1 };
  const at = (r, t) => r.shots.find((x) => x.startSec <= t && x.endSec > t);
  const r = D.plan(input, { speakers: sp, cameras, style });
  assert.equal(at(r, 30.3).cameraId, "W");
  assert.equal(at(r, 30.3).reason, "interjection-wide");
  assert.equal(at(r, 20).cameraId, "F", "on Paul otherwise");
  const skip = D.plan(input, { speakers: sp, cameras, style: Object.assign({ reactionNoCloseup: "skip" }, style) });
  assert.equal(at(skip, 30.3).cameraId, "F");
});

test("engine: two listeners reacting together always cut to the wide", () => {
  const input = makeCurves([["P", 1, 60], ["J", 30, 30.6], ["T", 30.4, 31]], { durationSec: 62, speakers: ["P", "J", "T"] });
  const cameras = [{ id: "W", videoTrack: 0, shows: ["P", "J", "T"] }, { id: "cP", videoTrack: 1, shows: ["P"] },
    { id: "cJ", videoTrack: 2, shows: ["J"] }, { id: "cT", videoTrack: 3, shows: ["T"] }];
  const sp = [{ id: "P", name: "Paul" }, { id: "J", name: "Jess" }, { id: "T", name: "Tanya" }];
  // Even with reactions rare and close-ups available, a shared laugh is a group moment.
  const style = { openOnWideSec: 0, maxShotSec: 0, minWideSec: 0, interjectionMode: "reaction", interjectionChance: 0 };
  const r = D.plan(input, { speakers: sp, cameras, style });
  const s = r.shots.find((x) => x.startSec <= 30.5 && x.endSec > 30.5);
  assert.equal(s.cameraId, "W");
  assert.equal(s.reason, "interjection-wide");
  const off = D.plan(input, { speakers: sp, cameras, style: Object.assign({}, style, { groupReactWide: false }) });
  assert.equal(off.shots.find((x) => x.startSec <= 30.5 && x.endSec > 30.5).cameraId, "cP", "switch off: rare reactions stay on Paul");
});

test("engine: a listener's reaction can use the follow cam when it happens to be on them", () => {
  const input = makeCurves([["P", 1, 60], ["J", 30, 30.6]], { durationSec: 62, speakers: ["P", "J"] });
  input.framing = { F: [{ startSec: 0, endSec: 25, speakerId: "P" }, { startSec: 26, endSec: 32, speakerId: "J" }, { startSec: 33, endSec: 62, speakerId: "P" }] };
  const cameras = [{ id: "W", videoTrack: 0, shows: ["P", "J"] }, { id: "F", videoTrack: 1, shows: [], follows: true }];
  const r = D.plan(input, { speakers: [{ id: "P", name: "Paul" }, { id: "J", name: "Jess" }], cameras,
    style: { openOnWideSec: 0, maxShotSec: 0, interjectionMode: "reaction", interjectionChance: 1 } });
  const s = r.shots.find((x) => x.startSec <= 30.3 && x.endSec > 30.3);
  assert.equal(s.cameraId, "F");
  assert.equal(s.reason, "reaction");
});

test("engine: Jess's question stays on Jess through a bump on every mic, and no reaction just before Martin answers", () => {
  // Jess asks a long question (1-40 s); Martin answers from 40 s. At 20 s one short sound hits the other three mics at
  // the same instant (a knock, or Jess's own laugh bleeding in). At 37.5 s Paul says "mm" just before the answer.
  const input = makeCurves([["J", 1, 40], ["P", 20, 20.35], ["T", 20.05, 20.4], ["M", 20.02, 20.3], ["P", 37.3, 37.9], ["M", 40, 70]],
    { durationSec: 72, speakers: ["J", "P", "T", "M"] });
  const cameras = [{ id: "W", videoTrack: 0, shows: ["J", "P", "T", "M"] }, { id: "cJ", videoTrack: 1, shows: ["J"] },
    { id: "cP", videoTrack: 2, shows: ["P"] }, { id: "cT", videoTrack: 3, shows: ["T"] }, { id: "cM", videoTrack: 4, shows: ["M"] }];
  const sp = ["J", "P", "T", "M"].map((id) => ({ id, name: id }));
  const style = { openOnWideSec: 0, maxShotSec: 0, interjectionMode: "reaction", interjectionChance: 1 };
  const r = D.plan(input, { speakers: sp, cameras, style });
  const at = (t) => r.shots.find((x) => x.startSec <= t && x.endSec > t);
  assert.equal(at(20.2).cameraId, "cJ", "the bump is not a reaction");
  assert.equal(at(37.6).cameraId, "cJ", "the answer is coming: stay on the question");
  assert.equal(at(45).cameraId, "cM");
  const early = D.plan(input, { speakers: sp, cameras, style: Object.assign({}, style, { turnLookaheadSec: 0 }) });
  assert.equal(early.shots.find((x) => x.startSec <= 37.6 && x.endSec > 37.6).cameraId, "cP", "look-ahead off: Paul's reaction plays");
});

test("engine: a long dolly stretch named after someone silent while another talks is on the talker", () => {
  // The picture reading lumped Jess in with Tanya: 40 s of the dolly "on Tanya" while Jess does all the talking.
  const input = makeCurves([["P", 1, 20], ["J", 21, 62]], { durationSec: 64, speakers: ["P", "J", "T"] });
  input.framing = { F: [{ startSec: 0, endSec: 20, speakerId: "P" }, { startSec: 22, endSec: 64, speakerId: "T" }] };
  const cameras = [{ id: "W", videoTrack: 0, shows: ["P", "J", "T"] }, { id: "F", videoTrack: 1, shows: [], follows: true }];
  const sp = [{ id: "P", name: "Paul" }, { id: "J", name: "Jess" }, { id: "T", name: "Tanya" }];
  const style = { openOnWideSec: 0, maxShotSec: 0 };
  const at = (r, t) => r.shots.find((s) => s.startSec <= t && s.endSec > t);
  assert.equal(at(D.plan(input, { speakers: sp, cameras, style }), 45).cameraId, "F", "Jess's solo");
  const off = D.plan(input, { speakers: sp, cameras, style: Object.assign({ checkFramingByAudio: false }, style) });
  assert.equal(at(off, 45).cameraId, "W", "trusting the picture names: the wide");
});
