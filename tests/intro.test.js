"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const T = require("../engine/transcript.js");
const D = require("../engine/director.js");
const { makeCurves } = require("./synth.js");

const ce244 = T.parse(fs.readFileSync(path.join(__dirname, "fixtures", "ce244.txt"), "utf8"), { fps: 30 });
const CORE = ["Martin", "Tanya", "Jessica", "Paul"];

test("introduction: finds the welcome, the host and the people introduced (episode 244)", () => {
  const r = T.introduction(ce244, { showName: "Classical et cetera", names: CORE });
  assert.ok(r, "found an introduction");
  assert.match(r.welcomeText, /welcome to another episode of classical/i);
  assert.equal(r.host.name, "Jessica Abood");
  assert.deepEqual(r.names.map((n) => n.name), ["Jessica", "Paul", "Tanya", "Martin"]);
  assert.ok(r.names[0].host && r.names[0].fullName === "Jessica Abood");
  assert.ok(r.welcomeSec > 540 && r.welcomeSec < 560, "welcome at about 9:11, got " + r.welcomeSec);
  // Solo on the host until the first other name, then the wide past the last one.
  assert.ok(r.wideSec > r.welcomeEndSec - 0.01 && r.wideSec <= r.names[1].sec);
  assert.ok(r.endSec > r.names[3].sec);
});

test("introduction: full names set on speakers win; guests are picked up from cue phrases", () => {
  const segs = [
    { startSec: 0, endSec: 10, text: "Okay are we rolling. Yes." },
    { startSec: 40, endSec: 60, text: "Hello and welcome to Classical et cetera. I'm Paul. With me are Tanya and Martin, and we're joined by Dr. Malcolm Guite. Thanks for having me." },
    { startSec: 60, endSec: 300, text: "So today we're talking about poetry and a great deal more that goes on for a long while." }
  ];
  const r = T.introduction(segs, { showName: "Classical et cetera", names: ["Martin Cothran", "Tanya", "Paul"] });
  assert.equal(r.host.name, "Paul");
  const byName = Object.fromEntries(r.names.map((n) => [n.name, n]));
  assert.equal(byName["Martin Cothran"].fullName, "Martin Cothran");
  const guest = r.names.find((n) => n.guest);
  assert.ok(guest && guest.name === "Dr. Malcolm Guite", JSON.stringify(r.names));
});

test("introduction: no welcome, no introduction", () => {
  assert.equal(T.introduction([{ startSec: 0, endSec: 20, text: "Just some talk about books." }], { names: CORE }), null);
});

test("intro cut: host's solo cam through the welcome, then the wide for the introductions", () => {
  const speakers = [{ id: "A", name: "Host" }, { id: "B", name: "Guest" }];
  const cameras = [{ id: "cW", videoTrack: 0, shows: ["A", "B"] }, { id: "cA", videoTrack: 1, shows: ["A"] }, { id: "cB", videoTrack: 2, shows: ["B"] }];
  // A talks from 2 s to 20 s (welcome and introductions), then B.
  const input = makeCurves([["A", 2, 20], ["B", 20.5, 40]], { durationSec: 42 });
  const at = (r, t) => r.shots.find((s) => s.startSec <= t && s.endSec > t);
  const r = D.plan(input, { speakers, cameras, style: { openOnWideSec: 3, minWideSec: 5 }, intro: { startSec: 2, wideSec: 8, endSec: 12 } });
  assert.equal(at(r, 3).cameraId, "cA", "solo on the host during the welcome (overrides open on wide)");
  assert.equal(at(r, 3).reason, "intro");
  assert.equal(at(r, 9).cameraId, "cW");
  assert.equal(at(r, 9).reason, "intro-wide");
  assert.equal(at(r, 36).cameraId, "cB", "normal cutting after the introductions");
  // Range plans shift the intro into the range's own time.
  const ranged = D.planRange(input, { speakers, cameras, intro: { startSec: 2, wideSec: 8, endSec: 12 } }, 1, 41);
  assert.equal(at(ranged, 3).cameraId, "cA");
  assert.equal(at(ranged, 9).cameraId, "cW");
  // Manual locks still win.
  const locked = D.plan(input, { speakers, cameras, intro: { startSec: 2, wideSec: 8, endSec: 12 }, overrides: [{ startSec: 9, endSec: 11, cameraId: "cB" }] });
  assert.equal(at(locked, 10).cameraId, "cB");
});
