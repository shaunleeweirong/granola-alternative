# PRD: Offline Meeting Notes (Granola-equivalent)

**Status:** Draft for review
**Scope:** v1
**Platform:** macOS 14.2+ (Apple Silicon and Intel)
**Last updated:** 2026-09-14

---

## 1. Introduction / Overview

A desktop app that sits quietly beside a video call, records both sides of the conversation, transcribes it on-device, and turns the transcript into structured meeting notes — decisions, action items, open questions.

The reference products are Granola (notes) and OpenWhispr (open-source transcription). This PRD deliberately takes a narrower shape than either:

- **No accounts, no sync, no teams, no billing, no hosted service.** Everything lives in a local SQLite database on the user's machine.
- **Nothing leaves the machine.** Transcription runs on whisper.cpp or Parakeet locally; note generation runs on a local LLM via llama.cpp.
- **Two speakers, not many.** The microphone channel is "You"; the system-audio channel is "Them". No speaker diarization in v1.

That third constraint is the load-bearing one. A prior teardown of the OpenWhispr codebase (see Appendix A) found that its meeting transcription loses words in live Teams calls, and that nearly every cause traces back to one decision: it captures the microphone **raw**, with echo cancellation, noise suppression and automatic gain control all disabled, because its diarizer needs unprocessed audio. Having disabled the operating system's echo canceller, it then has to rebuild one in JavaScript — roughly 1,500 lines of correlation heuristics, RMS gates, holdback timers and retraction logic — and that reconstruction is what deletes the user's own speech from the transcript.

By dropping per-speaker diarization from v1, we can leave the platform echo canceller **on**. That single choice removes the entire class of bug.

---

## 2. Goals

1. Capture both sides of a Zoom, Teams, Meet or FaceTime call on macOS without a bot joining the meeting.
2. Produce a transcript in which the local speaker's own words are present and intact, including when they talk over the remote party.
3. Transcribe fully offline, with no API key and no network required.
4. Turn a finished transcript into structured markdown notes (summary, discussion, decisions, action items, open questions).
5. Keep every byte on the user's machine.
6. Reach a working end-to-end recording within one week of focused work, and a shippable v1 within roughly six weeks.

---

## 3. User Stories

### US-001: Grant system audio permission
**Description:** As a user, I want to grant system-audio access once during onboarding so that recordings capture the other participants.

**Acceptance Criteria:**
- [ ] On first launch, onboarding explains why system audio is needed and shows a "Grant access" button
- [ ] Clicking it triggers the macOS audio-capture permission prompt
- [ ] Granted / denied state is persisted and shown in Settings
- [ ] If denied, the app still records microphone only and displays a persistent banner explaining what is missing
- [ ] On macOS below 14.2, onboarding states that system audio is unavailable and offers microphone-only recording

### US-002: Start a recording manually
**Description:** As a user, I want to press one button to start recording so I do not have to configure anything mid-call.

**Acceptance Criteria:**
- [ ] A "Record" button in the main window and a menu-bar item both start a recording
- [ ] Recording starts within 1 second of the click
- [ ] A recording indicator shows elapsed time and a live level meter for each channel
- [ ] Pressing stop ends the recording and creates a note

### US-003: Be prompted when a call starts
**Description:** As a user, I want the app to notice a call has started so I do not forget to record.

**Acceptance Criteria:**
- [ ] When a known meeting app (Zoom, Teams, Webex, FaceTime) begins using the microphone, an in-app overlay appears offering "Start recording" and "Not now"
- [ ] The overlay is content-protected and does not appear in screen shares
- [ ] "Not now" suppresses further prompts for that process until it exits
- [ ] No prompt appears while a recording is already in progress
- [ ] Detection can be turned off entirely in Settings

### US-004: See live transcript during the call
**Description:** As a user, I want to see text appear as the meeting progresses so I know it is working.

**Acceptance Criteria:**
- [ ] Transcript segments appear labelled "You" or "Them"
- [ ] Segments are ordered by when the audio occurred, not by when transcription finished
- [ ] A segment appears no later than 20 seconds after the speech ended
- [ ] The panel auto-scrolls unless the user has scrolled up

