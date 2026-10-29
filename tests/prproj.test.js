"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), os = require("os"), path = require("path"), zlib = require("zlib");
const P = require("../tools/prproj.js");

const T = P.TICKS;
// The shape of a Premiere 25 project (trimmed): an edit sequence with two multicam pieces on V1 and a lower third
// on V2, and the multicam source sequence it plays.
const clip = (id, src, a, b, extra) => `\t<VideoClip ObjectID="${id}" ClassID="x" Version="11">
\t\t<Clip Version="18">
\t\t\t<Node Version="1"><Properties Version="1"><asl.clip.label.name>BE.Prefs.LabelColors.${extra.label}</asl.clip.label.name></Properties></Node>
\t\t\t<Source ObjectRef="${src}"/>
\t\t\t<InPoint>${a * T}</InPoint>
\t\t\t<OutPoint>${b * T}</OutPoint>
${extra.angle ? `\t\t\t<IsMulticam>true</IsMulticam>\n\t\t\t<SelectedTrackIndex>${extra.angle - 1}</SelectedTrackIndex>\n` : ""}\t\t</Clip>
\t</VideoClip>`;
const item = (id, sub, a, b) => `\t<VideoClipTrackItem ObjectID="${id}" ClassID="x" Version="8">
\t\t<ClipTrackItem Version="8">
\t\t\t<TrackItem Version="3">
${a ? `\t\t\t\t<Start>${a * T}</Start>\n` : ""}\t\t\t\t<End>${b * T}</End>
\t\t\t</TrackItem>
\t\t\t<SubClip ObjectRef="${sub}"/>
\t\t</ClipTrackItem>
\t</VideoClipTrackItem>`;
const sub = (id, c, name) => `\t<SubClip ObjectID="${id}" ClassID="x" Version="6">
\t\t<Clip ObjectRef="${c}"/>
\t\t<Name>${name}</Name>
\t</SubClip>`;
const track = (uid, items) => `\t<VideoClipTrack ObjectUID="${uid}" ClassID="x" Version="1">
\t\t<ClipTrack Version="2">
\t\t\t<Track Version="3"><IsMuted>false</IsMuted></Track>
\t\t\t<ClipItems Version="3">
\t\t\t\t<TrackItems Version="1">
${items.map((r, i) => `\t\t\t\t\t<TrackItem Index="${i}" ObjectRef="${r}"/>`).join("\n")}
\t\t\t\t</TrackItems>
\t\t\t</ClipItems>
\t\t</ClipTrack>
\t</VideoClipTrack>`;
const group = (id, uids) => `\t<VideoTrackGroup ObjectID="${id}" ClassID="x" Version="13">
\t\t<TrackGroup Version="1">
\t\t\t<Tracks Version="1">
${uids.map((u, i) => `\t\t\t\t<Track Index="${i}" ObjectURef="${u}"/>`).join("\n")}
\t\t\t</Tracks>
\t\t\t<FrameRate>10594584000</FrameRate>
\t\t</TrackGroup>
\t</VideoTrackGroup>`;
const seq = (uid, g, name) => `\t<Sequence ObjectUID="${uid}" ClassID="x" Version="11">
\t\t<TrackGroups Version="1">
\t\t\t<TrackGroup Version="1" Index="0">
\t\t\t\t<First>228cda18</First>
\t\t\t\t<Second ObjectRef="${g}"/>
\t\t\t</TrackGroup>
\t\t</TrackGroups>
\t\t<Name>${name}</Name>
\t</Sequence>`;
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "pd-prproj-"));
const CAM_B = path.join(DIR, "20261012_A7S3-3_5218.MP4"), CAM_A = path.join(DIR, "20261012_A7S3_1_5524.MP4");
const media = (id, uid, file) => `	<VideoMediaSource ObjectID="${id}" ClassID="x" Version="2">
		<MediaSource Version="4">
			<Media ObjectURef="${uid}"/>
		</MediaSource>
	</VideoMediaSource>
	<Media ObjectUID="${uid}" ClassID="x" Version="30">
		<ActualMediaFilePath>${file}</ActualMediaFilePath>
	</Media>`;
