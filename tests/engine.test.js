"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const D = require("../engine/director.js");
const { makeCurves } = require("./synth.js");

const cameras = [
  { id: "cA", name: "Host CU", videoTrack: 0, shows: ["A"] },
  { id: "cB", name: "Guest CU", videoTrack: 1, shows: ["B"] },
  { id: "cW", name: "Wide", videoTrack: 2, shows: ["A", "B"] }
];
const speakers = [{ id: "A", name: "Host" }, { id: "B", name: "Guest" }];
const at = (r, t) => r.shots.find((s) => s.startSec <= t && s.endSec > t);

function conversation(extra, opts) {
  return makeCurves([["A", 1, 12], ["B", 12.4, 25], ["A", 25.5, 40]].concat(extra || []), Object.assign({ durationSec: 42 }, opts));
}

test("cuts to whoever is talking, near the start of their speech", () => {
  const r = D.plan(conversation(), { speakers, cameras, style: { openOnWideSec: 0, interjectionMode: "ignore" } });
  assert.equal(at(r, 6).cameraId, "cA");
  assert.equal(at(r, 18).cameraId, "cB");
  assert.equal(at(r, 32).cameraId, "cA");
  const cutToB = r.shots.find((s) => s.cameraId === "cB").startSec;
  assert.ok(cutToB > 11.9 && cutToB < 12.5, "cut lands at B's onset, got " + cutToB);
});

test("shots are contiguous, cover the whole timeline, and are frame-aligned", () => {
  const input = conversation();
  const r = D.plan(input, { speakers, cameras, preset: "lively" });
  assert.equal(r.shots[0].startSec, 0);
  assert.equal(r.shots[r.shots.length - 1].endSec, input.durationSec);
  for (let i = 1; i < r.shots.length; i++) {
    assert.equal(r.shots[i].startSec, r.shots[i - 1].endSec);
    const f = r.shots[i].startSec * 30;
    assert.ok(Math.abs(f - Math.round(f)) < 0.02, "frame aligned: " + r.shots[i].startSec);
  }
});

test("bleed from the other mic is not mistaken for speech", () => {
  const r = D.plan(conversation([], { bleedDb: -12 }), { speakers, cameras, style: { openOnWideSec: 0 } });
  assert.equal(at(r, 6).cameraId, "cA");
  assert.equal(at(r, 18).cameraId, "cB");
});

test("works with mics recorded at very different gain", () => {
  const r = D.plan(conversation([], { gain: { B: -14 } }), { speakers, cameras, style: { openOnWideSec: 0 } });
  assert.equal(at(r, 18).cameraId, "cB");
});

test("sustained crosstalk goes wide; short overlaps don't", () => {
  const input = makeCurves([["A", 1, 12], ["B", 8, 12.4], ["B", 12.4, 25], ["A", 18, 18.5]], { durationSec: 27 });
  const r = D.plan(input, { speakers, cameras, style: { openOnWideSec: 0, interjectionMode: "ignore" } });
  assert.equal(at(r, 10).cameraId, "cW", "4s overlap -> wide");
  assert.equal(at(r, 18.2).cameraId, "cB", "0.5s overlap ignored");
  const hold = D.plan(input, { speakers, cameras, style: { openOnWideSec: 0, crosstalkMode: "hold" } });
  assert.notEqual(at(hold, 10).cameraId, "cW");
});

test("interjections become reaction shots (or are ignored)", () => {
  const input = conversation([["A", 18, 18.6]]);
  const react = D.plan(input, { speakers, cameras, style: { openOnWideSec: 0, interjectionMode: "reaction", interjectionChance: 1 } });
  assert.equal(at(react, 18.4).cameraId, "cA");
  assert.equal(at(react, 18.4).reason, "reaction");
  const ignore = D.plan(input, { speakers, cameras, style: { openOnWideSec: 0, interjectionMode: "ignore" } });
  assert.equal(at(ignore, 18.4).cameraId, "cB");
  const muted = D.plan(input, { speakers: [{ id: "A", name: "Host", interjections: false }, speakers[1]], cameras,
    style: { openOnWideSec: 0, interjectionMode: "reaction", interjectionChance: 1 } });
  assert.equal(at(muted, 18.4).cameraId, "cB", "per-speaker interjection switch");
});

test("long monologues get cutaways; maxShotSec 0 disables them", () => {
  const input = makeCurves([["A", 1, 80]], { durationSec: 82 });
  const r = D.plan(input, { speakers, cameras, style: { maxShotSec: 15, openOnWideSec: 0, cutawayMode: "wide" } });
  assert.ok(r.shots.filter((s) => s.reason === "cutaway").length >= 3);
  assert.ok(r.stats.longestShotSec <= 20);
  const off = D.plan(input, { speakers, cameras, style: { maxShotSec: 0, openOnWideSec: 0 } });
  assert.equal(off.shots.filter((s) => s.reason === "cutaway").length, 0);
});

test("minimum shot length is enforced", () => {
  const input = makeCurves([["A", 1, 5], ["B", 5.2, 6.4], ["A", 6.6, 12], ["B", 12.2, 13.3], ["A", 13.5, 20]], { durationSec: 21 });
  const r = D.plan(input, { speakers, cameras, style: { minShotSec: 2, openOnWideSec: 0 } });
  r.shots.slice(0, -1).forEach((s) => assert.ok(s.endSec - s.startSec >= 1.95, "shot " + JSON.stringify(s)));
});

