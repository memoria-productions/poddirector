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
- **All the mics in one file?** A recorder (Zoom, Rodecaster) or a camera with an XLR adapter often puts every mic in one multichannel file, which Premiere spreads across tracks (A1 = Ch 1, A2 = Ch 2…). PodDirector detects this and gives each speaker its own channel; you can check it in the channel menu next to each speaker. If it ever reads **All ch** for such a file, every speaker hears the same mix and the cut barely changes. PodDirector now warns about that after analysis.

---

## 3. Multicam workflow

1. **Scan sequence** reads the active sequence and makes a first guess at who's who. Audio tracks with **VOX** in their name (VOX1, VOX2…) are taken as the speaker mics first. Tracks named like SFX, music, mix, or room are skipped.
2. **Show setup** (top card) chooses how the speakers and cameras are set up:
   - **Auto-detect** uses every voice track it finds.
   - **1 / 2 / 3 / 4+ subjects** takes that many VOX tracks and switches the cutting style to one tuned for that many people.
   - **Save as…** stores the current speakers (names, tracks, per-speaker settings), cameras, and style as a named setup, such as "Classical et cetera". Pick it from the list on any episode. Tracks are matched by name, so VOX1 is always Martin. Once saved, a setup is **applied automatically** to new sequences whose track names match. The trash icon next to a saved setup deletes it.
3. **Speakers:** name each mic and check its track and channel. **+ Speaker** adds one, the trash icon next to ⚙ removes one (after you confirm), and ⚙ opens that speaker's settings.
4. **Cameras:** for each camera, tick the people it shows. The trash icon removes a camera.
   - One person ticked = that person's **close-up**.
   - Everyone ticked = the **wide** shot.
   - Two people ticked = a **two-shot**, used when exactly those two talk over each other.
   - A person with two close-up cameras gets **angle rotation** between them.
   - **Follows speaker:** for a camera whose operator re-frames on whoever is talking. It counts as a close-up of every speaker, but never as a group shot or a listener reaction.
   - **Check for movement:** turn this on for a dolly, slider, gimbal, or handheld camera. PodDirector reads its picture and only cuts to it when it's steady (section 4, *Moving cameras*). Leave it off for locked-off cameras like a static wide: that skips the video analysis for them, and they're never held back.
5. **Analyze** range: set **In and Out marks** on the sequence around the episode itself, and PodDirector analyzes and cuts only between them. The intro, outro and anything else outside the marks are left exactly as they are (the preview greys them out). Choose **Whole sequence** in the menu above the Analyze button to ignore the marks.
6. **Analyze waveforms** reads the mic audio. It also checks any moving cameras for movement, which decodes their video at low resolution: allow a few minutes per hour of footage the first time. The first run takes a little while. After that the results are cached, so changing settings is instant.
7. **Tune the style** (section 4). The preview strip updates live.
   - **Click** the preview to move Premiere's playhead to that moment.
   - **Drag** across a range, then pick a camera to **lock** it there. "Auto" unlocks it.
8. **Preview as markers** drops a colored marker at every cut, so you can scrub through in Premiere before committing.
9. **Build cut on a copy** duplicates your sequence as "… - PodDirector", razors the camera tracks at every cut, and enables the right camera for each shot. **Your original sequence is never changed.**
10. **Recut** to try a different style or fix a few shots. Adjust the preview, then click **Recut "… - PodDirector"**. This changes the same copy in place instead of making a new one, so if you've already nested that copy into your master timeline, the nest picks up the new cut automatically. Old edit points stay behind as invisible through-edits. **Undo recut** puts the previous version back (the last 5 are kept). Recut overwrites any cameras you switched by hand in that copy, so lock those shots in the preview first (drag across them and pick a camera).

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
- **Minimum shot:** shots shorter than this get absorbed into a neighbor. Reaction shots use their own length, and cuts forced by a moving camera (a dolly reframe) ignore it.
- **Max cuts / min:** a hard limit on how many cuts can happen in any minute. When a stretch is busier than that, PodDirector drops the least important cuts first: reactions, then pause wides, cutaways, overlaps, then the shortest speaker shots. Cuts forced by camera movement stay. **This is the setting to use when the edit feels too busy.**
- **Minimum wide** (Wide & group shots): every wide shot stays up at least this long (default 5 s), running on into the next shot when needed. Wides forced by a moving dolly, short overlaps and pauses no longer flash by; it never runs over a locked shot or a reaction shot. Set it to 0 to use the normal minimum shot.

  Under the preview, **Shots by reason** shows what's causing the cuts. Lots of "reactions" means lower **Reaction frequency**, set **Interjections** to *Ignore*, or *lower* **Interjection length** (a longer setting turns more remarks into reaction shots). Lots of "dolly moving" means the operator reframes often; that's not a setting problem.

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

### Moving cameras

This group appears once **Check for movement** is on for a camera. PodDirector measures how much the *camera* moves (pan, tilt, dolly, push-in, shake) separately from how much the *people* move. Someone gesturing or leaning in front of a steady camera doesn't count as camera movement. The preview shows a movement lane for each moving camera: **green** = steady, **amber** = slow move, **red** = big move.

- **Steady below / Big move above:** the two thresholds, in percent of frame width per second. Between them is a *slow move*, such as a gentle push-in or a drift.
- **Settle time:** how long the camera must be steady before PodDirector cuts to it, so you never land on the tail end of a move.
- **Wait to settle:** if a cut would land mid-move, PodDirector holds the previous shot up to this long. Longer moves go to the wide until the camera settles.
- **Slow moves on air:** keep gentle push-ins on screen once you're on that camera, or cut away from any movement. It's off by default, so any visible reframing or drift cuts to the wide.
- **Leave move early by:** how early to cut away before a big move starts.