### US-005: Take manual notes while recording
**Description:** As a user, I want to type my own notes during the call so my priorities are captured alongside the transcript.

**Acceptance Criteria:**
- [ ] A markdown editor is available beside the live transcript during recording
- [ ] Typing never interrupts or degrades recording
- [ ] Manual notes are saved continuously and survive an app crash

### US-006: Generate structured notes from the transcript
**Description:** As a user, I want one click to turn the raw transcript into readable meeting notes.

**Acceptance Criteria:**
- [ ] A "Generate notes" button appears when a recording stops
- [ ] Generated output contains Summary, Discussion, Decisions, Action Items and Open Questions sections, omitting any section with no content
- [ ] The user's manual notes are passed to the model alongside the transcript
- [ ] Generation streams into the editor so progress is visible
- [ ] The raw transcript is preserved and viewable after generation
- [ ] If no local LLM model is installed, the button explains what to download instead of failing silently

### US-007: Correct names with a personal dictionary
**Description:** As a user, I want to teach the app the names and jargon it keeps misspelling.

**Acceptance Criteria:**
- [ ] Settings contains an editable list of terms
- [ ] Terms are passed to whisper.cpp as an initial prompt on every transcription window
- [ ] Terms are included in the note-generation prompt as a spelling reference
- [ ] Adding a term takes effect on the next recording without a restart

### US-008: Browse and search past meetings
**Description:** As a user, I want to find a meeting I recorded last month.

**Acceptance Criteria:**
- [ ] Notes are listed newest first with title, date and duration
- [ ] Full-text search covers note titles, generated notes, manual notes and transcripts
- [ ] Search returns results in under 300 ms for a library of 500 meetings
- [ ] A note can be renamed and deleted, with delete asking for confirmation

### US-009: Export a meeting
**Description:** As a user, I want to get my notes out of the app.

**Acceptance Criteria:**
- [ ] A note can be exported as markdown to a chosen location
- [ ] Export includes generated notes, manual notes and the full transcript
- [ ] The exported transcript carries timestamps and You/Them labels

### US-010: Download a transcription model
**Description:** As a new user, I want the app to fetch what it needs to work.

**Acceptance Criteria:**
- [ ] Onboarding offers a default model with size and estimated accuracy shown
- [ ] Download shows progress and can be cancelled and resumed
- [ ] Checksum is verified before the model is marked usable
- [ ] Additional models can be downloaded or removed from Settings

---

## 4. Functional Requirements

### Audio capture

- **FR-1:** The system must capture microphone audio through `getUserMedia` with `echoCancellation: true`, `noiseSuppression: true` and `autoGainControl: true`. These must not be disabled. *(Fixes teardown findings 1, 2 and 3 at the source.)*
- **FR-2:** The system must capture system audio using a CoreAudio process tap (`CATapDescription`) configured with `isMono = true`, `isMixdown = true`, `muteBehavior = .unmuted` and an empty exclusion list, hosted in a Swift child process.
- **FR-3:** Both channels must be captured at **16 kHz mono, 16-bit PCM, end to end**. The Swift helper must resample with `AVAudioConverter`; the renderer must open its `AudioContext` at 16000 Hz. No application-level resampling step may exist. *(Fixes finding 7a — the unfiltered 24k→16k linear resampler.)*
- **FR-4:** The capture worklet must average all present input channels rather than reading channel 0 only. *(Fixes finding 7b.)*
- **FR-5:** Every audio chunk must carry a monotonic sample-cursor offset from the start of its stream, in addition to wall-clock arrival time.
- **FR-6:** The system must not apply any energy-based gate, mute, or suppression to the microphone channel. The platform echo canceller is the only echo suppression in the pipeline.
- **FR-7:** If the system-audio tap produces only digital silence for 45 consecutive seconds while a render endpoint is metering output, the system must warn the user that system audio may not be captured.
- **FR-8:** Both channels must be written to disk as raw PCM for the duration of the recording, so that a transcription failure never loses the audio.