test("speaker priority wins close calls in loudest mode", () => {
  const input = makeCurves([["A", 1, 10], ["B", 1, 10]], { durationSec: 11 });
  const style = { crosstalkMode: "loudest", openOnWideSec: 0 };
  const a = D.plan(input, { speakers: [{ id: "A", name: "Host", biasDb: 6 }, { id: "B", name: "Guest" }], cameras, style });
  const b = D.plan(input, { speakers: [{ id: "A", name: "Host" }, { id: "B", name: "Guest", biasDb: 6 }], cameras, style });
  assert.equal(at(a, 5).cameraId, "cA");
  assert.equal(at(b, 5).cameraId, "cB");
});

test("manual locks override the automatic choice", () => {
  const r = D.plan(conversation(), { speakers, cameras, overrides: [{ startSec: 15, endSec: 20, cameraId: "cW" }] });
  assert.equal(at(r, 17).cameraId, "cW");
  assert.equal(at(r, 17).reason, "locked");
  assert.equal(at(r, 22).cameraId, "cB");
});

test("speakers with two close-up angles rotate between them", () => {
  const cams = cameras.concat([{ id: "cA2", name: "Host side", videoTrack: 3, shows: ["A"] }]);
  const input = makeCurves([["A", 1, 8], ["B", 8.4, 16], ["A", 16.4, 24], ["B", 24.4, 32], ["A", 32.4, 40]], { durationSec: 41 });
  const r = D.plan(input, { speakers, cameras: cams, style: { openOnWideSec: 0, interjectionMode: "ignore", maxShotSec: 0 } });
  const hostAngles = [at(r, 4), at(r, 20), at(r, 36)].map((s) => s.cameraId);
  assert.deepEqual(hostAngles, ["cA", "cA2", "cA"]);
});

test("two-shot cameras are used for overlaps between the two people they show", () => {
  const sp3 = speakers.concat([{ id: "C", name: "Third" }]);
  const cams = [
    { id: "cA", videoTrack: 0, shows: ["A"] }, { id: "cB", videoTrack: 1, shows: ["B"] }, { id: "cC", videoTrack: 2, shows: ["C"] },
    { id: "cAB", videoTrack: 3, shows: ["A", "B"] }, { id: "cW", videoTrack: 4, shows: ["A", "B", "C"] }
  ];
  const input = makeCurves([["A", 1, 10], ["B", 5, 12], ["C", 12.5, 20]], { durationSec: 21, speakers: ["A", "B", "C"] });
  const r = D.plan(input, { speakers: sp3, cameras: cams, style: { openOnWideSec: 0 } });
  assert.equal(at(r, 7).cameraId, "cAB");
});

test("toEditPayload maps shots to video tracks and frame numbers", () => {
  const r = D.plan(conversation(), { speakers, cameras });
  const p = D.toEditPayload(r, cameras, 30);
  assert.deepEqual(p.cameraTracks, [0, 1, 2]);
  assert.equal(p.cutFrames.length, r.shots.length - 1);
  assert.ok(p.shots.every((s) => s.videoTrack >= 0 && Number.isInteger(s.startFrame)));
});

test("presets produce progressively busier edits", () => {
  const input = makeCurves([["A", 1, 30], ["B", 30.5, 50], ["A", 40, 40.5], ["A", 50.5, 90], ["B", 60, 60.6], ["B", 75, 75.5]], { durationSec: 92 });
  const n = (p) => D.plan(input, { speakers, cameras, preset: p }).stats.cuts;
  assert.ok(n("calm") <= n("balanced"), "calm <= balanced");
  assert.ok(n("balanced") <= n("lively"), "balanced <= lively");
  assert.ok(n("lively") <= n("social"), "lively <= social");
});

test("updater picks the newest package in an update folder", async () => {
  const U = require("../engine/updater.js"), fs = require("fs"), os = require("os"), path = require("path");
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "pd-upd-"));
  ["PodDirector-0.2.0-Windows.zip", "PodDirector-0.10.0-Windows.zip", "PodDirector-0.9.3-Windows.zip", "notes.txt"].forEach((f) => fs.writeFileSync(path.join(d, f), ""));
  const r = await U.check({ current: "0.2.0", folder: d, github: false });
  assert.equal(r.latest.version, "0.10.0");
  assert.equal(r.newer, true);
  assert.equal((await U.check({ current: "0.10.0", folder: d, github: false })).newer, false);
  assert.equal(U.compare("v1.2.10", "1.2.9"), 1);
});

test("planRange cuts only between the In and Out marks", () => {
  const input = makeCurves([["A", 2, 40], ["B", 40.5, 70], ["A", 70.5, 100]], { durationSec: 110 });
  const r = D.planRange(input, { speakers, cameras }, 30, 90);
  assert.equal(r.shots[0].startSec, 30);
  assert.equal(r.shots[r.shots.length - 1].endSec, 90);
  assert.equal(r.shots[0].reason, "opening", "opens on the wide at the In mark, not at 0");
  assert.equal(at(r, 60).cameraId, "cB");
  const p = D.toEditPayload(r, cameras, 30);
  assert.equal(p.cutFrames[0], 900, "razor at the In mark");
  assert.equal(p.cutFrames[p.cutFrames.length - 1], 2700, "and at the Out mark, so the outro is untouched");
  assert.ok(p.shots.every((s) => s.startFrame >= 900 && s.endFrame <= 2700));
});
