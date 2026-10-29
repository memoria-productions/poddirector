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

test("wide bias: toward the wide, some turns play on it; toward close-ups, none do", () => {
  const turns = [];
  for (let i = 0; i < 12; i++) turns.push([i % 2 ? "B" : "A", 1 + i * 6, 6.6 + i * 6]);
  const input = makeCurves(turns, { durationSec: 75 });
  const style = { openOnWideSec: 0, interjectionMode: "ignore", maxShotSec: 0, wideAfterSilenceSec: 0 };
  const wideTurns = (r) => r.shots.filter((s) => s.reason === "wide-turn").length;
  const wide = D.plan(input, { speakers, cameras, style: Object.assign({ wideBias: 1 }, style) });
  const close = D.plan(input, { speakers, cameras, style: Object.assign({ wideBias: -1 }, style) });
  const neutral = D.plan(input, { speakers, cameras, style });
  assert.ok(wideTurns(wide) >= 2, "some turns on the wide: " + wideTurns(wide));
  assert.ok(wide.stats.screenTimePct.cW > neutral.stats.screenTimePct.cW);
  assert.equal(wideTurns(close), 0);
  assert.equal(wideTurns(neutral), 0);
});

test("wide bias toward close-ups keeps a long overlap on the loudest voice", () => {
  const input = makeCurves([["A", 1, 12], ["B", 8, 12.4], ["B", 12.4, 25]], { durationSec: 27 });
  const r = D.plan(input, { speakers, cameras, style: { openOnWideSec: 0, interjectionMode: "ignore", wideBias: -1 } });
  assert.notEqual(at(r, 10).cameraId, "cW");
});

test("a featured speaker is shown listening more during others' long turns", () => {
  const cams = cameras.concat([{ id: "cC", name: "Third CU", videoTrack: 3, shows: ["C"] }]);
  const three = speakers.concat([{ id: "C", name: "Third" }]);
  const input = makeCurves([["A", 1, 200]], { durationSec: 202 });
  const style = { openOnWideSec: 0, maxShotSec: 10, cutawayMode: "reaction" };
  const count = (r, cam) => r.shots.filter((s) => s.reason === "cutaway" && s.cameraId === cam).length;
  const plain = D.plan(input, { speakers: three, cameras: cams, style });
  const featured = D.plan(input, { speakers: [three[0], three[1], Object.assign({ biasDb: 10 }, three[2])], cameras: cams, style });
  assert.ok(count(featured, "cC") > count(plain, "cC"), count(featured, "cC") + " vs " + count(plain, "cC"));
  assert.ok(count(featured, "cC") > count(featured, "cB"));
});

test("a featured speaker is switched to sooner and cut away from less", () => {
  // B's 0.5 s answer is under the 0.6 s reaction delay unless B is featured.
  const input = makeCurves([["A", 1, 10], ["B", 10.2, 10.7], ["A", 11.5, 20]], { durationSec: 21 });
  const style = { openOnWideSec: 0, reactionDelaySec: 0.6, minShotSec: 0.3, interjectionMode: "ignore", wideAfterSilenceSec: 0 };
  const plain = D.plan(input, { speakers, cameras, style });
  const featured = D.plan(input, { speakers: [speakers[0], { id: "B", name: "Guest", biasDb: 10 }], cameras, style });
  assert.notEqual(at(plain, 10.5).cameraId, "cB");
  assert.equal(at(featured, 10.5).cameraId, "cB");
  const mono = makeCurves([["B", 1, 80]], { durationSec: 82 });
  const cut = (sp) => D.plan(mono, { speakers: sp, cameras, style: { openOnWideSec: 0, maxShotSec: 15 } })
    .shots.filter((s) => s.reason === "cutaway").length;
  assert.ok(cut([speakers[0], { id: "B", name: "Guest", biasDb: 10 }]) < cut(speakers));
});

test("every mode plans a cut and has a label and description", () => {
  const input = conversation([["A", 18, 18.6]]);
  Object.keys(D.PRESETS).forEach((k) => {
    assert.ok(D.PRESETS[k].label && D.PRESETS[k].description, k);
    const r = D.plan(input, { speakers, cameras, preset: k });
    assert.ok(r.shots.length > 0, k);
  });
  assert.ok(D.PRESETS.rapid && D.PRESETS.interview);
});