### Transcription

- **FR-9:** Each channel must be segmented independently by a Silero VAD before transcription. Fixed-interval chunking must not be used. *(Fixes finding 5a.)*
- **FR-10:** VAD segments must be accumulated into transcription windows of 15–30 seconds, cut only at a detected silence boundary, with approximately 1 second of overlap carried into the next window.
- **FR-11:** A window shorter than 30 seconds must be flushed if no further speech arrives within 8 seconds, so that the live transcript does not stall at the end of a turn.
- **FR-12:** Each transcription call must pass an `initialPrompt` consisting of the last ~200 characters of that channel's previous transcript followed by the user's dictionary terms. *(Fixes finding 5b.)*
- **FR-13:** whisper.cpp must run with hardened decoder thresholds (`entropy_thold = 2.8`, `logprob_thold = -1.25`). These must not be relaxed for the meeting path. *(Fixes finding 5c.)*
- **FR-14:** Each transcription call must pass the user's configured language explicitly. Automatic language detection must not be relied on. *(Fixes finding 4.)*
- **FR-15:** Transcription of the two channels must be queued against a single worker so that concurrent windows cannot oversubscribe CPU. Windows are processed oldest-first by audio time.
- **FR-16:** The system must support whisper.cpp (GGML models) and Parakeet via sherpa-onnx, selectable in Settings.
- **FR-17:** Overlapping text from a window's 1-second overlap region must be de-duplicated against the previous window's tail before the segment is committed.

### Transcript assembly

- **FR-18:** Every transcript segment must be timestamped from its **audio** position (stream start + sample cursor), never from the time transcription completed. *(Fixes finding 6 by removing the need for cross-stream alignment heuristics entirely.)*
- **FR-19:** The merged transcript must be ordered by audio timestamp across both channels.
- **FR-20:** Segments must be labelled `you` (microphone) or `them` (system audio). No other speaker attribution exists in v1.
- **FR-21:** The system must not implement duplicate detection, hold-back, or retraction between the two channels. With echo cancellation on, the microphone channel does not contain remote speech.
- **FR-22:** Transcript segments must be persisted as they are produced, so that a crash mid-meeting loses at most one window.

### Note generation

- **FR-23:** The system must run note generation against a local LLM served by llama.cpp.
- **FR-24:** The generation prompt must include: meeting title and date, the user's manual notes, the full labelled transcript, and the user's dictionary as a spelling reference.
- **FR-25:** The prompt must instruct the model to preserve named entities and numbers exactly, to distinguish proposals from decisions, and never to invent owners or deadlines.
- **FR-26:** Generated output must be streamed into the editor token by token.
- **FR-27:** The raw transcript must remain stored and viewable after generation. Generation must never overwrite it.
- **FR-28:** If the transcript exceeds the model's context window, the system must summarise in sections and then combine, rather than truncating silently.

### Meeting detection

- **FR-29:** The system must detect microphone use by known meeting applications using the CoreAudio process-object listener, excluding `com.apple.CoreSpeech`.
- **FR-30:** Detection must prompt through an in-app always-on-top overlay with content protection enabled, not a system notification.
- **FR-31:** All detection prompts must be suppressed while a recording is in progress.

### Storage

- **FR-32:** Notes, transcripts and settings must be stored in a local SQLite database under the app's support directory.
- **FR-33:** Raw PCM captures must be deleted when a recording's transcription completes successfully, unless the user has enabled audio retention in Settings.
- **FR-34:** The system must make no outbound network request except model downloads from a user-visible, configurable URL.

---

## 5. Non-Goals (Out of Scope)

| Not building | Why |
|---|---|
| Accounts, login, cloud sync | Local-first by design. This is the entire class of complexity being avoided. |
| Team spaces, sharing, invitations, roles | Single-user product. |
| Billing, subscriptions, usage limits, leaderboards | No hosted service to bill for. |
| Cloud transcription APIs (OpenAI, Deepgram, AssemblyAI) | Fully offline was an explicit decision. Revisit only if local accuracy proves insufficient. |
| Per-speaker diarization and voice fingerprinting | Deliberately deferred. Enabling it would force raw microphone capture and reintroduce every bug in Appendix A. |
| Windows and Linux | v1 is macOS only. |
| Global dictation / press-to-talk / paste-at-cursor | That is OpenWhispr's other product. Not this one. |
| Calendar integration | v2. Nothing in v1 depends on it. |
| A meeting bot that joins the call as a participant | Local capture only. |
| Real-time translation | Out of scope. |

