# PodDirector roadmap

## Now (v0.1, Windows)

- Multicam cutting engine with per-speaker and style tuning, a live preview, locks, markers, and a build-on-copy step
- Offline transcription (bundled whisper.cpp) and transcript cleanup suggestions
- Self-contained Windows installer with no admin rights, no internet, and no separately installed AI runtime

## v0.2 (added)

- **Moving cameras:** a camera-motion analyzer (block matching plus a robust global-motion fit, so people moving in frame don't count). Cuts to a dolly or operated camera only once it has settled, waits briefly or goes to the wide during moves, and can keep slow push-ins on air.
- **Follows-speaker cameras:** an operated camera that counts as a close-up of whoever is talking.

## v0.3 (added)

- **Show setups:** built-in setups for 1, 2, 3, and 4+ subjects, plus saved setups matched by track name and applied automatically. VOX-named tracks are preferred as speaker mics.
- Trash icon with confirmation for speakers, cameras, and saved setups.
- **In-panel updater:** checks GitHub releases or a shared update folder, then installs silently.

## v0.3.2 – v0.4 (added)

- Mics that share one multichannel file get one channel per speaker, decided per clip.
- Analyze and cut only between the sequence In/Out marks.
- **Recut** the existing copy in place (keeps nests) and **Undo recut** (last 5 versions).
- Cleanup flags phone and alarm interruptions, including Whisper sound tags.

## v0.5 (added)

- **Who's in the shot** for operated cameras: steady stretches grouped by appearance and named from the audio, editable thumbnails, so the follow cam is used only when it's on the person talking (and can be a reaction shot when it's on a listener).
- Cut away from any camera movement by default (slow moves on air is now opt-in).
- **Max cuts / min** cap (drops the least important cuts first) and a "Shots by reason" breakdown under the preview.
- **Minimum wide**: wide shots run at least 5 s by default.
- Cleanup follows an abandoned tangent from the cut cue to "okay, we're back", and flags pre-show and post-show chatter (v0.5.4).
- The welcome address with the show's name marks the start of the show, with one-click In/Out points (v0.5.5).

## v0.6 (added)

- **Layered cut:** the bottom camera (the wide) stays whole and enabled; only the cameras above it are razored, where they switch. About half the edits with two cameras, and recut cleans up older full cuts.

## v0.7 (added)

- **Simpler cutting style:** the main controls up front (mode, Max cuts / min, Minimum close-up, Minimum wide) and everything else under a collapsible **Advanced** section.
- **Mic confidence:** a collapsible meter per speaker under the preview (level, bleed, borderline and possibly missed speech, weak stretches), with tips.
- **The bottom camera is the wide:** a scan sets it up as the wide, and it's always kept whole. The switch moved to Advanced → Timeline.
- **Content cut warning:** after a scan, flags sections between content cuts in the wide's footage that are shorter than the minimum, under Minimum wide and on the Cleanup tab.
- **Static cameras:** a Static option per camera (works alongside Check for movement).
- **Modes:** new Rapid cutting (once cameras are marked Static, warns if anyone lacks a static close-up) and Interview; presets renamed as modes, each with a description.
- **Close-ups / wide slider:** leans the whole cut toward the speaker close-ups or the static wide (some turns play on the wide).
- **Feature slider per person** (replaces Priority): more screen time for a special guest.

## v0.8 (added)

- **Introduction:** finds the welcome, the host and everyone introduced in the transcript; the cut opens on the host's solo cam, then the wide for the introductions; lower-third name markers with editable name-tag text.
- **Reload instead of restart:** after an update, Reload PodDirector loads the new version in place; Premiere only needs restarting when the manifest changed.

- **Hidden camera tracks (v0.8.1):** Build and Recut turn on track output (the eye) for the camera tracks they cut; the scan notes hidden ones.

- **Multicam by keystrokes, trial (v0.8.2):** reads the Cut to Camera shortcuts from Premiere's .kys file and presses them on a multicam clip (Settings > Multicam by keystrokes), as a first test of cutting real multicam sequences. v0.8.3 finds the shortcuts in a redirected Documents folder, accepts a nest with Multi-Camera enabled, and logs each step.

## Next candidates

- **Jump-cut / silence removal** (AutoPod's "Jump Cut Editor"): ripple-delete silences on every track, using the existing mic analysis
- **Apply accepted cleanup cuts**: optional ripple delete of the accepted transcript ranges on the copy, not only markers
- **Multicam-source output**: switch angles inside a Premiere multicam source sequence instead of enabling tracks
- **Social reframe/export**: vertical and square versions (AutoPod's "Social Media Exporter")
- **Speaker labels in the transcript**: per-mic transcription for exact attribution when bleed is heavy
- **Signed ZXP package**, so `PlayerDebugMode` is not needed
- **UXP migration**: Adobe plans to disable CEP by default in Premiere around Dec 2028
- **Claude / MCP hook**: let Claude call `plan` and `cleanup` directly and push tuned configs into the panel

## Future platforms (logged by request, not started)

- **macOS build**: bundle darwin ffmpeg and whisper.cpp, plus a `.pkg` or shell installer. The engine and panel code are already cross-platform.
- **Linux build** for Premiere-style editors on Linux (the "FilmCraft"/ArtCraft-type clones). This needs a host adapter for that editor's scripting API, or an EDL/FCPXML exporter. The cutting and transcript engines are host-independent pure JavaScript.
