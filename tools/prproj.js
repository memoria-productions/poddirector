#!/usr/bin/env node
/*
 * PodDirector — read finished edits straight from Premiere project files (.prproj), no Premiere needed.
 *
 * A .prproj is gzipped XML: a flat list of objects (sequences, tracks, track items, clips, media) that point at
 * each other by ObjectID / ObjectUID. This walks sequence -> track group -> track -> track item -> subclip -> clip
 * -> source, and for multicam pieces reads <SelectedTrackIndex>: the camera angle that piece shows.
 *
 *   node tools/prproj.js <file.prproj | folder> [--out <dir>] [--all] [--aperture]
 *
 * With a folder, every .prproj below it is read (Auto-Save copies skipped). Read-only: project files are never
 * written. --out writes one <episode>.edit.json per project; without it a summary is printed. The wide is the angle
 * shot on the 24-70 (from the Sony sidecar XML); --aperture settles ties or missing sidecars by the f-number
 * (exiftool, slow; cached in <out>/apertures.json).
 */
"use strict";
const fs = require("fs"), path = require("path"), zlib = require("zlib");

const TICKS = 254016000000; // Premiere ticks per second

function loadXml(file) {
  const buf = fs.readFileSync(file);
  return (buf[0] === 0x1f && buf[1] === 0x8b ? zlib.gunzipSync(buf) : buf).toString("utf8");
}

/** Top-level objects by ObjectID / ObjectUID: { id: { tag, text } }. */
function indexObjects(xml) {
  const objs = {}, re = /^\t<(\w+) Object(?:U)?ID="([^"]+)"[^>]*>$/gm;
  let m;
  while ((m = re.exec(xml))) {
    const close = "\n\t</" + m[1] + ">", end = xml.indexOf(close, m.index);
    if (end < 0) continue;
    objs[m[2]] = { tag: m[1], text: xml.slice(m.index, end + close.length) };
  }
  return objs;
}

const one = (text, tag) => { const m = new RegExp("<" + tag + ">([^<]*)</" + tag + ">").exec(text); return m ? m[1] : null; };
const num = (text, tag, dflt) => { const v = one(text, tag); return v === null ? dflt : Number(v); };
const refs = (text, tag) => [...text.matchAll(new RegExp("<" + tag + " Index=\"(\\d+)\" ObjectU?Ref=\"([^\"]+)\"/>", "g"))]
  .map((m) => ({ index: Number(m[1]), ref: m[2] })).sort((a, b) => a.index - b.index);
const ref = (text, tag) => { const m = new RegExp("<" + tag + " ObjectU?Ref=\"([^\"]+)\"/>").exec(text); return m ? m[1] : null; };
const sec = (ticks) => Math.round(ticks / TICKS * 1000) / 1000;
const LABEL = ["Violet", "Iris", "Caribbean", "Lavender", "Cerulean", "Forest", "Rose", "Mango",
  "Purple", "Blue", "Teal", "Magenta", "Tan", "Green", "Brown", "Yellow"];