---

## 6. Design Considerations

**Recording surface.** A compact floating pill during recording, showing elapsed time and two level meters (You / Them). It must be draggable, always on top, and content-protected so it never appears in a screen share. Clicking it opens the full note view.

**Note view.** Two panes: manual notes (editable markdown) on the left, live transcript on the right. After generation, the left pane holds the generated notes and the transcript moves behind a toggle. The user must always be one click from the raw transcript.

**Level meters are the trust signal.** The most common failure in this category is silently recording nothing. Two visibly moving meters tell the user the capture is alive before they have any transcript to judge. Treat them as a core feature, not decoration.

**Model download is onboarding.** A user with no model installed cannot do anything. The first-run flow should get a model on disk before it does anything else.

**Reuse from OpenWhispr (MIT licensed).** `resources/macos-audio-tap.swift` and `native/meeting-aec-helper/` are clean, self-contained, and worth lifting directly. `src/helpers/builtinActions.js` contains a mature note-generation prompt. Everything in `src/helpers/meetingMicGate.js`, `meetingEchoLeakDetector.js` and `meetingMicHoldback.js` should be left behind — FR-1 makes it unnecessary.

---

## 7. Tech Architecture (High-Level)

### Stack

| Layer | Choice | Notes |
|---|---|---|
| Shell | Electron 41, context isolation on | Keeps a path to Windows later; rich editor ecosystem |
| Renderer | React 19 + TypeScript + Tailwind | |
| Main process | Node 24 | Owns capture orchestration, transcription queue, database |
| System audio | Swift child process (`CATapDescription`) | macOS 14.2+; emits 16 kHz mono s16le on stdout, JSON events on stderr |
| Local ASR | whisper.cpp (GGML) and sherpa-onnx (Parakeet) | Run as a local HTTP server child process |
| VAD | Silero VAD | Segment boundaries per channel |
| Local LLM | llama.cpp server | Note generation |
| Database | better-sqlite3 with FTS5 | Notes, transcripts, settings, search |

**Why Electron over native Swift:** the note editor, markdown rendering and settings surface are far cheaper in web technology, and the audio-critical parts are child processes either way. The cost is a heavier binary. See Open Questions.

### Components

| Component | Responsibility |
|---|---|
| `AudioTapHost` (main) | Spawns and supervises the Swift tap; restarts on device change; timestamps chunks |
| `MicCapture` (renderer) | `getUserMedia` + AudioWorklet at 16 kHz; ships chunks with sample cursors |
| `RecordingSession` (main) | Owns one recording: PCM files, channel state, lifecycle |
| `VadSegmenter` (main) | One per channel; turns a PCM stream into utterance-bounded windows |
| `TranscriptionQueue` (main) | Single worker; oldest-window-first; owns the whisper.cpp / Parakeet client |
| `TranscriptStore` (main) | Persists segments, merges channels by audio timestamp |
| `NoteGenerator` (main) | Builds the prompt, streams from llama.cpp |
| `MeetingDetector` (main) | CoreAudio process-object listener, prompt policy |
| `NoteEditor`, `TranscriptPanel`, `RecordingPill` (renderer) | UI |

### Data flow — one recording