test("content cuts that leave a section shorter than the minimum are found", () => {
  const m = "/wide.mp4";
  const clips = [
    { startSec: 0, endSec: 60, inPointSec: 0, mediaPath: m, speed: 1 },
    { startSec: 60, endSec: 90, inPointSec: 60, mediaPath: m, speed: 1 },     // razor, same content: not a cut
    { startSec: 90, endSec: 93, inPointSec: 120, mediaPath: m, speed: 1 },    // content cut at 90, another at 93
    { startSec: 93, endSec: 150, inPointSec: 200, mediaPath: m, speed: 1 },
    { startSec: 150, endSec: 154, inPointSec: 0, mediaPath: "/other.mp4", speed: 1 }, // new file at 150
    { startSec: 160, endSec: 162, inPointSec: 4, mediaPath: "/other.mp4", speed: 1 }  // after a gap: no cut either side
  ];
  const short = D.shortSections(clips, 5, { fps: 30 });
  assert.deepEqual(short.map((s) => [s.startSec, s.endSec]), [[90, 93], [150, 154]]);
  assert.ok(short[0].cutBefore && short[0].cutAfter);
  assert.equal(D.shortSections(clips, 4, { fps: 30 }).length, 1, "the 4 s section passes a 4 s minimum, the 3 s one doesn't");
  // Only cuts inside the In/Out range count, and sections are trimmed to it.
  assert.deepEqual(D.shortSections(clips, 5, { fps: 30, rangeStart: 0, rangeEnd: 92 }).map((s) => [s.startSec, s.endSec]), [[90, 92]]);
  assert.equal(D.shortSections(clips, 5, { fps: 30, rangeStart: 0, rangeEnd: 90 }).length, 0);
});

test("mic confidence: clean mics score well, a quiet bleed-heavy mic scores poorly", () => {
  const conv = [["A", 1, 20], ["B", 20.5, 40], ["A", 40.5, 60], ["B", 60.5, 80]];
  const good = D.plan(makeCurves(conv, { durationSec: 82 }), { speakers, cameras });
  good.confidence.forEach((c) => assert.ok(c.score >= 75 && c.label === "good", c.speakerId + " " + c.score));
  // B mumbles 16 dB below A: barely louder on their own mic than A's bleed.
  const quiet = conv.map(([id, a, b]) => [id, a, b, id === "B" ? -34 : -18]);
  const poor = D.plan(makeCurves(quiet, { durationSec: 82 }), { speakers, cameras });
  const b = poor.confidence.find((c) => c.speakerId === "B");
  assert.ok(b.score < 60, "B scored " + b.score);
  assert.ok(b.levelGapDb <= -12 && b.hints.length > 0);
  assert.ok(poor.confidence.find((c) => c.speakerId === "A").score >= 75);
});

test("mic confidence: a stretch where someone leans away is flagged", () => {
  const input = makeCurves([["A", 1, 60], ["A", 60, 120, -30], ["A", 120, 180], ["B", 181, 200]], { durationSec: 202 });
  const r = D.plan(input, { speakers, cameras });
  const a = r.confidence.find((c) => c.speakerId === "A");
  assert.ok(a.weak.length >= 1, JSON.stringify(a.weak));
  assert.ok(a.weak[0][0] >= 55 && a.weak[a.weak.length - 1][1] <= 125, JSON.stringify(a.weak));
  // Range plans report weak stretches in sequence time.
  const ranged = D.planRange(input, { speakers, cameras }, 10, 200);
  const ar = ranged.confidence.find((c) => c.speakerId === "A");
  assert.ok(ar.weak.length && ar.weak[0][0] >= 55, JSON.stringify(ar.weak));
});

