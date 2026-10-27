"use strict";
// Runs host/host.jsx against a small fake of Premiere's scripting DOM (incl. QE razor)
// and checks that a planned cut ends up with exactly one enabled camera at every moment.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const D = require("../engine/director.js");
const { makeCurves } = require("./synth.js");

const TPS = 254016000000;
const FPS = 30, TPF = TPS / FPS;

function fakePremiere(durationSec, nCams) {
  const tick = (sec) => ({ ticks: String(Math.round(sec * TPS)) });
  function clipsOf(list) { const o = list.slice(); o.numItems = list.length; return o; }
  function makeTrack(name, media) {
    const t = { name, _clips: [{ name: media, start: tick(0), end: tick(durationSec), inPoint: tick(0), disabled: false,
      projectItem: { getMediaPath: () => "C:/media/" + media } }] };
    Object.defineProperty(t, "clips", { get: () => clipsOf(t._clips) });
    return t;
  }
  const video = []; for (let i = 0; i < nCams; i++) video.push(makeTrack("V" + (i + 1), "cam" + i + ".mp4"));
  const audio = [makeTrack("Host", "host.wav"), makeTrack("Guest", "guest.wav")];
  audio.forEach((a) => { a.isMuted = () => false; });
  const markers = [];
  const seq = {
    name: "Ep 1", sequenceID: "seq-1", timebase: String(TPF), end: String(durationSec * TPS),
    videoTracks: Object.assign(video, { numTracks: video.length }),
    audioTracks: Object.assign(audio, { numTracks: audio.length }),
    markers: {
      createMarker(s) { const m = { start: s, name: "", comments: "", setColorByIndex(i) { this.color = i; } }; markers.push(m); return m; },
      getFirstMarker: () => markers[0] || null,
      getNextMarker: (m) => markers[markers.indexOf(m) + 1] || null,
      deleteMarker: (m) => markers.splice(markers.indexOf(m), 1)
    },
    getSettings: () => { throw new Error("use fallback timecode"); },
    getPlayerPosition: () => tick(0), setPlayerPosition() {},
    clone() { const c = Object.assign({}, seq, { sequenceID: "seq-2", name: "Ep 1 Copy" }); sequences.push(c); }
  };
  const sequences = [seq];
  const project = { name: "P", sequences: new Proxy(sequences, { get: (t, k) => k === "numSequences" ? t.length : t[k] }),
    get activeSequence() { return active; }, openSequence(id) { active = sequences.find((s) => s.sequenceID === id); } };
  let active = seq;
  const qeTrack = (i) => ({
    razor(tc) {
      const [h, m, s, f] = tc.split(":").map(Number);
      const frame = ((h * 60 + m) * 60 + s) * FPS + f;
      const ticks = frame * TPF;
      const tr = video[i];
      const idx = tr._clips.findIndex((c) => +c.start.ticks < ticks && +c.end.ticks > ticks);
      if (idx < 0) throw new Error("no clip");
      const c = tr._clips[idx];
      const right = Object.assign({}, c, { start: { ticks: String(ticks) } });
      c.end = { ticks: String(ticks) };
      tr._clips.splice(idx + 1, 0, right);
    }
  });
  const ctx = {
    app: { version: "26.0", project, enableQE() {} },
    qe: { project: { getActiveSequence: () => ({ getVideoTrackAt: qeTrack }) } },
    Time: function () { this.ticks = "0"; }, JSON, Math, String, parseFloat, isFinite
  };
  return { ctx, seq, video, markers };
}

test("host applies a planned cut: razors and enables exactly one camera per shot", () => {
  const dur = 40;
  const fake = fakePremiere(dur, 3);
  vm.createContext(fake.ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "host", "host.jsx"), "utf8").replace("#target premierepro", ""), fake.ctx);
  const call = (expr) => JSON.parse(vm.runInContext(expr, fake.ctx));

  const info = call("PD.getSequenceInfo()");
  assert.ok(info.ok);
  assert.equal(info.durationSec, dur);
  assert.equal(info.videoTracks[0].mediaPaths[0], "C:/media/cam0.mp4");

  const cameras = [{ id: "a", videoTrack: 0, shows: ["H"] }, { id: "b", videoTrack: 1, shows: ["G"] }, { id: "w", videoTrack: 2, shows: ["H", "G"] }];
  const input = makeCurves([["H", 1, 12], ["G", 12.4, 25], ["H", 25.5, 38]], { durationSec: dur, speakers: ["H", "G"] });
  const plan = D.plan(input, { speakers: [{ id: "H", name: "Host" }, { id: "G", name: "Guest" }], cameras });
  const payload = D.toEditPayload(plan, cameras, FPS);

  const dup = call('PD.duplicateActive("seq-1", " - PD")');
  assert.ok(dup.ok, dup.error);
  for (const t of payload.cameraTracks) {
    const r = call("PD.razorTrack(" + JSON.stringify(JSON.stringify({ sequenceID: dup.sequenceID, track: t, frames: payload.cutFrames })) + ")");
    assert.ok(r.ok, r.error);
    assert.equal(r.razored, payload.cutFrames.length);
  }
  const en = call("PD.applyEnables(" + JSON.stringify(JSON.stringify({ sequenceID: dup.sequenceID, cameraTracks: payload.cameraTracks, shots: payload.shots })) + ")");
  assert.ok(en.ok, en.error);

  // At sample times, exactly one camera clip is enabled and it matches the plan.
  for (let t = 0.5; t < dur; t += 0.5) {
    const ticks = t * TPS;
    const enabled = fake.video.map((tr, i) => {
      const c = tr._clips.find((x) => +x.start.ticks <= ticks && +x.end.ticks > ticks);
      return c && !c.disabled ? i : -1;
    }).filter((i) => i >= 0);
    const want = cameras.find((c) => c.id === plan.shots.find((s) => s.startSec <= t && s.endSec > t).cameraId).videoTrack;
    assert.deepEqual(enabled, [want], "at " + t + "s");
  }

  const mk = call("PD.addMarkers(" + JSON.stringify(JSON.stringify({ prefix: "[PD] ", markers: [{ startSec: 1, name: "Wide", color: 6 }, { startSec: 3, endSec: 5, name: "cut", color: 1 }] })) + ")");
  assert.equal(mk.added, 2);
  assert.equal(fake.markers[1].end, 5);
  assert.equal(call('PD.clearMarkers("[PD] ")').removed, 2);
});