function readProject(file) {
  const xml = loadXml(file), objs = indexObjects(xml);
  const get = (id) => (id && objs[id]) || null;
  const seqName = (id) => { const s = get(id); return s ? (/\n\t\t<Name>([^<]*)<\/Name>/.exec(s.text) || [])[1] || null : null; };

  function source(clipText) {
    const s = get(ref(clipText, "Source"));
    if (!s) return null;
    if (/SequenceSource$/.test(s.tag)) { const id = ref(s.text, "Sequence"); return { sequence: seqName(id), sequenceId: id }; }
    const media = get(ref(s.text, "Media"));
    if (!media) return null;
    const p = one(media.text, "ActualMediaFilePath") || one(media.text, "FilePath");
    return { media: /^\d+$/.test(p || "") ? null : p, title: one(media.text, "Title") };
  }

  function item(id) {
    const ti = get(id);
    if (!ti) return null;
    const sub = get(ref(ti.text, "SubClip")), clip = sub && get(ref(sub.text, "Clip"));
    const out = { start: sec(num(ti.text, "Start", 0)), end: sec(num(ti.text, "End", 0)), name: sub ? one(sub.text, "Name") : null };
    if (clip) {
      out.inPoint = sec(num(clip.text, "InPoint", 0));
      out.outPoint = sec(num(clip.text, "OutPoint", 0));
      const lab = /LabelColors\.(\d+)/.exec(one(clip.text, "asl.clip.label.name") || "");
      if (lab) out.label = LABEL[Number(lab[1])] || Number(lab[1]);
      if (one(clip.text, "IsMulticam") === "true") out.angle = num(clip.text, "SelectedTrackIndex", 0) + 1;
      out.source = source(clip.text);
    }
    return out;
  }

  function tracks(groupId) {
    const g = get(groupId);
    if (!g) return null;
    const frame = num(g.text, "FrameRate", 0);
    return {
      kind: /^Video/.test(g.tag) ? "video" : /^Audio/.test(g.tag) ? "audio" : "data",
      frameTicks: frame,
      tracks: refs(g.text, "Track").map((t) => {
        const tr = get(t.ref);
        if (!tr) return { index: t.index, items: [] };
        const clipItems = (/<ClipItems[\s\S]*?<\/ClipItems>/.exec(tr.text) || [""])[0];
        return { index: t.index, muted: one(tr.text, "IsMuted") === "true",
          items: refs(clipItems, "TrackItem").map((r) => item(r.ref)).filter(Boolean).sort((a, b) => a.start - b.start) };
      })
    };
  }

  const sequences = Object.keys(objs).filter((id) => objs[id].tag === "Sequence").map((id) => {
    const s = objs[id], groups = refs(s.text.replace(/<TrackGroup Version="1" Index="(\d+)">\s*<First>[^<]*<\/First>\s*<Second ObjectRef="(\d+)"\/>/g,
      '<Group Index="$1" ObjectRef="$2"/>'), "Group").map((r) => tracks(r.ref)).filter(Boolean);
    const video = groups.find((g) => g.kind === "video") || { tracks: [], frameTicks: 0 };
    const audio = groups.find((g) => g.kind === "audio") || { tracks: [] };
    const all = video.tracks.concat(audio.tracks).flatMap((t) => t.items);
    return {
      id, name: seqName(id),
      fps: video.frameTicks ? Math.round(TICKS / video.frameTicks * 1000) / 1000 : null,
      durationSec: all.reduce((m, i) => Math.max(m, i.end), 0),
      video: video.tracks, audio: audio.tracks
    };
  });
  return { file, sequences };
}

/** The finished multicam edit: the sequence with the most multicam pieces. */
function mainEdit(project) {
  let best = null, n = 0;
  project.sequences.forEach((s) => {
    const k = s.video.flatMap((t) => t.items).filter((i) => i.angle).length;
    if (k > n) { n = k; best = s; }
  });
  return best;
}

function summarize(project, opts) {
  const s = mainEdit(project);
  if (!s) return { file: project.file, sequences: project.sequences.length, edit: null };
  const pieces = s.video.flatMap((t) => t.items.map((i) => Object.assign({ track: t.index }, i))).filter((i) => i.angle);
  const time = {};
  pieces.forEach((p) => { time[p.angle] = (time[p.angle] || 0) + p.end - p.start; });
  const total = Object.values(time).reduce((a, b) => a + b, 0);
  const sum = {
    file: project.file, edit: s.name, fps: s.fps, durationSec: Math.round(s.durationSec),
    pieces: pieces.length, cutsPerMin: Math.round(10 * (pieces.length - 1) / (total / 60)) / 10,
    anglePct: Object.fromEntries(Object.keys(time).map((a) => [a, Math.round(100 * time[a] / total)])),
    sources: [...new Set(pieces.map((p) => p.source && p.source.sequence).filter(Boolean))],
    angles: angleInfo(project, pieces, opts)
  };
  const w = Object.keys(sum.angles).find((k) => sum.angles[k].wide);
  sum.wideAngle = w ? Number(w) : null;
  sum.widePct = w ? sum.anglePct[w] : null;
  return sum;
}

/**
 * What each angle of the multicam source is: { 1: { name, media, lens, wide }, ... } from the source sequence's
 * video tracks. Each angle is followed down (through per-camera sequences like 243_b_cam) to its camera file; the
 * Sony sidecar (<file>M01.XML) names the lens. The static wide is shot on the 24-70.
 */