```
 MIC  ──getUserMedia(AEC on)──> AudioWorklet ──16kHz PCM + cursor──┐
                                                                   │
                                                                   ├──> RecordingSession
                                                                   │      │
 SYS  ──CATapDescription──> Swift helper ──16kHz PCM + cursor──────┘      │
                                                                          ▼
                                                    ┌──────────────────────────────┐
                                                    │ per channel:                 │
                                                    │   raw PCM file (crash safety)│
                                                    │   VadSegmenter               │
                                                    └──────────────┬───────────────┘
                                                                   │ 15-30s windows,
                                                                   │ 1s overlap
                                                                   ▼
                                                        TranscriptionQueue
                                                     (single worker, oldest first)
                                                                   │
                                          whisper.cpp  ◀───────────┤ language pinned
                                          + initialPrompt          │ dictionary + tail
                                                                   ▼
                                                          TranscriptStore
                                                   (ordered by AUDIO timestamp)
                                                                   │
                                            ┌──────────────────────┴────────────┐
                                            ▼                                   ▼
                                    live transcript UI                  NoteGenerator
                                                                        (llama.cpp)
```

Numbered walkthrough:

1. User clicks Record. `RecordingSession` opens, creates two PCM files, and starts both captures.
2. The renderer's AudioWorklet emits 16 kHz mono chunks; the Swift helper emits the same format on stdout. Both are stamped with a sample cursor.
3. Each channel's bytes are appended to its PCM file and pushed into its `VadSegmenter`.
4. When a segmenter accumulates 15–30 seconds ending at a silence boundary (or 8 seconds pass with no new speech), it emits a window carrying its start sample offset.
5. `TranscriptionQueue` picks the oldest pending window across both channels and calls whisper.cpp with the pinned language and an `initialPrompt` of previous-tail plus dictionary.
6. The returned text is de-duplicated against the previous window's overlap, timestamped from the window's audio offset, labelled `you` or `them`, and persisted.
7. The renderer receives the segment and inserts it into the merged, audio-ordered transcript.
8. On stop, both captures close, remaining windows flush, and PCM files are deleted once every window has succeeded.
9. "Generate notes" builds a prompt from title, date, manual notes, transcript and dictionary, and streams the result from llama.cpp into the editor.

### What is deliberately absent

No echo-leak correlator. No RMS gate. No mic hold-back queue. No duplicate detector. No segment retraction. No cross-stream alignment offset. In the reference implementation these total roughly 1,500 lines and are the direct cause of findings 1, 2, 3 and 6. FR-1 makes all of them unnecessary.

---

## 8. API Endpoints

**No external APIs required.** The app makes no authenticated network calls. The only outbound traffic is model file downloads over HTTPS from a configurable URL (default: Hugging Face), which require no credentials.

### Internal: IPC contract (renderer ↔ main)

| Channel | Direction | Payload | Purpose |
|---|---|---|---|
| `recording:start` | invoke | `{ title?: string }` | Begin a session; returns `{ sessionId, micReady, systemReady }` |
| `recording:stop` | invoke | `{ sessionId }` | End session; returns `{ noteId, segmentCount }` |
| `recording:mic-chunk` | send | `(ArrayBuffer, sampleCursor)` | Renderer → main microphone PCM |
| `recording:level` | on | `{ channel, rms }` | Level meters, ~20 Hz |
| `transcript:segment` | on | `{ sessionId, id, text, channel, startMs, endMs }` | A committed segment |
| `transcript:error` | on | `{ sessionId, message, fatal }` | Transcription failure |
| `audio:system-silent` | on | `{ sessionId }` | Tap produced silence while output was metering |
| `permissions:system-audio` | invoke | — | Returns `{ granted, status }` |
| `permissions:request-system-audio` | invoke | — | Triggers the OS prompt |
| `notes:generate` | invoke | `{ noteId, actionId }` | Start generation; streams via `notes:generate-chunk` |
| `notes:generate-chunk` | on | `{ noteId, delta }` | Streamed token |
| `notes:list` | invoke | `{ query?, limit, offset }` | List / search |
| `notes:get` | invoke | `{ noteId }` | Full note with segments |
| `notes:update` | invoke | `{ noteId, title?, manualNotes?, generatedNotes? }` | Save |
| `notes:delete` | invoke | `{ noteId }` | Delete |
| `notes:export` | invoke | `{ noteId, path }` | Write markdown |
| `models:list` | invoke | — | Installed and available models |
| `models:download` | invoke | `{ modelId }` | Streams `models:progress` |
| `dictionary:get` / `dictionary:set` | invoke | `{ terms: string[] }` | Personal dictionary |