const XML = `<?xml version="1.0" encoding="UTF-8" ?>
<PremiereData Version="3">
${seq("edit-uid", 1, "classical_et_cetera_999")}
${group(1, ["t-v1", "t-v2"])}
${track("t-v1", [10, 11])}
${track("t-v2", [12])}
${item(10, 20, 0, 15)}
${item(11, 21, 15, 40)}
${item(12, 22, 16, 24)}
${sub(20, 30, "999_mc")}
${sub(21, 31, "999_mc")}
${sub(22, 32, "lower_third_martin.mov")}
${clip(30, 40, 100, 115, { label: 5, angle: 1 })}
${clip(31, 40, 115, 140, { label: 6, angle: 2 })}
${clip(32, 41, 0, 8, { label: 0 })}
\t<VideoSequenceSource ObjectID="40" ClassID="x" Version="3">
\t\t<SequenceSource Version="4">
\t\t\t<Sequence ObjectURef="mc-uid"/>
\t\t</SequenceSource>
\t</VideoSequenceSource>
\t<VideoMediaSource ObjectID="41" ClassID="x" Version="2">
\t\t<MediaSource Version="4">
\t\t\t<Media ObjectURef="m-uid"/>
\t\t</MediaSource>
\t</VideoMediaSource>
\t<Media ObjectUID="m-uid" ClassID="x" Version="30">
\t\t<ActualMediaFilePath>M:\\graphics\\lower_third_martin.mov</ActualMediaFilePath>
\t\t<Title>lower_third_martin.mov</Title>
\t</Media>
${seq("mc-uid", 2, "999_mc")}
${group(2, ["t-a", "t-b"])}
${track("t-a", [50])}
${track("t-b", [51])}
${item(50, 60, 0, 3000)}
${item(51, 61, 0, 3000)}
${sub(60, 70, "999_b_cam")}
${sub(61, 71, "999_a_cam")}
${clip(70, 42, 0, 3000, { label: 5 })}
${clip(71, 43, 0, 3000, { label: 5 })}
${media(42, "m-b", CAM_B)}
${media(43, "m-a", CAM_A)}
</PremiereData>`;

test("reads a finished multicam edit from a project file: pieces, angles, labels, sources", () => {
  const file = path.join(os.tmpdir(), "pd-test-" + process.pid + ".prproj");
  fs.writeFileSync(file, zlib.gzipSync(XML));
  try {
    const p = P.readProject(file);
    assert.deepEqual(p.sequences.map((s) => s.name).sort(), ["999_mc", "classical_et_cetera_999"]);
    const edit = P.mainEdit(p);
    assert.equal(edit.name, "classical_et_cetera_999");
    assert.equal(edit.fps, 23.976);
    const v1 = edit.video[0].items;
    assert.deepEqual(v1.map((i) => [i.start, i.end, i.angle, i.label]), [[0, 15, 1, "Forest"], [15, 40, 2, "Rose"]]);
    assert.equal(v1[1].inPoint, 115);
    assert.equal(v1[0].source.sequence, "999_mc");
    assert.equal(edit.video[1].items[0].source.media, "M:\\graphics\\lower_third_martin.mov");
    const s = P.summarize(p);
    assert.equal(s.pieces, 2);
    assert.deepEqual(s.anglePct, { 1: 38, 2: 63 });
    assert.deepEqual([s.angles[1].name, s.angles[2].name], ["999_b_cam", "999_a_cam"]);
    assert.equal(s.wideAngle, null, "no sidecars to read the lens from");
    // The Sony sidecars name the lens: the static wide is the 24-70, whichever camera number it ended up on.
    const side = (lens) => `<NonRealTimeMeta><Device manufacturer="Sony" modelName="ILCE-7SM3"/><Lens modelName="${lens}"/></NonRealTimeMeta>`;
    fs.writeFileSync(CAM_B.replace(/.MP4$/, "M01.XML"), side("70-200mm F2.8 DG DN OS | Sports"));
    fs.writeFileSync(CAM_A.replace(/.MP4$/, "M01.XML"), side("24-70mm F2.8 DG DN | Art 019"));
    const s2 = P.summarize(P.readProject(file));
    assert.equal(s2.wideAngle, 2);
    assert.equal(s2.widePct, 63);
    assert.equal(s2.angles[2].wideBy, "lens");
  } finally { fs.unlinkSync(file); fs.rmSync(DIR, { recursive: true, force: true }); }
});
