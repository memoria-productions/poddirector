# PodDirector roadmap

## Now (v0.1, Windows)

- Multicam cutting engine with per-speaker and style tuning, a live preview, locks, markers, and a build-on-copy step
- Offline transcription (bundled whisper.cpp) and transcript cleanup suggestions
- Self-contained Windows installer with no admin rights, no internet, and no separately installed AI runtime

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
