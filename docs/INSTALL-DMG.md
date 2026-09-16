# Installing the .dmg on another Mac

The `.dmg` is a complete, self-contained app. It is large, roughly 1.8 GB, because the speech model travels inside it. The Mac you install it on needs **no Terminal, no Homebrew, no Node, and no compiler**. Everything is inside the bundle: the app, the system-audio recorder, the speech engine, and the speech model.

**Requirements:** Apple Silicon Mac (M1 or later), macOS 14.2 or later.

> An Intel Mac needs a separate build. The workflow currently produces `arm64` only.

---

## 1. Get the file

**From a Release:** open the repository's Releases page and download `MeetingNotes-arm64-<commit>.dmg`.

**From a build run:** open the **Actions** tab → **Build macOS app** → the most recent green run → **Artifacts** → `MeetingNotes-macOS-arm64`. It downloads as a `.zip`; unzip it to get the `.dmg`.

## 2. Install

1. Double-click the `.dmg`.
2. Drag **Meeting Notes** onto the **Applications** shortcut.
3. Eject the disk image.

## 3. Get past the security warning

**This will happen, and it is expected.** The app is signed only with a free ad-hoc signature, not notarised by Apple, because notarisation needs a paid Apple Developer account. macOS treats anything downloaded and un-notarised as untrusted.

The first time you open it you will see something like *"Apple could not verify Meeting Notes is free of malware."*

**The fix, in the interface:**

1. Click **Done** on the warning.
2. Open **System Settings** → **Privacy & Security**.
3. Scroll down to the Security section. There is a line naming Meeting Notes.
4. Click **Open Anyway**, then confirm.

**Or, the one-line version.** Open Terminal and paste this, which strips the "downloaded from the internet" flag:

```bash
xattr -dr com.apple.quarantine "/Applications/Meeting Notes.app"
```

After either route, the app opens normally from then on.

## 4. Allow the two recordings

On first use of the Record button, macOS asks twice. Click **Allow** on both:

- **Microphone** so it can hear you.
- **System audio recording** so it can hear everyone else on the call.

If you miss a prompt, turn them on under **System Settings → Privacy & Security**, in **Microphone** and in **Screen & System Audio Recording**. Quit and reopen the app afterwards.

> Permissions are tied to the app's signature. Because each build gets a fresh ad-hoc signature, **installing a newer .dmg may ask for permission again.** That is normal.

## 5. Check it works

Run the echo test from the setup guide: play a video of someone talking, stay silent for 30 seconds, then speak three sentences over it. Your words should appear as **You**, the video's as **Them**, and the silent stretch should produce no **You** lines.

---

## The first-launch download

The installer is about 110 MB. The speech model is not inside it.

The first time you open the app it asks to download the model, roughly 834 MB, and shows a progress bar. That happens once per Mac. The model is kept in your user folder rather than inside the app, so installing a later version of the app does not download it again.

If the download is interrupted, reopening the app picks up from where it stopped rather than starting over.

You can press **Not now** and use the app without it. Meetings will still record and save; they just will not be transcribed until the model is there, and the banner at the top offers the download again.

## Choosing what the notes look like

Next to **Generate notes** is a button showing the current style. Click it to pick one:

| Style | Produces |
| --- | --- |
| Detailed notes | Summary, discussion by topic, decisions, action items, open questions. The default. |
| Brief summary | A short summary and the action items. Nothing else. |
| Action items only | Just the checklist of what people committed to. |
| Executive summary | Three or four paragraphs of prose for someone who was not there. |
| Full minutes | Chronological record, in the order the meeting happened. |
| Custom | Describe what you want in your own words. |

There is also an **Extra instructions** box, added on top of whichever style you pick. Things like "always list budget figures" or "write in British English".

The accuracy rules are deliberately not adjustable. Nothing is invented, names are kept exactly as spoken, and what was discussed stays separate from what was decided. A style changes the shape of the output and nothing else.

## What is and is not in the bundle

| Included | Notes |
| --- | --- |
| The app | Electron, the UI, the local database |
| System-audio recorder | The Swift CoreAudio helper |
| Speech engine | whisper.cpp, built on Apple Silicon |

| Not included | Why |
| --- | --- |
| Speech model | `ggml-large-v3-turbo-q8_0.bin`, about 834 MB, downloaded on first launch. 8-bit quantisation of the same model Whisper calls large-v3-turbo: near the accuracy of Whisper's largest model, comfortably faster than real time on Apple Silicon. |
| Note-writing model | `Llama-3.2-3B-Instruct-Q4_K_M.gguf`, about 1.9 GB, downloaded only if you press **Generate notes**. Transcription is the product and works fully without it, so it is never fetched unless you ask for a summary. |
| A different speech model | Drop any `ggml-*.bin` into `~/Library/Application Support/Meeting Notes/models/` and it takes precedence, with no new build needed. Use this to trade accuracy for speed or download size. |

## Building a new .dmg

On GitHub: **Actions** → **Build macOS app** → **Run workflow**. Tick *"Also publish a GitHub Release"* if you want a permanent download link rather than a 30-day artifact.

The run takes roughly 15 to 25 minutes. It runs the full test suite first and fails the build rather than shipping something broken, then verifies that the audio helper, speech engine and both permission strings are actually present in the finished bundle, that the speech engine actually launches from inside the signed app, and that no model has crept back into it.

## If the app will not open

| What you see | What it means |
| --- | --- |
| "damaged and can't be opened" | The quarantine flag. Run the `xattr` command in step 3. |
| "could not verify" or "unidentified developer" | Normal for an un-notarised app. Use **Open Anyway** in step 3. |
| Opens, but a banner says no transcription model | The bundle is incomplete. Report which build you downloaded. |
| Opens, records, but the Them channel stays silent | System audio permission was denied, or the call is not playing through this Mac. |
