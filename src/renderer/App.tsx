import type { JSX } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { useRecorder } from "./useRecorder.ts";
import { LevelMeter } from "./components/LevelMeter.tsx";
import { TranscriptPanel } from "./components/TranscriptPanel.tsx";
import { NoteList } from "./components/NoteList.tsx";
import { formatTimestamp } from "../core/transcript/merge.ts";
import type { NoteDto, NoteSummaryDto, ServicesStatus } from "../shared/ipc.ts";

export function App(): JSX.Element {
  const [notes, setNotes] = useState<NoteSummaryDto[]>([]);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<NoteDto | null>(null);
  const [status, setStatus] = useState<ServicesStatus | null>(null);
  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState<string | null>(null);
  const [title, setTitle] = useState("");

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

  const banner = useMemo(() => {
    if (state.error) return { tone: "error" as const, text: state.error };
    if (generateError) return { tone: "error" as const, text: generateError };
    if (state.warning) return { tone: "warn" as const, text: state.warning };
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
  }, [state.error, state.warning, generateError, status]);

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

        {banner ? <div className={`banner ${banner.tone}`}>{banner.text}</div> : null}

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
