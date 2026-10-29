#!/usr/bin/env node
/*
 * PodDirector — batch camera-motion analysis for past episodes (meant to run unattended, e.g. over a weekend).
 *
 * For every finished edit found by tools/prproj.js, takes the camera files behind each non-wide multicam angle (the
 * operated / solo cameras), and runs PodDirector's motion analyzer over each whole file: motion per 1/6 s plus a
 * 32x18 thumbnail per second, saved next to a manifest. Resumable: files already done are skipped, so it can be
 * stopped and started again. Keeps the PC awake while it runs. Read-only on the footage and projects.
 *
 *   node tools/analyze_past.js --projects <folder> --out <dir> --ffmpeg <ffmpeg.exe> [--jobs 2] [--list]
 */
"use strict";
const fs = require("fs"), path = require("path"), cp = require("child_process");
const P = require("./prproj.js");
const M = require("../engine/motion.js");

const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const projects = arg("--projects"), outDir = arg("--out"), ffmpeg = arg("--ffmpeg", "ffmpeg");
const jobs = Math.max(1, Number(arg("--jobs", 1))), listOnly = process.argv.includes("--list");
if (!projects || !outDir) { console.error("usage: node tools/analyze_past.js --projects <folder> --out <dir> --ffmpeg <exe> [--jobs 2] [--list]"); process.exit(1); }
fs.mkdirSync(outDir, { recursive: true });
const logFile = path.join(outDir, "progress.log");
const log = (s) => { const line = new Date().toISOString().replace("T", " ").slice(0, 19) + "  " + s; console.log(line); fs.appendFileSync(logFile, line + "\n"); };

/** Every camera file an angle uses (following per-camera sequences like 243_a_cam down to the media). */
function filesOf(project, item, depth, out) {
  if (!item || !item.source || depth > 4) return out;
  if (item.source.media && /\.(mp4|mov|mxf)$/i.test(item.source.media)) { if (!out.includes(item.source.media)) out.push(item.source.media); return out; }
  const s = item.source.sequenceId && project.sequences.find((q) => q.id === item.source.sequenceId);
  if (s) s.video.forEach((t) => t.items.forEach((x) => filesOf(project, x, depth + 1, out)));
  return out;
}

function buildQueue() {
  const queue = [];
  P.findProjects(projects).forEach((f) => {
    let p, sum;
    try { p = P.readProject(f); sum = P.summarize(p, {}); } catch (e) { log("skip " + f + ": " + e.message); return; }
    if (!sum.edit || !sum.wideAngle || /Copy/.test(sum.edit)) return;
    const ep = (sum.edit.match(/\d{3}/) || ["?"])[0];
    const edit = P.mainEdit(p);
    const mcId = edit.video.flatMap((t) => t.items).find((i) => i.angle && i.source && i.source.sequenceId);
    const mc = mcId && p.sequences.find((s) => s.id === mcId.source.sequenceId);
    if (!mc) return;
    mc.video.forEach((t) => {
      const angle = t.index + 1;
      if (angle === sum.wideAngle) return;
      const files = [];
      t.items.forEach((it) => filesOf(p, it, 0, files));
      files.forEach((media) => queue.push({ ep, edit: sum.edit, project: f, angle, media }));
    });
  });
  // Newest episodes first.
  return queue.sort((a, b) => b.ep.localeCompare(a.ep) || a.media.localeCompare(b.media));
}

function duration(file) {
  const r = cp.spawnSync(ffmpeg, ["-hide_banner", "-i", file], { encoding: "utf8", windowsHide: true });
  const m = /Duration: (\d+):(\d+):([\d.]+)/.exec(r.stderr || "");
  return m ? +m[1] * 3600 + +m[2] * 60 + +m[3] : 0;
}

/** Ask Windows not to sleep while this runs (like a video renderer does); no settings are changed. */
function keepAwake() {
  if (process.platform !== "win32") return null;
  const ps = "Add-Type -Name P -Namespace W -MemberDefinition '[DllImport(\"kernel32.dll\")] public static extern uint SetThreadExecutionState(uint f);';" +
    "while ($true) { [W.P]::SetThreadExecutionState(0x80000001) | Out-Null; Start-Sleep -Seconds 60 }";
  const k = cp.spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], { windowsHide: true, stdio: "ignore" });
  return k;
}

(async () => {
  const queue = buildQueue();
  const manifestFile = path.join(outDir, "manifest.json");
  const manifest = fs.existsSync(manifestFile) ? JSON.parse(fs.readFileSync(manifestFile, "utf8")) : {};
  const todo = queue.filter((q) => !(manifest[q.media] && manifest[q.media].done));
  log("queue: " + queue.length + " camera files across " + new Set(queue.map((q) => q.ep)).size + " episodes; " + todo.length + " to do");
  if (listOnly) { todo.forEach((q) => console.log(q.ep, "angle " + q.angle, q.media)); return; }
  const awake = keepAwake();
  const t0 = Date.now();
  let next = 0, done = 0, failed = 0;
  async function worker() {
    while (next < todo.length) {
      const q = todo[next++], name = path.basename(q.media).replace(/\.[^.]+$/, "");
      const started = Date.now();
      try {
        if (!fs.existsSync(q.media)) throw new Error("file not found");
        const dur = duration(q.media);
        if (!dur) throw new Error("couldn't read the duration");
        log("start " + q.ep + " angle " + q.angle + " " + name + " (" + Math.round(dur / 60) + " min)");
        const r = await M.analyzeRange(q.media, 0, dur, { ffmpegPath: ffmpeg });
        fs.mkdirSync(path.join(outDir, q.ep), { recursive: true });
        const base = path.join(outDir, q.ep, name);
        fs.writeFileSync(base + ".motion.f32", Buffer.from(r.values.buffer));
        fs.writeFileSync(base + ".thumbs.rgb", Buffer.from(r.thumbs.buffer));
        const known = Array.from(r.values).filter((v) => !Number.isNaN(v));
        manifest[q.media] = { done: true, ep: q.ep, edit: q.edit, project: q.project, angle: q.angle, durationSec: dur,
          hopSec: M.HOP, thumbs: { w: M.TW, h: M.TH, hopSec: 1 }, files: { motion: base + ".motion.f32", thumbs: base + ".thumbs.rgb" },
          readablePct: Math.round(100 * known.length / Math.max(1, r.values.length)), secs: Math.round((Date.now() - started) / 1000) };
        fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 1));
        done++;
        const left = todo.length - done - failed, per = (Date.now() - t0) / (done + failed) / jobs;
        log("done  " + q.ep + " " + name + " in " + Math.round((Date.now() - started) / 60000) + " min; " + left + " left, about " +
          Math.round(left * per / 3600000 * 10) / 10 + " h to go");
      } catch (e) {
        failed++;
        manifest[q.media] = { done: false, ep: q.ep, error: e.message };
        fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 1));
        log("FAIL  " + q.ep + " " + name + ": " + e.message);
      }
    }
  }
  await Promise.all(Array.from({ length: jobs }, worker));
  if (awake) awake.kill();
  log("finished: " + done + " done, " + failed + " failed, " + Math.round((Date.now() - t0) / 60000) + " min");
})().catch((e) => { log("crashed: " + (e.stack || e.message)); process.exit(1); });
