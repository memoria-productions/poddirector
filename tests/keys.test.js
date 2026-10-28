"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const K = require("../engine/keys.js");

// The shape of a Premiere 2025 [Custom].kys (trimmed).
const KYS = `<?xml version="1.0" encoding="UTF-8"?>
<PremiereData Version="3"><shortcuts Version="5">
  <context.program.monitor Version="1">
    <item.57 Version="1"><virtualkey>2147483730</virtualkey><modifier.ctrl>true</modifier.ctrl><modifier.alt>false</modifier.alt><modifier.shift>false</modifier.shift><commandname>cmd.monitor.rulers</commandname></item.57>
  </context.program.monitor>
  <context.global Version="1">
    <item.410 Version="1"><virtualkey>2147483697</virtualkey><modifier.ctrl>true</modifier.ctrl><modifier.alt>false</modifier.alt><modifier.shift>false</modifier.shift><commandname>cmd.multicam.choose.camera.1</commandname></item.410>
    <item.411 Version="1"><commandname>cmd.multicam.choose.camera.10</commandname></item.411>
    <item.418 Version="1"><virtualkey>2147483698</virtualkey><modifier.ctrl>true</modifier.ctrl><modifier.alt>false</modifier.alt><modifier.shift>false</modifier.shift><commandname>cmd.multicam.choose.camera.2</commandname></item.418>
    <item.419 Version="1"><virtualkey>43</virtualkey><modifier.ctrl>false</modifier.ctrl><modifier.alt>true</modifier.alt><modifier.shift>false</modifier.shift><commandname>cmd.multicam.choose.camera.3</commandname></item.419>
    <item.426 Version="1"><virtualkey>2147483697</virtualkey><modifier.ctrl>false</modifier.ctrl><modifier.alt>false</modifier.alt><modifier.shift>false</modifier.shift><commandname>cmd.multicam.choosenocut.camera1</commandname></item.426>
  </context.global>
</shortcuts></PremiereData>`;

test("reads the Cut to Camera shortcuts from a .kys file", () => {
  const s = K.parseShortcuts(KYS);
  assert.deepEqual(s["cmd.multicam.choose.camera.1"][0], { key: "1", code: 0x31, ctrl: true, alt: false, shift: false, context: "global" });
  assert.equal(s["cmd.monitor.rulers"][0].context, "program.monitor");
  const cams = K.cutToCameraKeys(s, 4);
  assert.deepEqual(cams.map((c) => c.label), ["Ctrl+1", "Ctrl+2", "Alt+key #43", null]);
  assert.ok(cams[0].usable && cams[1].usable);
  assert.equal(cams[2].usable, null, "a special key (arrow, F-key) can't be typed by the helper");
  assert.equal(cams[3].usable, null, "camera 4 has no shortcut");
});
