import type { JSX } from "react";

/** Injected by Vite at build time; see vite.config.mts. */
declare const __BUILD_ID__: string;
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useRecorder } from "./useRecorder.ts";
import { LevelMeter } from "./components/LevelMeter.tsx";
import { TranscriptPanel } from "./components/TranscriptPanel.tsx";
import { NoteList } from "./components/NoteList.tsx";
import { ModelSetup } from "./components/ModelSetup.tsx";
import { LanguageModelPrompt } from "./components/LanguageModelPrompt.tsx";
import { NoteStylePicker } from "./components/NoteStylePicker.tsx";
import { formatTimestamp } from "../core/transcript/merge.ts";
import { progressFraction } from "../core/models/catalog.ts";
import type { ModelStatus, NoteDto, NoteSummaryDto, ServicesStatus } from "../shared/ipc.ts";
import { DEFAULT_NOTE_PREFERENCES, resolveStyle, type NotePreferences } from "../core/notes/noteStyles.ts";

export function App(): JSX.Element {
  const [notes, setNotes] = useState<NoteSummaryDto[]>([]);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<NoteDto | null>(null);
  const [status, setStatus] = useState<ServicesStatus | null>(null);
  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [model, setModel] = useState<ModelStatus | null>(null);
  const [languageModel, setLanguageModel] = useState<ModelStatus | null>(null);
  const [setupDismissed, setSetupDismissed] = useState(false);
  const [offeringLanguageModel, setOfferingLanguageModel] = useState(false);
  const [notePrefs, setNotePrefs] = useState<NotePreferences>(DEFAULT_NOTE_PREFERENCES);
  const [pickingStyle, setPickingStyle] = useState(false);

  const refreshNotes = useCallback(
    async (search = query) => {
      setNotes(await window.api.listNotes({ query: search }));
    },
    [query]
  );

  const openNote = useCallback(async (noteId: number) => {
    const note = await window.api.getNote({ noteId });
    setSelected(note);
    setTitle(note?.title ?? "");
    setGenerateError(null);
  }, []);

  const { state, start, stop } = useRecorder(
    useCallback(
      async (noteId: number) => {
        await refreshNotes();
        await openNote(noteId);
      },
      [refreshNotes, openNote]
    )
  );

  useEffect(() => {
    void refreshNotes();
  }, [refreshNotes]);

  // The speech engine loads a multi-gigabyte model, so it is not ready the
  // instant the window opens. Checking once on mount left the warning up even
  // after a successful start. Poll until it is ready, then stop.
  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;

    const check = async (): Promise<void> => {
      const next = await window.api.getServicesStatus();
      if (cancelled) return;
      setStatus(next);
      if (!next.transcriptionReady) timer = window.setTimeout(() => void check(), 3000);
    };

    void check();
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, []);

  // The model is fetched on first launch rather than shipped in the installer,
  // so the app has to know whether it is there yet, and follow the download.
  useEffect(() => {
    let cancelled = false;
    const apply = (next: ModelStatus): void => {
      if (next.kind === "language") setLanguageModel(next);
      else setModel(next);
    };

    void window.api.getModelStatus("speech").then((next) => {
      if (!cancelled) apply(next);
    });
    void window.api.getModelStatus("language").then((next) => {
      if (!cancelled) apply(next);
    });

    const unsubscribe = window.api.onModelProgress(apply);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  // The note is created the moment recording starts, but nothing selected it, so
  // the meeting ran with a placeholder where the editor should have been and
  // there was no way to take notes during the call the app exists to record.
  const autoOpenedRef = useRef<number | null>(null);
  useEffect(() => {
    if (!state.isRecording || state.noteId === null) return;
    if (selected?.id === state.noteId) return;
    // Once per recording. Retrying on every change of `selected` would spin
    // forever if the note went away: deleting it from the sidebar mid-meeting
    // clears the selection, which would immediately ask for it again.
    if (autoOpenedRef.current === state.noteId) return;
    autoOpenedRef.current = state.noteId;
    void openNote(state.noteId);
  }, [state.isRecording, state.noteId, selected?.id, openNote]);

  // Streamed note generation appends into the editor as it arrives (FR-26).
  useEffect(() => {
    return window.api.onGenerateChunk(({ noteId, delta, done, error }) => {
      if (error) {
        setGenerating(false);
        setGenerateError(error);
        return;
      }
      if (done) {
        setGenerating(false);
        void openNote(noteId);
        return;
      }
      setSelected((prev) =>
        prev && prev.id === noteId ? { ...prev, generatedNotes: prev.generatedNotes + delta } : prev
      );
    });
  }, [openNote]);

  useEffect(() => {
    if (languageModel?.installed) setOfferingLanguageModel(false);
  }, [languageModel?.installed]);

  useEffect(() => {
    void window.api.getNotePreferences().then(setNotePrefs);
  }, []);

  // The button that opens it lives beside Generate notes, which is hidden while
  // recording, so leaving the panel up would strand it with no way back.
  useEffect(() => {
    if (state.isRecording) setPickingStyle(false);
  }, [state.isRecording]);

  const updateNotePrefs = useCallback((next: NotePreferences) => {
    setNotePrefs(next);
    void window.api.setNotePreferences(next);
  }, []);

  const liveSegments = state.isRecording ? state.segments : (selected?.segments ?? []);

  const saveManualNotes = useCallback(
    async (value: string) => {
      if (!selected) return;
      setSelected({ ...selected, manualNotes: value });
      await window.api.updateNote({ noteId: selected.id, manualNotes: value });
    },
    [selected]
  );

  const saveTitle = useCallback(async () => {
    if (!selected || title === selected.title) return;
    await window.api.updateNote({ noteId: selected.id, title });
    await refreshNotes();
  }, [selected, title, refreshNotes]);

  const generate = useCallback(async () => {
    if (!selected) return;
    // Asking for something the app can fetch is not an error state; offer it.
    if (languageModel && !languageModel.installed) {
      setOfferingLanguageModel(true);
      return;
    }
    setGenerating(true);
    setGenerateError(null);
    setSelected({ ...selected, generatedNotes: "" });
    try {
      await window.api.generateNotes({ noteId: selected.id });
    } catch (error) {
      setGenerating(false);
      const message = (error as Error).message;
      if (message.includes("NO_LANGUAGE_MODEL")) {
        setOfferingLanguageModel(true);
        return;
      }
      setGenerateError(message);
    }
  }, [selected, languageModel]);

  const removeNote = useCallback(
    async (noteId: number) => {
      if (!window.confirm("Delete this meeting and its transcript? This cannot be undone.")) return;
      await window.api.deleteNote({ noteId });
      if (selected?.id === noteId) setSelected(null);
      await refreshNotes();
    },
    [selected, refreshNotes]
  );

  // Shown in the banner when the setup screen has been dismissed but the
  // download is still running, so it does not just say "downloading" forever.
  const modelPercent = useMemo(() => {
    if (!model?.downloading) return null;
    const fraction = progressFraction(model.receivedBytes, model.totalBytes);
    return fraction === null ? null : Math.round(fraction * 100);
  }, [model]);

  const banner = useMemo(() => {
    // First, because it is the only failure that silently costs half the
    // conversation, and it is happening right now rather than in a past message.
    const systemAudio = state.systemAudio;
    if (state.isRecording && systemAudio?.state === "recovering") {
      return {
        tone: "warn" as const,
        text: `System audio stopped, reconnecting (attempt ${systemAudio.attempt} of ${systemAudio.maxAttempts}). ${systemAudio.detail ?? ""}`.trim(),
      };
    }
    if (state.isRecording && systemAudio?.state === "lost") {
      return {
        tone: "error" as const,
        text: `System audio has stopped and could not be restarted, so only your microphone is being recorded from here on. ${systemAudio.detail ?? ""}`.trim(),
      };
    }
    if (state.error) return { tone: "error" as const, text: state.error };
    if (generateError) return { tone: "error" as const, text: generateError };
    if (state.warning) return { tone: "warn" as const, text: state.warning };
    if (model && !model.installed) {
      return {
        tone: "warn" as const,
        text: model.downloading
          ? `Downloading the speech model${modelPercent === null ? "" : `, ${modelPercent}%`}. Recordings made now will be transcribed once it finishes.`
          : "No speech model yet, so recordings will be saved but not transcribed.",
        action: model.downloading ? null : { label: "Download", run: () => void window.api.downloadModel("speech") },
      };
    }
    if (status && !status.transcriptionReady) {
      if (status.transcriptionStarting) {
        return {
          tone: "warn" as const,
          text: "Starting the speech engine. The first launch takes a minute while the model loads; you can record now and it will catch up.",
        };
      }
      return {
        tone: "error" as const,
        text: status.transcriptionReason
          ? `Transcription is unavailable. ${status.transcriptionReason}`
          : "Transcription is unavailable. Recordings will be saved but not transcribed.",
      };
    }
    if (status && !status.systemAudioSupported) {
      return {
        tone: "warn" as const,
        text: "System audio capture needs macOS 14.2 or later. Recordings will capture the microphone only.",
      };
    }
    return null;
  }, [state.error, state.warning, state.systemAudio, state.isRecording, generateError, status, model, modelPercent]);

  if (model && !model.installed && !setupDismissed) {
    return (
      <ModelSetup
        status={model}
        onDownload={() => void window.api.downloadModel("speech")}
        onCancel={() => void window.api.cancelModelDownload("speech")}
        onSkip={() => setSetupDismissed(true)}
      />
    );
  }

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="sidebar-head">
          <h1>Meetings</h1>
          <input
            id="note-search"
            type="search"
            placeholder="Search notes and transcripts"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              void refreshNotes(event.target.value);
            }}
          />
        </div>
        <NoteList notes={notes} selectedId={selected?.id ?? null} onSelect={openNote} onDelete={removeNote} />
        <footer className="build-id" title="The commit this app was built from">
          Build {__BUILD_ID__}
        </footer>
      </aside>

      <main className="main">
        <header className="toolbar">
          {state.isRecording ? (
            <div className="recording-controls">
              <button type="button" className="stop" onClick={() => void stop()}>
                Stop recording
              </button>
              <span className="elapsed">{formatTimestamp(state.elapsedMs)}</span>
              <LevelMeter label="You" level={state.micLevel} />
              <LevelMeter label="Them" level={state.systemLevel} />
            </div>
          ) : (
            <button
              type="button"
              className="record"
              disabled={state.isStarting}
              onClick={() => void start(new Date().toLocaleString())}
            >
              {state.isStarting ? "Starting…" : "Record meeting"}
            </button>
          )}

          {selected && !state.isRecording ? (
            <div className="note-actions">
              <button
                type="button"
                className="style-button"
                onClick={() => setPickingStyle((open) => !open)}
                title="Choose what Generate notes produces"
              >
                {resolveStyle(notePrefs.styleId).label}
              </button>
              <button type="button" onClick={() => void generate()} disabled={generating}>
                {generating ? "Generating…" : "Generate notes"}
              </button>
              <button type="button" onClick={() => void window.api.exportNote({ noteId: selected.id })}>
                Export
              </button>
            </div>
          ) : null}
        </header>

        {banner ? (
          <div className={`banner ${banner.tone}`}>
            <span>{banner.text}</span>
            {"action" in banner && banner.action ? (
              <button type="button" className="banner-action" onClick={banner.action.run}>
                {banner.action.label}
              </button>
            ) : null}
          </div>
        ) : null}

        {selected || state.isRecording ? (
          <div className="panes">
            <section className="pane notes-pane">
              {selected ? (
                <>
                  <input
                    id="note-title"
                    className="title-input"
                    value={title}
                    placeholder="Untitled meeting"
                    onChange={(event) => setTitle(event.target.value)}
                    onBlur={() => void saveTitle()}
                  />
                  {pickingStyle ? (
                    <NoteStylePicker
                      preferences={notePrefs}
                      onChange={updateNotePrefs}
                      onClose={() => setPickingStyle(false)}
                    />
                  ) : null}
                  {offeringLanguageModel && languageModel ? (
                    <LanguageModelPrompt
                      status={languageModel}
                      onDownload={() => void window.api.downloadModel("language")}
                      onCancel={() => void window.api.cancelModelDownload("language")}
                      onDismiss={() => setOfferingLanguageModel(false)}
                    />
                  ) : null}
                  {selected.generatedNotes ? (
                    <article className="generated">{selected.generatedNotes}</article>
                  ) : null}
                  <label className="field-label" htmlFor="manual-notes">
                    My notes
                  </label>
                  <textarea
                    id="manual-notes"
                    value={selected.manualNotes}
                    placeholder="Type while the meeting runs. These are passed to the summariser."
                    onChange={(event) => void saveManualNotes(event.target.value)}
                  />
                </>
              ) : (
                <p className="hint">Recording… your notes will be saved here.</p>
              )}
            </section>

            <section className="pane transcript-pane">
              <TranscriptPanel segments={liveSegments} live={state.isRecording} />
            </section>
          </div>
        ) : (
          <div className="empty">
            <h2>Nothing selected</h2>
            <p>Press Record when a call starts, or pick a past meeting from the list.</p>
          </div>
        )}
      </main>
    </div>
  );
}
