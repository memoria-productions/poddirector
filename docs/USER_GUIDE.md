# PodDirector: User Guide

PodDirector is a Premiere Pro panel that edits multicam podcasts for you. It reads each person's microphone waveform, works out who is talking, and switches camera angles to match. You can tune the cutting style and preview it before anything touches your timeline. A second tool, **Cleanup**, reads a transcript of the show and flags the spots where someone said "cut that", restarted a sentence, or went off the record.

Everything runs on your own computer. There are no accounts, no internet connection, and nothing else to install.

---

## 1. Install (Windows)

1. Close Premiere Pro.
2. Unzip `PodDirector-…-Windows.zip`.
3. Double-click **Install PodDirector.bat**. If Windows SmartScreen warns you, click **More info → Run anyway**.
4. Start Premiere and open **Window → Extensions → PodDirector**.

To remove it, double-click **Uninstall PodDirector.bat**. Your presets and transcripts in `Documents\PodDirector` are kept.

Requirements: Premiere Pro 2022 or newer on 64-bit Windows 10 or 11. The installer only changes your own user account, so it doesn't need admin rights.

---

## 2. Lay out your sequence

| Track | What goes there |
|---|---|
| **V1, V2, V3…** | One camera per track, synced and spanning the whole show. Example: V1 Wide, V2 Host close-up, V3 Guest close-up. |
| **A1, A2…** | One **microphone per person** (lav, dynamic mic, or a recorder channel). |
| Above the cameras | Graphics and lower thirds are fine there. PodDirector only touches the tracks you list as cameras. |

PodDirector cuts by enabling one camera track at a time. Keep the camera tracks stacked with no gaps.

Tips:

- **Sync first.** Use Premiere's *Synchronize* by audio, or a sync plugin, before you run PodDirector.
- **Camera scratch audio is skipped automatically.** Audio that comes from the same files as your camera clips isn't treated as a speaker mic.
- **All the mics in one file?** If a recorder (Zoom, Rodecaster, etc.) put every mic in one multichannel file, add that track once per speaker and set each speaker's **channel** (Ch 1, Ch 2…).

---

## 3. Multicam workflow

1. **Scan sequence** reads the active sequence and makes a first guess at who's who.
2. **Speakers:** name each mic and check its track and channel.
3. **Cameras:** for each camera, tick the people it shows.
   - One person ticked = that person's **close-up**.
   - Everyone ticked = the **wide** shot.
   - Two people ticked = a **two-shot**, used when exactly those two talk over each other.
   - A person with two close-up cameras gets **angle rotation** between them.
4. **Analyze waveforms** reads the mic audio. The first run takes a little while. After that the results are cached, so changing settings is instant.
5. **Tune the style** (section 4). The preview strip updates live.
   - **Click** the preview to move Premiere's playhead to that moment.
   - **Drag** across a range, then pick a camera to **lock** it there. "Auto" unlocks it.
6. **Preview as markers** drops a colored marker at every cut, so you can scrub through in Premiere before committing.
7. **Build cut on a copy** duplicates your sequence as "… - PodDirector", razors the camera tracks at every cut, and enables the right camera for each shot. **Your original sequence is never changed.** To try a different style, build again.

---

## 4. Tuning the style

Start with a preset, then adjust from there. Controls you've changed from the preset turn blue. Click **Save** to store your own preset.

| Preset | Good for |
|---|---|
| **Calm** | Interviews and long-form talks. Few cuts, long shots, ignores small reactions. |
| **Balanced** | Most conversational podcasts. |
| **Lively** | Banter, comedy, and three or more people. Quick switching and lots of reaction shots. |
| **Social clips** | Fast-paced shorts. |
| **Host focus** | Stays on whoever is talking: no wides on pauses, no cutaways. |

### Switching

- **Reaction delay:** how long a new voice has to keep talking before the camera follows. Raise it if the edit feels jumpy. Lower it if the camera is late to the new speaker.
- **Cut timing:** where the cut lands relative to the first word. Slightly negative (−0.1 s) cuts just before they speak, which feels natural. Positive values cut a beat after, like a live switcher reacting.
- **Minimum shot:** shots shorter than this get absorbed into a neighbor.

### Wide and group shots

- **Talking over:** what to show when two or more people talk at once. Go wide, stay on the loudest person, or hold the current shot.
- **Overlap time:** how long the overlap has to last before it counts as crosstalk.
- **Wide on pauses:** cut to the wide after this much silence.
- **Open on wide:** start the show on the wide shot.

