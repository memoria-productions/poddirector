"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const U = require("../engine/updater.js");

const manifest = fs.readFileSync(path.join(__dirname, "..", "CSXS", "manifest.xml"), "utf8");

function write(dir, name, text) { const f = path.join(dir, name); fs.writeFileSync(f, text); return f; }

test("an update that only bumps the version needs no Premiere restart", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pd-upd-"));
  const old = write(dir, "old.xml", manifest);
  const bumped = write(dir, "new.xml", manifest.replace(/ExtensionBundleVersion="[\d.]+"/, 'ExtensionBundleVersion="9.9.9"')
    .replace(/<Extension Id="com.poddirector.panel" Version="[\d.]+"\/>/, '<Extension Id="com.poddirector.panel" Version="9.9.9"/>')
    .replace(/\n/g, "\r\n"));
  assert.equal(U.needsRestart(old, bumped), false);
});

test("a real manifest change, or an unreadable manifest, asks for a restart", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pd-upd-"));
  const old = write(dir, "old.xml", manifest);
  const changed = write(dir, "new.xml", manifest.replace("<Menu>PodCutter</Menu>", "<Menu>PodCutter Pro</Menu>"));
  assert.equal(U.needsRestart(old, changed), true);
  assert.equal(U.needsRestart(old, path.join(dir, "missing.xml")), true);
});
