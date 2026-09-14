# granola-alternative

A local-first meeting notes app for macOS. Records both sides of a call, transcribes on-device, and turns the transcript into structured notes.

No accounts, no sync, no teams, no billing. Nothing leaves the machine.

## Status

Planning. No code yet.

## Documents

- [`tasks/prd-meeting-notes.md`](tasks/prd-meeting-notes.md) — v1 product requirements, architecture, and the audio-pipeline findings the design is built to avoid.

## Scope at a glance

| | v1 |
|---|---|
| Platform | macOS 14.2+ |
| Transcription | whisper.cpp / Parakeet, fully offline |
| Note generation | llama.cpp, local |
| Speakers | Two-way split: You (microphone) / Them (system audio) |
| Storage | Local SQLite |
