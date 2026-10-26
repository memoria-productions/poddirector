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

## Next candidates

- **Jump-cut / silence removal** (AutoPod's "Jump Cut Editor"): ripple-delete silences on every track, using the existing mic analysis
- **Apply accepted cleanup cuts**: optional ripple delete of the accepted transcript ranges on the copy, not only markers
- **Multicam-source output**: switch angles inside a Premiere multicam source sequence instead of enabling tracks
- **Social reframe/export**: vertical and square versions (AutoPod's "Social Media Exporter")
- **Face check for follow cams:** confirm the operator has actually landed on the person talking before cutting in
- **Speaker labels in the transcript**: per-mic transcription for exact attribution when bleed is heavy
- **Signed ZXP package**, so `PlayerDebugMode` is not needed
- **UXP migration**: Adobe plans to disable CEP by default in Premiere around Dec 2028
- **Claude / MCP hook**: let Claude call `plan` and `cleanup` directly and push tuned configs into the panel

## Future platforms (logged by request, not started)

- **macOS build**: bundle darwin ffmpeg and whisper.cpp, plus a `.pkg` or shell installer. The engine and panel code are already cross-platform.
- **Linux build** for Premiere-style editors on Linux (the "FilmCraft"/ArtCraft-type clones). This needs a host adapter for that editor's scripting API, or an EDL/FCPXML exporter. The cutting and transcript engines are host-independent pure JavaScript.
