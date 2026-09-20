# Clean Record

A local-first meeting notes app for macOS. Records both sides of a call, transcribes it on-device, and turns the transcript into structured notes.

No accounts, no sync, no teams, no billing. Nothing leaves the machine.

## Status

Working. The full pipeline has been run against real calls on Apple Silicon: capture, segmentation, transcription, transcript assembly, storage, search, note generation, and export. See [What is and is not verified](#what-is-and-is-not-verified).

```
210 tests passing · typecheck clean · lint clean · both builds green
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

Download the latest `.dmg` from the [Releases page](../../releases/latest), drag it to Applications, and open it. Released builds are signed with a Developer ID certificate and notarised by Apple, so there is no Gatekeeper warning to click past. The installer is about 110 MB; the models are downloaded once on first launch.

To build your own instead: **Actions → Build macOS app → Run workflow**. See [`docs/INSTALL-DMG.md`](docs/INSTALL-DMG.md).

Apple Silicon, macOS 14.2 or later. Everything below is only needed to work on the code.

The window is excluded from screenshots and screen sharing by default, since it
holds transcripts of past meetings and is often open during a call where the
screen is shared. **View → Allow Screen Capture** lifts it for the session and
resets on quit.

## Requirements

- macOS 14.2 or later (CoreAudio process taps)
- Node.js 22+
- Xcode command line tools, for the Swift audio helper (`xcode-select --install`)
- A whisper.cpp `whisper-server` binary and a GGML model, for transcription (default: `ggml-large-v3-turbo-q8_0.bin`, fetched on first launch)
- A llama.cpp `llama-server` binary and a GGUF model, for note generation (default: `Llama-3.2-3B-Instruct-Q4_K_M.gguf`, fetched only when Generate notes is first pressed)
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

**Verified by hand, on Apple Silicon, against real calls:**

- The Swift tap captures real system audio, and the two channels arrive labelled and separate
- Transcription, note generation and export all work end to end on a downloaded model
- The signed and notarised installer opens without a Gatekeeper warning

**Still not verified:**

- Whether Chromium's echo canceller references the correct output device for Bluetooth headsets and multi-output setups. Tested only with the built-in microphone and speakers so far.
- End-to-end accuracy against the PRD's metrics M-1 (local-speaker recall), M-3 (word error rate) and M-4 (echo bleed). The pipeline works; the numbers have not been measured.

**Known limitation.** With laptop speakers and the built-in microphone, the other side of the call is picked up twice: once from the system audio tap, and again bleeding into the microphone. Both copies are transcribed, so some lines appear under both You and Them. This is inherent to the category rather than specific to this app, because the echo canceller has no reference signal for another application's output. Headphones remove it entirely.

## Licence

Clean Record is MIT licensed. See [LICENSE](LICENSE).

**Built with Llama.** Notes are written by Llama 3.2 3B Instruct, running on your own Mac. The model is redistributed unmodified under the Llama 3.2 Community License, Copyright (c) Meta Platforms, Inc. All Rights Reserved. The full agreement and its Acceptable Use Policy are in [`licenses/`](licenses/), and [NOTICE](NOTICE) lists every third-party component and its terms.

Speech recognition uses Whisper large-v3-turbo, published by OpenAI under the MIT License.