Typical setup, one static wide plus one operated dolly camera: turn on **Check for movement** and **Follows speaker** for the dolly, and leave both off for the wide. The edit then reads: dolly on whoever is talking when it's steady, the wide while the operator re-frames, back to the dolly once it settles.

**Who's in the shot (operated cameras).** An operator doesn't always stay on whoever is talking: they may hold on a listener, or be late moving to the next person. For a camera with **Follows speaker** and **Check for movement** both on, PodDirector also works out who it's pointed at:

- It splits the camera's footage into steady stretches, between moves.
- It groups stretches that look alike, using the colours in the middle of the frame (clothes, skin, hair), so each group is one person.
- It names each group after whoever was usually talking while the camera sat on it.

The camera row then shows a thumbnail per group with that guess. Fix any that are wrong, or choose *Nobody / don't use*. The dolly is then only used while it's on the person talking, so it never shows Jess while Paul is talking. If it happens to be on a listener when they laugh or say "yeah", it can serve as their reaction shot. In the preview, a thin coloured line under the movement lane shows who it was on.

If two people dress alike they may land in the same group; set that group to *Nobody* and PodDirector uses the wide there instead.

If the camera row says *plain background, treated as steady*, the shot doesn't have enough detail behind the subject (a bare wall, a seamless backdrop) to measure camera movement. Watch the result there, and lock any bad moments by dragging on the preview.

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
   - **Asked to cut:** "cut that", "edit that out", "scratch that", "don't use that", "we'll fix it in post", a bare "David, cut.", and similar phrases.
   - **Abandoned tangents:** when the cue calls out a whole stretch ("maybe we'll cut this part, it's going everywhere"), the cut reaches back up to *Look back up to* (40 s by default), and runs forward to where they say they're back: "bring it back", "let's get back on track", "okay, we're back". Each of those phrases must come within 45 s of the last one. Check the start point: where a tangent began is a judgment call.
   - **Pre-show and post-show chatter:** everything before "Hello and welcome to…", and short talk after the sign-off ("thanks for joining us… we'll see you next time").
   - **Restart / retake:** "let me start over", "take two", "from the top", "let me rephrase".
   - **False starts:** a sentence that's begun, abandoned, and restarted with the same words. No spoken cue is needed for these.
   - **Off the record:** from "off the record" until "we're back" or the next long pause.
   - **Interruptions:** phones and alarms ("let me silence my phone", "sorry, that's my alarm", Whisper's own *[phone ringing]* tags), someone at the door, "I have to take this". The suggestion runs from the ring through the "okay, sorry about that", and stops where the conversation picks back up.
   - **Technical chatter:** "hold on", "is the camera still recording?" These are flagged with lower confidence.
3. Each suggestion shows its time range, confidence, and transcript text. **Click** a suggestion to jump Premiere's playhead there. Use the arrow buttons to nudge the start or end by 0.5 s, and untick any you want to keep.
4. Ticked suggestions also feed the multicam cut. Removing a section joins the shot before it to the shot after it, so PodDirector makes sure those two are **different cameras**. Typically it goes to the wide for a few seconds, then back, which hides the jump. You'll see a "cut cover" shot in the preview. The **Cleanup cuts** group in the cutting style turns this on or off and sets how long the cover shot lasts. If you've already built the copy, click **Recut** afterwards so it picks this up.
5. **Mark selected on timeline** adds red range markers. Review them in context, then lift or ripple-delete the ones you agree with. PodDirector never deletes anything for you.
6. **Copy for Claude review** copies the flagged list plus the full transcript, ready to paste into Claude for a second opinion.

Add names and jargon under Settings → *Vocabulary hint* to improve transcription accuracy.

---

## 6. Updating

PodDirector checks for a newer version when the panel opens (at most twice a day). When one is available, a blue bar at the top offers **Update now**. That downloads and installs it, and then you restart Premiere Pro. You can also check by hand under **Settings → Updates**.

Updates can come from two places:

- **GitHub releases.** This only works if the GitHub repository is public.
- **An update folder,** such as a shared drive. Put `PodDirector-x.y.z-Windows.zip` files there, and every machine pointed at that folder picks up the newest one. Use this if the repository is private.

---

## 7. Troubleshooting

| Problem | Fix |
|---|---|
| The panel isn't under Window → Extensions | Run the installer again with Premiere closed. |
| "ffmpeg was not found" | Check Settings. The bundled copy should appear there. If antivirus quarantined it, restore it or set a custom path. |
| Very few cuts; the camera barely switches | Check each speaker's channel menu: speakers sharing one multichannel file must each use their own channel, not **All ch**. |
| The camera follows the wrong person | Open ⚙ on that speaker and look at the level bar. If the white threshold line sits inside the bleed, set the threshold manually above it, or lower **Bleed rejection**. |
| Too many quick cuts | Raise **Reaction delay** and **Minimum shot**, or switch to **Calm**. |
| Reactions feel random | Lower **Reaction frequency**, or turn off **Reacts on screen** for the chatty listener. |
| PodDirector cuts to the dolly while it's still moving | Raise **Settle time**, or lower **Steady below**. |
| The dolly is hardly used | Check its movement lane. If it's mostly amber, raise **Steady below** a little or turn on **Slow moves on air**. |
| Build is slow on a long show | Razoring runs about 20–50 ms per cut per camera track. A 1-hour show with 600 cuts on 3 cameras takes about a minute. |

Files (presets, transcripts, exports, cut lists) are saved in **Documents\PodDirector**.
