import type { JSX } from "react";

import type { NoteSummaryDto } from "../../shared/ipc.ts";

const formatDate = (ms: number): string =>
  new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });

const formatDuration = (ms: number): string => {
  const minutes = Math.round(ms / 60_000);
  return minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes}m`;
};

export function NoteList({
  notes,
  selectedId,
  onSelect,
  onDelete,
}: {
  notes: NoteSummaryDto[];
  selectedId: number | null;
  onSelect: (noteId: number) => void;
  onDelete: (noteId: number) => void;
}): JSX.Element {
  if (notes.length === 0) {
    return <p className="hint sidebar-empty">No meetings yet.</p>;
  }

  return (
    <ul className="note-list">
      {notes.map((note) => (
        <li key={note.id} className={note.id === selectedId ? "selected" : ""}>
          <button type="button" className="note-button" onClick={() => onSelect(note.id)}>
            <span className="note-title">{note.title || "Untitled meeting"}</span>
            <span className="note-meta">
              {formatDate(note.createdAt)}
              {note.durationMs > 0 ? ` · ${formatDuration(note.durationMs)}` : ""}
            </span>
            {note.snippet ? <span className="note-snippet">{note.snippet}</span> : null}
          </button>
          <button
            type="button"
            className="note-delete"
            aria-label={`Delete ${note.title || "untitled meeting"}`}
            onClick={() => onDelete(note.id)}
          >
            ×
          </button>
        </li>
      ))}
    </ul>
  );
}
