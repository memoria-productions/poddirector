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
  input.framing = { F: [{ startSec: 0, endSec: 20, speakerId: "P" }, { startSec: 21.5, endSec: 40, speakerId: "J" }, { startSec: 41.5, endSec: 62, speakerId: "P" }] };
  const cameras = [{ id: "W", videoTrack: 0, shows: ["P", "J"] }, { id: "F", videoTrack: 1, shows: [], follows: true }];
  const r = D.plan(input, { speakers: [{ id: "P", name: "Paul" }, { id: "J", name: "Jess" }], cameras, style: { openOnWideSec: 0, maxShotSec: 0 } });
  const at = (t) => r.shots.find((s) => s.startSec <= t && s.endSec > t);
  assert.equal(at(10).cameraId, "F");
  assert.equal(at(30).cameraId, "W", "dolly is on Jess while Paul talks: show the wide");
  assert.equal(at(30).reason, "framing");
  assert.equal(at(50).cameraId, "F");
});

test("engine: a listener's reaction can use the follow cam when it happens to be on them", () => {
  const input = makeCurves([["P", 1, 60], ["J", 30, 30.6]], { durationSec: 62, speakers: ["P", "J"] });
  input.framing = { F: [{ startSec: 0, endSec: 25, speakerId: "P" }, { startSec: 26, endSec: 40, speakerId: "J" }, { startSec: 41, endSec: 62, speakerId: "P" }] };
  const cameras = [{ id: "W", videoTrack: 0, shows: ["P", "J"] }, { id: "F", videoTrack: 1, shows: [], follows: true }];
  const r = D.plan(input, { speakers: [{ id: "P", name: "Paul" }, { id: "J", name: "Jess" }], cameras,
    style: { openOnWideSec: 0, maxShotSec: 0, interjectionMode: "reaction", interjectionChance: 1 } });
  const s = r.shots.find((x) => x.startSec <= 30.3 && x.endSec > 30.3);
  assert.equal(s.cameraId, "F");
  assert.equal(s.reason, "reaction");
});
