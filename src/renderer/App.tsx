import type { JSX } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { useRecorder } from "./useRecorder.ts";
import { LevelMeter } from "./components/LevelMeter.tsx";
import { TranscriptPanel } from "./components/TranscriptPanel.tsx";
import { NoteList } from "./components/NoteList.tsx";
import { ModelSetup } from "./components/ModelSetup.tsx";
import { formatTimestamp } from "../core/transcript/merge.ts";
import { progressFraction } from "../core/models/catalog.ts";
import type { ModelStatus, NoteDto, NoteSummaryDto, ServicesStatus } from "../shared/ipc.ts";

export function App(): JSX.Element {
  const [notes, setNotes] = useState<NoteSummaryDto[]>([]);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<NoteDto | null>(null);
  const [status, setStatus] = useState<ServicesStatus | null>(null);
  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [model, setModel] = useState<ModelStatus | null>(null);
  const [setupDismissed, setSetupDismissed] = useState(false);

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
    void window.api.getModelStatus().then((next) => {
      if (!cancelled) setModel(next);
    });
    const unsubscribe = window.api.onModelProgress(setModel);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

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
    setGenerating(true);
    setGenerateError(null);
    setSelected({ ...selected, generatedNotes: "" });
    try {
      await window.api.generateNotes({ noteId: selected.id });
    } catch (error) {
      setGenerating(false);
      setGenerateError((error as Error).message);
    }
  }, [selected]);

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
    if (state.error) return { tone: "error" as const, text: state.error };
    if (generateError) return { tone: "error" as const, text: generateError };
    if (state.warning) return { tone: "warn" as const, text: state.warning };
    if (model && !model.installed) {
      return {
        tone: "warn" as const,
        text: model.downloading
          ? `Downloading the speech model${modelPercent === null ? "" : `, ${modelPercent}%`}. Recordings made now will be transcribed once it finishes.`
          : "No speech model yet, so recordings will be saved but not transcribed.",
        action: model.downloading ? null : { label: "Download", run: () => void window.api.downloadModel() },
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
  }, [state.error, state.warning, generateError, status, model, modelPercent]);

  if (model && !model.installed && !setupDismissed) {
    return (
      <ModelSetup
        status={model}
        onDownload={() => void window.api.downloadModel()}
        onCancel={() => void window.api.cancelModelDownload()}
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
                  {selected.generatedNotes ? (
                    <article className="generated">{selected.generatedNotes}</article>
                  ) : null}
                  <label className="field-label" htmlFor="manual-notes">
                    My notes
                  </label>
                  <textarea
                    id="manual-notes"
                    value={selected.manualNotes}
                    placeholder="Type while the meeting runs — these are passed to the summariser."
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