### Internal: local child-process endpoints

| Service | Interface | Notes |
|---|---|---|
| whisper.cpp server | `POST http://127.0.0.1:<port>/inference` (multipart WAV) | Bound to loopback only; port chosen at spawn |
| llama.cpp server | `POST http://127.0.0.1:<port>/v1/chat/completions` (SSE) | OpenAI-shaped, local only |
| Swift audio tap | stdout: raw PCM; stderr: line-delimited JSON | Events: `start`, `error`, `device_changed`, `capture_silent` |

---

## 9. Data Dependencies

**Reads from:**
- CoreAudio process tap (system audio) — real-time
- macOS microphone via Chromium `getUserMedia` — real-time
- CoreAudio process-object listener (meeting detection) — event-driven
- Model files on local disk (GGML / ONNX weights)

**Writes to (new SQLite schema):**

| Table | Contents | Notes |
|---|---|---|
| `notes` | `id`, `title`, `manual_notes`, `generated_notes`, `created_at`, `duration_ms` | One per recording |
| `transcript_segments` | `id`, `note_id`, `channel` (`you`/`them`), `text`, `start_ms`, `end_ms` | Indexed on `(note_id, start_ms)` |
| `notes_fts` | FTS5 virtual table over title, notes and transcript text | Powers US-008 |
| `settings` | key/value | Model choice, language, dictionary, retention |
| `dictionary_terms` | `id`, `term` | |

**Transient on disk:** two raw PCM files per active recording under the app's temp directory, deleted on successful completion.

**Freshness:** Everything is local and immediate. No sync, no cache invalidation, no staleness model.

**Volume:** 16 kHz mono 16-bit is 1.92 MB per minute per channel, so a 1-hour meeting holds roughly 230 MB of transient PCM across both channels, deleted on completion. A transcript of the same meeting is roughly 40 KB of text. A library of 500 meetings is well under 100 MB of database.

**Sensitive data:** The entire product is sensitive — meeting audio and transcripts are among the most confidential content a user has. Mitigations: no network egress (FR-34), no telemetry, no crash reporting that includes transcript content, PCM deleted after use (FR-33), and content protection on every window that displays transcript text so it cannot be captured in a screen share.

**Source of truth:** the local SQLite database, exclusively. There is no server.

---

## 10. Success Metrics

These are targets to measure, not claims. Each names how it is verified.

| # | Metric | Target | How measured |
|---|---|---|---|
| M-1 | **Local-speaker recall** — fraction of the user's own utterances that appear in the transcript | ≥ 95% | Scripted test: play a known remote-audio track through the speakers while a person reads a fixed 40-utterance script into the mic. Count utterances present. This is the metric the reference implementation fails. |
| M-2 | **Mid-utterance dropouts** — silence injected into the middle of a spoken word | 0 | Assert no zeroed sample runs exist in the captured mic PCM. Structurally guaranteed by FR-6; test pins it. |
| M-3 | **Remote-speaker word error rate** | ≤ 15% on a clean call with the default model | Fixed reference recording, scored against a hand-corrected transcript |
| M-4 | **Echo bleed** — remote speech appearing in the `you` channel | ≤ 2% of `you` segments | Same scripted test as M-1, with the mic muted; count non-empty `you` segments |
| M-5 | **Live transcript latency** — speech ends to segment visible | ≤ 20 s p95 | Instrumented timestamps in a 30-minute recording |
| M-6 | **Transcription keeps up with real time** | Queue depth returns to zero within 60 s of recording stop | Queue instrumentation on the target hardware |
| M-7 | **Search latency** | < 300 ms at 500 notes | Seeded database benchmark |
| M-8 | **Crash resilience** | Force-quit mid-meeting loses ≤ 1 transcription window | Manual kill test |

M-1, M-2 and M-4 are the acceptance gate. If M-1 is not met, v1 is not done regardless of the rest.

---

## 11. Open Questions