test("multicam cut list: one angle change per shot, angle = video track + 1", () => {
  const cams = [{ id: "w", videoTrack: 0 }, { id: "solo", videoTrack: 1 }, { id: "x", videoTrack: 3, angle: 2 }];
  const shot = (a, b, c) => ({ startSec: a, endSec: b, cameraId: c });
  const cuts = D.toMulticamCuts({ shots: [shot(10, 15, "w"), shot(15, 22, "solo"), shot(22, 30, "x"), shot(30, 40, "w")] }, cams);
  assert.deepEqual(cuts.map((c) => [c.sec, c.camera]), [[10, 1], [15, 2], [30, 1]], "x shares angle 2 with solo, so no cut at 22");
  assert.equal(cuts[0].first, true);
  const r = D.planRange(conversation(), { speakers, cameras: cameras.map((c, i) => Object.assign({}, c)) }, 5, 40);
  const list = D.toMulticamCuts(r, cameras);
  assert.equal(list[0].sec, 5, "starts at the In mark");
  list.slice(1).forEach((c, i) => assert.notEqual(c.camera, list[i].camera));
});

test("multicam cut list for an In/Out range: opens on the planned angle, nothing past Out", () => {
  const cams = [{ id: "w", videoTrack: 0 }, { id: "solo", videoTrack: 1 }];
  const shot = (a, b, c) => ({ startSec: a, endSec: b, cameraId: c });
  const result = { shots: [shot(0, 10, "w"), shot(10, 20, "solo"), shot(20, 30, "w"), shot(30, 40, "solo")] };
  const cuts = D.toMulticamCuts(result, cams, { startSec: 12, endSec: 25 });
  assert.deepEqual(cuts.map((c) => [c.sec, c.camera]), [[12, 2], [20, 1]], "open on solo at 12, change to the wide at 20");
  assert.ok(cuts[0].first);
  assert.deepEqual(D.toMulticamCuts(result, cams, { startSec: 20, endSec: 31 }).map((c) => [c.sec, c.camera]), [[20, 1], [30, 2]]);
});