function angleInfo(project, pieces, opts) {
  const ids = [...new Set(pieces.map((p) => p.source && p.source.sequenceId).filter(Boolean))];
  const out = {};
  ids.forEach((id) => {
    const src = project.sequences.find((s) => s.id === id);
    if (!src) return;
    src.video.forEach((t) => {
      const it = t.items[0], n = t.index + 1;
      if (!it || out[n]) return;
      const media = mediaOf(project, it, 0);
      const lens = media ? lensOf(media) : null;
      out[n] = { name: it.name || (it.source && (it.source.sequence || it.source.title)) || null, media, lens };
    });
  });
  const keys = Object.keys(out);
  const wide = keys.filter((k) => out[k].lens && WIDE_LENS.test(out[k].lens));
  if (wide.length === 1) { out[wide[0]].wide = true; out[wide[0]].wideBy = "lens"; return out; }
  // Two 24-70s, or no sidecars: the wide is stopped down (around f/8), the others shot open.
  if (opts && opts.aperture) {
    const cands = (wide.length ? wide : keys).filter((k) => out[k].media);
    cands.forEach((k) => { out[k].fNumber = apertureOf(out[k].media, opts.cache); });
    const best = cands.filter((k) => out[k].fNumber).sort((a, b) => out[b].fNumber - out[a].fNumber)[0];
    if (best && out[best].fNumber >= 5.6) { out[best].wide = true; out[best].wideBy = "aperture"; }
  }
  return out;
}
const WIDE_LENS = /24-70/;

/**
 * The aperture a Sony clip was shot at (its most common FNumber), read by exiftool from the per-frame metadata.
 * Slow (the camera spreads it through the whole file: minutes per 30 GB clip), so results are cached by path.
 */
function apertureOf(media, cache) {
  if (cache && media in cache.data) return cache.data[media];
  let f = null;
  try {
    const exe = process.env.EXIFTOOL || "exiftool";
    const out = require("child_process").execFileSync(exe, ["-ee", "-s3", "-FNumber", "-api", "LargeFileSupport=1", media],
      { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, windowsHide: true });
    const counts = {};
    out.split(/\r?\n/).filter(Boolean).forEach((v) => { counts[v] = (counts[v] || 0) + 1; });
    const top = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0];
    f = top ? Number(top) : null;
  } catch (e) { f = null; }
  if (cache) { cache.data[media] = f; cache.save(); }
  return f;
}

/** The camera file behind a piece: its media, or the first video file of the sequence it plays. */
function mediaOf(project, it, depth) {
  if (!it || !it.source || depth > 4) return null;
  if (it.source.media && /\.(mp4|mov|mxf)$/i.test(it.source.media)) return it.source.media;
  const s = it.source.sequenceId && project.sequences.find((q) => q.id === it.source.sequenceId);
  if (!s) return null;
  for (const t of s.video) for (const x of t.items) { const m = mediaOf(project, x, depth + 1); if (m) return m; }
  return null;
}

/** Lens model from a Sony clip's sidecar XML (<clip>M01.XML), or null. */
function lensOf(media) {
  const side = media.replace(/\.(mp4|mov|mxf)$/i, "M01.XML");
  try { const m = /<Lens modelName="([^"]*)"/.exec(fs.readFileSync(side, "utf8")); return m ? m[1] : null; }
  catch (e) { return null; }
}

function findProjects(dir) {
  const out = [];
  (function walk(d, depth) {
    let list = [];
    try { list = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
    list.forEach((e) => {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (depth < 6 && !/auto-save/i.test(e.name)) walk(p, depth + 1); }
      else if (/\.prproj$/i.test(e.name)) out.push(p);
    });
  })(dir, 0);
  return out.sort();
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const outAt = args.indexOf("--out"), outDir = outAt >= 0 ? args[outAt + 1] : null;
  const target = args.find((a, i) => !a.startsWith("--") && (outAt < 0 || i !== outAt + 1));
  if (!target) { console.error("usage: node tools/prproj.js <file.prproj | folder> [--out <dir>]"); process.exit(1); }
  const files = fs.statSync(target).isDirectory() ? findProjects(target) : [target];
  if (outDir) fs.mkdirSync(outDir, { recursive: true });
  const cacheFile = path.join(outDir || ".", "apertures.json");
  const cache = { data: fs.existsSync(cacheFile) ? JSON.parse(fs.readFileSync(cacheFile, "utf8")) : {},
    save() { fs.writeFileSync(cacheFile, JSON.stringify(this.data, null, 1)); } };
  const opts = { aperture: args.includes("--aperture"), cache };
  files.forEach((f) => {
    try {
      const p = readProject(f), sum = summarize(p, opts);
      if (outDir) {
        const edit = mainEdit(p);
        const name = path.basename(f).replace(/\.prproj$/i, "");
        fs.writeFileSync(path.join(outDir, name + ".edit.json"), JSON.stringify({ summary: sum, edit, sequences: args.includes("--all") ? p.sequences : undefined }));
      }
      console.log(JSON.stringify(sum));
    } catch (e) { console.log(JSON.stringify({ file: f, error: e.message })); }
  });
}

module.exports = { readProject, mainEdit, summarize, findProjects, TICKS };