1. **Electron or native Swift?** The PRD assumes Electron for editor and settings velocity. For a macOS-only, audio-heavy app, SwiftUI plus AVFoundation would be leaner and would remove the Chromium audio layer entirely — but it forfeits the Windows path and costs more editor work. **Decide before writing capture code**, because it changes FR-1's implementation from a `getUserMedia` constraint to an `AVAudioEngine` voice-processing I/O unit.

2. **Does Chromium's AEC reference the right output device?** FR-1 relies on the browser echo canceller having access to what is actually being played. This holds for the default output. It needs verification for Bluetooth headsets and for multi-output setups, and is the single riskiest assumption in this document. **Prototype and verify this before anything else is built.** If it does not hold, the fallback is the WebRTC AEC3 helper from OpenWhispr, driven by the tap output as an explicit reference — still far simpler than the heuristic layer, but a meaningful amount of extra work.

3. **Is a local LLM good enough for note generation?** Note quality is what makes this a Granola alternative rather than a transcript viewer. A 7–8B local model is noticeably weaker than a frontier model at extracting decisions and action items. If v1 note quality disappoints, the cheapest fix is a BYOK cloud option for generation only, keeping transcription offline — but that breaks the "nothing leaves the machine" promise and should be a deliberate, user-visible choice.

4. **Which default transcription model?** Parakeet is considerably faster than whisper.cpp on Apple Silicon; whisper large-v3-turbo is more accurate and multilingual. This depends on the target machine and should be settled with a benchmark on real hardware, not from documentation.

5. **Who are "Them" when there are five of them?** The two-way split labels all remote participants identically. For a 1:1 this is perfect; for a six-person call the notes will read "Them said X, then Them said Y". Worth user-testing early — it may push diarization from v2 into v1.

6. **What happens with headphones?** With headphones there is no acoustic echo path at all, so the mic channel is clean regardless of FR-1. Worth confirming that the AEC does not degrade the signal in that case.

7. **Audio retention default.** Off (delete after transcription) is the privacy-correct default, but it makes re-transcribing with a better model later impossible. Consider offering "keep audio for 7 days" as a middle option.

---

## Appendix A: Teardown findings and where they are addressed

Findings are from a source-level review of `shaunleeweirong/openwhispr` at commit `a7f22e0`. They are recorded here so the requirements that exist to prevent them are not later "simplified" away.

| # | Finding | Root cause | Addressed by |
|---|---|---|---|
| 1 | Per-33 ms RMS gate replaces quiet mic chunks with silence while the system channel is audible, perforating the user's own speech | Raw mic capture forced a hand-built echo suppressor | FR-1, FR-6 |
| 2 | The same gate runs on AEC-cleaned audio, and AEC lowers RMS — so enabling the good echo canceller makes the gate delete *more* speech | Gate applied unconditionally to the mic source | FR-1, FR-6 |
| 3 | In local mode the gate discards entire 5-second blocks when the remote party spoke in the preceding 5 seconds | Aggregate energy judged over a multi-second window | FR-1, FR-6, FR-9 |
| 4 | The BYOK cloud path resolves the user's language, passes it to `connect()`, and silently drops it — no language pin, so short turns mis-detect | Parameter dropped in the client's destructure | FR-14 |
| 5 | Local Whisper receives fixed 5-second slices with no overlap, no `initialPrompt`, and relaxed hallucination thresholds | Chunking tuned for CPU cost, not accuracy | FR-9, FR-10, FR-12, FR-13 |
| 6 | On Windows the echo reference is never time-aligned to the mic, because the 320 ms alignment holdback is reached only on the macOS path | Alignment branched on platform helper rather than timestamps | FR-5, FR-18 (and moot under FR-1) |
| 7 | Unfiltered linear 24k→16k resampling aliases 8–12 kHz content into the sibilance band; the capture worklet reads only channel 0 | Convenience resampler; single-channel read | FR-3, FR-4 |

**The pattern:** six of the seven findings descend from one decision — capturing the microphone raw so a diarizer could use it. Deferring diarization is not a feature cut. It is the fix.