test("multicam recut: every existing piece and every new cut gets the angle the plan wants there", () => {
  // An earlier build left edit points at 10, 20, 30; the new plan cuts at 15 (to 2) and 25 (back to 1).
  const desired = [{ sec: 0, camera: 1 }, { sec: 15, camera: 2 }, { sec: 25, camera: 1 }];
  const typed = D.multicamRetype(desired, [0, 10, 20, 30], 0, 40);
  assert.deepEqual(typed.map((c) => [c.sec, c.camera]), [[0, 1], [10, 1], [15, 2], [20, 2], [25, 1], [30, 1]]);
  // Undo to the wide after a first build: every piece back on camera 1.
  assert.deepEqual(D.multicamRetype([{ sec: 5, camera: 1 }], [5, 12, 18], 5, 40).map((c) => [c.sec, c.camera]), [[5, 1], [12, 1], [18, 1]]);
  // Edit points outside the range are left alone; ones within half a frame of a cut count once.
  assert.deepEqual(D.multicamRetype(desired, [2, 15.01, 45], 5, 40).map((c) => c.sec), [5, 15, 25]);
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
  const r = D.plan(input, { speakers, cameras: cams, style: { openOnWideSec: 0, interjectionMode: "ignore", maxShotSec: 0, minWideSec: 0 } });
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

test("a removed section never joins the same camera to itself (no jump cut)", () => {
  // Paul talks 1-60; he says "cut that" and the section 20-25 will be removed.
  const input = makeCurves([["A", 1, 60]], { durationSec: 62 });
  const style = { openOnWideSec: 0, maxShotSec: 0, interjectionMode: "ignore" };
  const r = D.plan(input, { speakers, cameras, style, removals: [{ startSec: 20, endSec: 25 }] });
  const before = at(r, 19.9), after = at(r, 25.05);
  assert.equal(before.cameraId, "cA");
  assert.notEqual(after.cameraId, before.cameraId, "camera changes across the removed section");
  assert.equal(after.reason, "jump-cover");
  assert.equal(at(r, 40).cameraId, "cA", "back on the speaker afterwards");
  assert.ok(r.shots.some((s) => Math.abs(s.startSec - 20) < 0.05) && r.shots.some((s) => Math.abs(s.startSec - 25) < 0.05), "edit points at both ends");
  const off = D.plan(input, { speakers, cameras, style: Object.assign({ changeCameraAtCuts: false }, style), removals: [{ startSec: 20, endSec: 25 }] });
  assert.equal(at(off, 25.05).cameraId, "cA");
  const ranged = D.planRange(input, { speakers, cameras, style, removals: [{ startSec: 20, endSec: 25 }] }, 5, 55);
  assert.notEqual(at(ranged, 25.05).cameraId, at(ranged, 19.9).cameraId, "works with In/Out ranges too");
});

test("a content cut already in the timeline is covered by another camera when the wide runs across it", () => {
  // The host has no close-up, so the plan sits on the wide; a content cut at 25 s would be a jump wide to wide.
  const cams = [{ id: "cW", videoTrack: 0, shows: ["A", "B"] }, { id: "cB", videoTrack: 1, shows: ["B"] }];
  const input = makeCurves([["A", 1, 60]], { durationSec: 62 });
  const style = { openOnWideSec: 0, maxShotSec: 0, interjectionMode: "ignore" };
  const r = D.plan(input, { speakers, cameras: cams, style, removals: [{ startSec: 25, endSec: 25, join: true }] });
  assert.equal(at(r, 24.9).cameraId, "cW");
  assert.equal(at(r, 25.05).cameraId, "cB", "the solo covers the cut");
  assert.equal(at(r, 25.05).reason, "jump-cover");
  assert.ok(Math.abs(at(r, 25.05).startSec - 25) < 0.05, "starting exactly on the cut");
  assert.equal(at(r, 40).cameraId, "cW", "then back to the wide");
  // The times come from the camera track: the source jumps at 25 s (10 s were taken out).
  const clips = [{ startSec: 0, endSec: 25, inPointSec: 100, mediaPath: "w.mp4", speed: 1 },
    { startSec: 25, endSec: 40, inPointSec: 135, mediaPath: "w.mp4", speed: 1 },
    { startSec: 40, endSec: 62, inPointSec: 150, mediaPath: "w.mp4", speed: 1 }];
  assert.deepEqual(D.contentCuts(clips, { fps: 30 }), [25], "a razor that keeps the source running isn't a cut");
});

test("max cuts per minute caps a busy edit, dropping reactions and pauses first", () => {
  const lines = [];
  for (let t = 1; t < 170; t += 6) lines.push([t % 12 < 6 ? "A" : "B", t, t + 5.2]);
  for (let t = 10; t < 170; t += 9) lines.push([t % 18 < 9 ? "B" : "A", t + 2, t + 2.7]);
  const input = makeCurves(lines, { durationSec: 172 });
  const style = { openOnWideSec: 0, interjectionMode: "reaction", interjectionChance: 1, minShotSec: 1 };
  const free = D.plan(input, { speakers, cameras, style });
  const capped = D.plan(input, { speakers, cameras, style: Object.assign({ maxCutsPerMin: 4 }, style) });
  assert.ok(free.stats.cutsPerMinute > 6, "busy without a cap: " + free.stats.cutsPerMinute);
  const starts = capped.shots.slice(1).map((s) => s.startSec);
  for (const t of starts) assert.ok(starts.filter((x) => x > t - 60 && x <= t).length <= 4, "no 60 s window over 4 cuts");
  assert.ok((capped.stats.reasons.reaction || 0) <= (free.stats.reasons.reaction || 0));
});

test("wide shots last at least the minimum wide length", () => {
  // Quick back-and-forth with short overlaps and pauses: lots of brief wides without the rule.
  const lines = [];
  for (let t = 1; t < 170; t += 7) { lines.push(["A", t, t + 4]); lines.push(["B", t + 3, t + 6.2]); }
  const input = makeCurves(lines, { durationSec: 172 });
  const style = { openOnWideSec: 0, interjectionMode: "ignore", minShotSec: 1, crosstalkMinSec: 0.5, wideAfterSilenceSec: 0 };
  const wideId = cameras.reduce((w, c) => (!w || c.shows.length > w.shows.length ? c : w), null).id;
  const shortWides = (r) => r.shots.filter((s, i) => s.cameraId === wideId && i < r.shots.length - 1 && s.endSec - s.startSec < 4.9).length;
  const off = D.plan(input, { speakers, cameras, style: Object.assign({ minWideSec: 0 }, style) });
  const on = D.plan(input, { speakers, cameras, style: Object.assign({ minWideSec: 5 }, style) });
  assert.ok(shortWides(off) > 0, "fixture has short wides");
  assert.strictEqual(shortWides(on), 0, "no wide under 5 s");
});
