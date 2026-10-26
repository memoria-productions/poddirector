"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const D = require("../engine/director.js");
const { makeCurves } = require("./synth.js");

const HOP = 1 / 6;
const speakers = [{ id: "A", name: "Host" }, { id: "B", name: "Guest" }];
const at = (r, t) => r.shots.find((s) => s.startSec <= t && s.endSec > t);

/** Motion curve (% frame width/s): [start, end, value] segments over a steady (0) baseline. */
function motion(duration, moves) {
  const v = new Float32Array(Math.ceil(duration / HOP)).fill(0);
  moves.forEach(([a, b, x]) => { for (let i = Math.round(a / HOP); i < Math.round(b / HOP); i++) v[i] = x; });
  return { hopSec: HOP, values: v };
}

const talk = () => makeCurves([["A", 1, 12], ["B", 12.4, 25], ["A", 25.5, 40]], { durationSec: 42 });
const base = { openOnWideSec: 0, interjectionMode: "ignore", maxShotSec: 0, wideAfterSilenceSec: 0 };

test("follow cam: cuts to wide while the operator re-frames, back once settled", () => {
  const input = talk();
  input.cameraMotion = { F: motion(42, [[12.2, 13.6, 15], [25.6, 27, 12]]) };
  const cameras = [{ id: "W", videoTrack: 0, shows: ["A", "B"] }, { id: "F", videoTrack: 1, shows: [], follows: true, moving: true }];
  const r = D.plan(input, { speakers, cameras, style: base });
  assert.equal(at(r, 6).cameraId, "F");
  assert.equal(at(r, 12.8).cameraId, "W", "operator is moving");
  assert.equal(at(r, 13.9).cameraId, "W", "still settling");
  assert.equal(at(r, 16).cameraId, "F", "settled on the guest");
  assert.equal(at(r, 26).cameraId, "W");
  assert.equal(at(r, 30).cameraId, "F");
  assert.equal(at(r, 12.8).reason, "camera-move");
  assert.ok(r.stability.F.fastPct > 0);
});

test("without motion analysis the same follow cam is used straight through", () => {
  const cameras = [{ id: "W", videoTrack: 0, shows: ["A", "B"] }, { id: "F", videoTrack: 1, shows: [], follows: true, moving: true }];
  const r = D.plan(talk(), { speakers, cameras, style: base });
  assert.equal(at(r, 12.8).cameraId, "F");
});

test("cutting to a dolly close-up waits (holding the previous shot) until it settles", () => {
  const input = talk();
  input.cameraMotion = { B: motion(42, [[11.8, 13.0, 10]]) };
  const cameras = [{ id: "W", videoTrack: 0, shows: ["A", "B"] }, { id: "A", videoTrack: 1, shows: ["A"] },
    { id: "B", videoTrack: 2, shows: ["B"], moving: true }];
  const r = D.plan(input, { speakers, cameras, style: base });
  assert.equal(at(r, 12.9).cameraId, "A", "held on the host while the guest cam finished its move");
  assert.equal(at(r, 14).cameraId, "B");
  const cutIn = r.shots.find((s) => s.cameraId === "B").startSec;
  assert.ok(cutIn >= 13.5 && cutIn <= 13.8, "cut in after settleSec, got " + cutIn);
});

test("slow push-ins stay on air unless slowMovesOnAir is off; fast moves never do", () => {
  const input = talk();
  input.cameraMotion = { F: motion(42, [[31, 35, 3], [37, 38, 20]]) };
  const cameras = [{ id: "W", videoTrack: 0, shows: ["A", "B"] }, { id: "F", videoTrack: 1, shows: [], follows: true, moving: true }];
  const on = D.plan(input, { speakers, cameras, style: base });
  assert.equal(at(on, 33).cameraId, "F");
  assert.equal(at(on, 37.5).cameraId, "W");
  const off = D.plan(input, { speakers, cameras, style: Object.assign({ slowMovesOnAir: false }, base) });
  assert.equal(at(off, 33).cameraId, "W");
});

test("minimum-shot cleanup never puts a moving camera back on air", () => {
  const input = talk();
  // A short whip (0.5 s) inside a long shot: the wide cutaway is short, but must survive.
  input.cameraMotion = { F: motion(42, [[18, 18.5, 30]]) };
  const cameras = [{ id: "W", videoTrack: 0, shows: ["A", "B"] }, { id: "F", videoTrack: 1, shows: [], follows: true, moving: true }];
  const r = D.plan(input, { speakers, cameras, style: Object.assign({}, base, { minShotSec: 3 }) });
  assert.equal(at(r, 18.2).cameraId, "W");
});

test("follow cams are never used as listener reactions", () => {
  const input = makeCurves([["A", 1, 30], ["B", 12, 12.6]], { durationSec: 32 });
  const cameras = [{ id: "W", videoTrack: 0, shows: ["A", "B"] }, { id: "F", videoTrack: 1, shows: [], follows: true }];
  const r = D.plan(input, { speakers, cameras, style: { openOnWideSec: 0, interjectionMode: "reaction", interjectionChance: 1, maxShotSec: 10, cutawayMode: "reaction" } });
  assert.ok(!r.shots.some((s) => s.reason === "reaction"), "no reaction shot on a follow cam");
  assert.ok(r.shots.filter((s) => s.reason === "cutaway").every((s) => s.cameraId === "W"));
});

test("unreadable stretches: treated as moving on a readable camera, ignored on a plain-backdrop camera", () => {
  const cameras = [{ id: "W", videoTrack: 0, shows: ["A", "B"] }, { id: "F", videoTrack: 1, shows: [], follows: true, moving: true }];
  const readable = talk();
  readable.cameraMotion = { F: motion(42, [[18, 21, NaN]]) };
  const r1 = D.plan(readable, { speakers, cameras, style: Object.assign({}, base, { slowMovesOnAir: false }) });
  assert.equal(at(r1, 19.5).cameraId, "W");
  const plain = talk();
  plain.cameraMotion = { F: motion(42, [[0, 42, NaN]]) };
  const r2 = D.plan(plain, { speakers, cameras, style: Object.assign({}, base, { slowMovesOnAir: false }) });
  assert.equal(at(r2, 19.5).cameraId, "F");
  assert.equal(r2.stability.F.lowDetail, true);
});