test("host refuses to edit when the wrong sequence is active", () => {
  const fake = fakePremiere(10, 2);
  vm.createContext(fake.ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "host", "host.jsx"), "utf8").replace("#target premierepro", ""), fake.ctx);
  const r = JSON.parse(vm.runInContext('PD.razorTrack(' + JSON.stringify(JSON.stringify({ sequenceID: "other", track: 0, frames: [30] })) + ")", fake.ctx));
  assert.equal(r.ok, false);
  assert.match(r.error, /Refusing/);
});

test("recut in place: a second plan applied over the first ends up exactly as the second plan", () => {
  const dur = 40;
  const fake = fakePremiere(dur, 3);
  vm.createContext(fake.ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "host", "host.jsx"), "utf8").replace("#target premierepro", ""), fake.ctx);
  const call = (expr) => JSON.parse(vm.runInContext(expr, fake.ctx));
  const cameras = [{ id: "a", videoTrack: 0, shows: ["H"] }, { id: "b", videoTrack: 1, shows: ["G"] }, { id: "w", videoTrack: 2, shows: ["H", "G"] }];
  const input = makeCurves([["H", 1, 12], ["G", 12.4, 25], ["H", 25.5, 38]], { durationSec: dur, speakers: ["H", "G"] });
  const speakersHG = [{ id: "H", name: "Host" }, { id: "G", name: "Guest" }];
  const write = (seqId, payload) => {
    for (const t of payload.cameraTracks) call("PD.razorTrack(" + JSON.stringify(JSON.stringify({ sequenceID: seqId, track: t, frames: payload.cutFrames })) + ")");
    return call("PD.applyEnables(" + JSON.stringify(JSON.stringify({ sequenceID: seqId, cameraTracks: payload.cameraTracks, shots: payload.shots })) + ")");
  };
  const dup = call('PD.duplicateActive("seq-1", " - PD")');
  const p1 = D.toEditPayload(D.plan(input, { speakers: speakersHG, cameras, preset: "calm" }), cameras, FPS);
  write(dup.sequenceID, p1);
  assert.ok(call('PD.openSequenceById("' + dup.sequenceID + '")').ok);
  const plan2 = D.plan(input, { speakers: speakersHG, cameras, preset: "social" });
  write(dup.sequenceID, D.toEditPayload(plan2, cameras, FPS));
  for (let t = 0.5; t < dur; t += 0.5) {
    const ticks = t * TPS;
    const enabled = fake.video.map((tr, i) => { const c = tr._clips.find((x) => +x.start.ticks <= ticks && +x.end.ticks > ticks); return c && !c.disabled ? i : -1; }).filter((i) => i >= 0);
    const want = cameras.find((c) => c.id === plan2.shots.find((s) => s.startSec <= t && s.endSec > t).cameraId).videoTrack;
    assert.deepEqual(enabled, [want], "at " + t + "s");
  }
  assert.equal(call('PD.openSequenceById("nope")').ok, false);
});

test("host sets the sequence In point at the welcome", () => {
  const fake = fakePremiere(60, 2);
  let inSec = null;
  fake.seq.setInPoint = (v) => { inSec = Number(v); };
  fake.seq.getInPoint = () => String(inSec);
  fake.seq.getOutPoint = () => "60";
  vm.createContext(fake.ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "host", "host.jsx"), "utf8").replace("#target premierepro", ""), fake.ctx);
  const r = JSON.parse(vm.runInContext("PD.setInOut(" + JSON.stringify(JSON.stringify({ inSec: 12.5 })) + ")", fake.ctx));
  assert.ok(r.ok, r.error);
  assert.equal(inSec, 12.5);
  assert.equal(r.inSec, 12.5);
});
