#!/usr/bin/env node
// CI: exercise the in-panel updater on Windows: find the package in a folder and install it silently.
//   node scripts/update-test.js <folder-with-PodDirector-x.y.z-Windows.zip>
"use strict";
const path = require("path"), fs = require("fs");
const U = require(path.join(__dirname, "..", "engine", "updater.js"));
const D = require(path.join(__dirname, "..", "engine", "director.js"));
(async () => {
  const r = await U.check({ current: "0.0.1", folder: path.resolve(process.argv[2]), github: false });
  if (!r.newer || r.latest.version !== D.VERSION) throw new Error("expected to find " + D.VERSION + ", got " + JSON.stringify(r));
  const t0 = Date.now();
  const res = await U.install(r.latest, (stage) => console.log("  " + stage));
  const ext = path.join(process.env.APPDATA, "Adobe", "CEP", "extensions", "PodDirector", "engine", "director.js");
  const installed = fs.readFileSync(ext, "utf8").match(/VERSION: "([^"]+)"/)[1];
  console.log("installed " + res.version + " in " + ((Date.now() - t0) / 1000).toFixed(1) + "s; extension reports " + installed);
  if (installed !== D.VERSION) throw new Error("installed version mismatch");
  console.log("UPDATE TEST PASSED");
})().catch((e) => { console.error("UPDATE TEST FAILED:", e.message); process.exit(1); });
