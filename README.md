# granola-alternative

A local-first meeting notes app for macOS. Records both sides of a call, transcribes it on-device, and turns the transcript into structured notes.

No accounts, no sync, no teams, no billing. Nothing leaves the machine.

## Status

Early. The full pipeline is implemented and tested — capture, segmentation, transcription, transcript assembly, storage, search, note generation, export — but it has **not yet been run against a real call**, because the CoreAudio tap needs macOS 14.2+ hardware. See [What is and is not verified](#what-is-and-is-not-verified).

```
130 tests passing · typecheck clean · lint clean · both builds green
```

## How it works

Two independent 16 kHz mono channels, never mixed:

| Channel | Source | Label |
| --- | --- | --- |
| Microphone | `getUserMedia` with the platform echo canceller **on** | You |
| System audio | CoreAudio process tap (macOS 14.2+) | Them |

Each channel is segmented by a VAD into 15–30 second windows cut at silence, with ~1 s of overlap so a boundary can never sever a word. Windows from both channels feed one serial worker so local ASR is never oversubscribed. Each window is transcribed with the previous window's tail plus your dictionary as context, deduplicated against its own overlap, and committed with a timestamp derived from the audio sample cursor. The transcript is then just a sort.

### The design decision everything rests on

The microphone is opened **with** echo cancellation, noise suppression and automatic gain control enabled (`src/renderer/audio/micConstraints.ts`).

This is only possible because v1 labels speakers by channel rather than by diarization, so nothing downstream needs unprocessed audio. A prior teardown of OpenWhispr found that capturing the mic raw — which its diarizer required — forced it to rebuild an echo canceller in JavaScript, and that reconstruction is what deleted the local speaker's words from the transcript. Six of seven findings descended from that one flag.

As a result this codebase contains **no** echo detector, energy gate, mic hold-back queue, cross-channel duplicate check, segment retraction, or stream alignment offset. See `tasks/prd-meeting-notes.md` Appendix A for the full mapping of findings to requirements.

## Install without building

For a second Mac, or anyone who should not have to touch a Terminal, build a `.dmg` on GitHub's Mac runners: **Actions → Build macOS app → Run workflow**. It bundles the app, the audio helper, the speech engine and a speech model into one installer.

See [`docs/INSTALL-DMG.md`](docs/INSTALL-DMG.md), which also covers the Gatekeeper warning you will get, since the build is ad-hoc signed rather than notarised.

Apple Silicon, macOS 14.2 or later. Everything below is only needed to work on the code.

## Requirements

- macOS 14.2 or later (CoreAudio process taps)
- Node.js 22+
- Xcode command line tools, for the Swift audio helper (`xcode-select --install`)
- A whisper.cpp `whisper-server` binary and a GGML model, for transcription (default: `ggml-large-v3-turbo-q8_0.bin`, fetched on first launch)
- Optionally a llama.cpp `llama-server` binary and a GGUF model, for note generation

The app launches and records without the two servers; it reports what is missing rather than failing to start.

## Getting started

```bash
npm install          # also builds the Swift audio tap on macOS
npm run verify       # typecheck, lint, 130 tests, both builds
npm run dev          # renderer dev server
npm start            # build main and launch Electron
```

Place local inference binaries in `resources/bin/` (`whisper-server`, `llama-server`). Models go in the app's `userData/models` directory, which is also where the app downloads the speech model on first launch. Packaged builds deliberately ship no model: it is fetched once and kept, so an app update does not download it again. A model in `resources/models/` is still honoured for development builds, and a user-installed model always wins.

`npm run package:mac` builds an installable `.dmg` locally, if you are on a Mac.

## Layout

| Path | What lives there |
| --- | --- |
| `src/core/audio/` | Format constants, energy VAD, the window segmenter |
| `src/core/transcript/` | Overlap dedup, carried prompts, audio-ordered merge |
| `src/core/queue/` | Single-worker, oldest-audio-first transcription queue |
| `src/core/db/` | SQLite schema and the notes repository with FTS5 search |
| `src/core/recordingSession.ts` | Orchestrates two channels into one transcript |
| `src/main/` | Electron main, tap supervision, whisper and llama clients |
| `src/renderer/` | Capture worklet, mic constraints, React UI |
| `native/macos-audio-tap/` | Swift system-audio helper |
| `tasks/prd-meeting-notes.md` | Requirements, architecture, and the teardown findings |

## What is and is not verified

**Verified by the test suite** (`npm test`, runs on any platform):

- Segmentation: window sizing, silence-boundary cuts, overlap, idle flush, buffer bounds, and that a quiet talker is segmented identically to a loud one
- That emitted audio is a verbatim slice of the input — nothing is ever gated or zeroed
- Transcript ordering, overlap dedup, carried prompts, language pinning
- The queue: serial execution, oldest-first drain, failure isolation
- Storage: persistence, FTS search correctness and latency, injection-safe queries
- The tap supervisor, driven by a fake helper that splits JSON events and PCM samples across read boundaries
- Whisper and llama clients against stub HTTP servers, including timeouts, error shapes and SSE edge cases
- The capture worklet, evaluated against a stand-in AudioWorkletGlobalScope

**Not yet verified** — needs macOS hardware and a real call:

- The Swift tap captures real audio. CI now compiles it on a macOS runner and fails the build if it does not, so a green run proves it builds; nothing yet proves it records.
- Whether Chromium's echo canceller references the correct output device for Bluetooth headsets and multi-output setups. This is the riskiest assumption in the design; prototype it before building further. If it does not hold, the fallback is an explicit WebRTC AEC3 helper fed the tap output as a reference.
- End-to-end accuracy against the PRD's metrics M-1 (local-speaker recall), M-3 (word error rate) and M-4 (echo bleed)
- Note quality from a local model, which is what makes this a Granola alternative rather than a transcript viewer

## License

MIT