### Reactions and interjections

These are listener reactions like "Yeah", laughs, and quick remarks.

- **Interjections:** cut to the person reacting, cut to the wide, or ignore them.
- **Reaction frequency:** the share of interjections that get a shot. This keeps the edit from cutting away constantly.
- **Interjection length:** speech shorter than this, over someone else, counts as an interjection rather than a new turn.

### Long monologues

- **Break shots over:** insert a cutaway once a single shot runs longer than this. Cutaways are placed at the quietest breath nearby.
- **Cutaway to:** the wide, a listener, the speaker's other angle, or a mix of all three.

### Voice detection

You rarely need these.

- **Sensitivity:** for speakers on Auto threshold. Raise it if a soft-spoken guest gets missed.
- **Bleed rejection:** a mic this many dB below the loudest is treated as picking up the other person's voice. Lower it if a loud host's voice on the guest's mic causes wrong cuts.
- **Ignore blips under / Bridge gaps under:** ignore coughs and bumps, and keep a turn alive through short pauses between words.
- **Variation seed:** reshuffles the random choices (which reactions get shown, which angles) without changing the style.

### Per-speaker settings (⚙ on each speaker)

- **Threshold:** Auto, or set it by hand. The bar under the speaker shows their noise floor and speech level, and the white line is the threshold.
- **Priority:** wins close calls. For example, give the host +3 dB so the camera favors them in overlaps.
- **Min shot:** a minimum shot length just for this speaker.
- **Reacts on screen:** turn off if this person's "mm-hmm"s shouldn't trigger reaction shots.
- **Use as listener:** turn off if this person shouldn't be shown listening during cutaways.

### Reading the stats

Under the preview you'll see the number of cuts, cuts per minute, average and longest shot, **screen time per camera**, and **talk time per speaker**. If a speaker talks 40% of the time but only gets 15% screen time, raise their priority or lower the reaction frequency.

---

## 5. Cleanup (transcript)

1. Click **Transcribe timeline**. PodDirector mixes the speaker mics and transcribes them offline with the bundled Whisper model. On a typical laptop that takes a few minutes per hour of audio. You can also **load** a transcript exported from Premiere's Text panel (SRT, VTT, or TXT).
2. PodDirector flags:
   - **Asked to cut:** "cut that", "edit that out", "scratch that", "don't use that", "we'll fix it in post", and similar phrases.
   - **Restart / retake:** "let me start over", "take two", "from the top", "let me rephrase".
   - **False starts:** a sentence that's begun, abandoned, and restarted with the same words. No spoken cue is needed for these.
   - **Off the record:** from "off the record" until "we're back" or the next long pause.
   - **Interruptions / technical chatter:** "hold on", "is the camera still recording?" These are flagged with lower confidence.
3. Each suggestion shows its time range, confidence, and transcript text. **Click** a suggestion to jump Premiere's playhead there. Use the arrow buttons to nudge the start or end by 0.5 s, and untick any you want to keep.
4. **Mark selected on timeline** adds red range markers. Review them in context, then lift or ripple-delete the ones you agree with. PodDirector never deletes anything for you.
5. **Copy for Claude review** copies the flagged list plus the full transcript, ready to paste into Claude for a second opinion.

Add names and jargon under Settings → *Vocabulary hint* to improve transcription accuracy.

---

## 6. Troubleshooting

| Problem | Fix |
|---|---|
| The panel isn't under Window → Extensions | Run the installer again with Premiere closed. |
| "ffmpeg was not found" | Check Settings. The bundled copy should appear there. If antivirus quarantined it, restore it or set a custom path. |
| The camera follows the wrong person | Open ⚙ on that speaker and look at the level bar. If the white threshold line sits inside the bleed, set the threshold manually above it, or lower **Bleed rejection**. |
| Too many quick cuts | Raise **Reaction delay** and **Minimum shot**, or switch to **Calm**. |
| Reactions feel random | Lower **Reaction frequency**, or turn off **Reacts on screen** for the chatty listener. |
| Build is slow on a long show | Razoring runs about 20–50 ms per cut per camera track. A 1-hour show with 600 cuts on 3 cameras takes about a minute. |

Files (presets, transcripts, exports, cut lists) are saved in **Documents\PodDirector**.
