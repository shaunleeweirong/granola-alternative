# Installing the .dmg on another Mac

The `.dmg` is a complete, self-contained app. The Mac you install it on needs **no Terminal, no Homebrew, no Node, and no compiler**. Everything is inside the bundle: the app, the system-audio recorder, the speech engine, and the speech model.

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

## What is and is not in the bundle

| Included | Notes |
| --- | --- |
| The app | Electron, the UI, the local database |
| System-audio recorder | The Swift CoreAudio helper |
| Speech engine | whisper.cpp, built on Apple Silicon |
| Speech model | `ggml-base.en.bin`, English, roughly 150 MB |

| Not included | Why |
| --- | --- |
| Note-writing model | A useful one is several gigabytes. Transcription works fully without it; the "Generate notes" button explains what to add. |
| A larger speech model | `base.en` is the fast, small default. Drop a bigger `ggml-*.bin` into `~/Library/Application Support/Meeting Notes/models/` and it takes precedence over the bundled one, with no new build needed. |

## Building a new .dmg

On GitHub: **Actions** → **Build macOS app** → **Run workflow**. Tick *"Also publish a GitHub Release"* if you want a permanent download link rather than a 30-day artifact.

The run takes roughly 15 to 25 minutes. It runs the full test suite first and fails the build rather than shipping something broken, then verifies that the audio helper, speech engine, model and both permission strings are actually present in the finished bundle.

## If the app will not open

| What you see | What it means |
| --- | --- |
| "damaged and can't be opened" | The quarantine flag. Run the `xattr` command in step 3. |
| "could not verify" or "unidentified developer" | Normal for an un-notarised app. Use **Open Anyway** in step 3. |
| Opens, but a banner says no transcription model | The bundle is incomplete. Report which build you downloaded. |
| Opens, records, but the Them channel stays silent | System audio permission was denied, or the call is not playing through this Mac. |
