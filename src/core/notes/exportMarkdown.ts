import { formatTranscript } from "../transcript/merge.ts";
import type { TranscriptSegment } from "../transcript/types.ts";

/**
 * US-009: a note leaves the app as one markdown file carrying the generated
 * notes, the user's own notes, and the full labelled transcript with timestamps.
 */
export interface ExportInput {
  title?: string;
  createdAt?: number;
  durationMs?: number;
  manualNotes?: string;
  generatedNotes?: string;
  segments?: readonly TranscriptSegment[];
}

function formatDuration(ms: number): string {
  const totalMinutes = Math.round(ms / 60_000);
  if (totalMinutes < 60) return `${totalMinutes} min`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes === 0 ? `${hours} h` : `${hours} h ${minutes} min`;
}

export function exportNoteToMarkdown(input: ExportInput): string {
  const title = input.title?.trim() || "Untitled meeting";

  const meta: string[] = [];
  if (input.createdAt) meta.push(new Date(input.createdAt).toISOString().slice(0, 10));
  if (input.durationMs && input.durationMs > 0) meta.push(formatDuration(input.durationMs));

  const parts: string[] = [`# ${title}`];
  if (meta.length > 0) parts.push(`*${meta.join(" · ")}*`);

  const generated = input.generatedNotes?.trim();
  if (generated) parts.push(generated);

  const manual = input.manualNotes?.trim();
  if (manual) parts.push(`## My notes\n\n${manual}`);

  const transcript = formatTranscript(input.segments ?? [], { includeTimestamps: true });
  if (transcript) parts.push(`## Transcript\n\n${transcript}`);

  return `${parts.join("\n\n")}\n`;
}

/** A filesystem-safe filename for a note. */
export function suggestFilename(title: string | undefined, createdAt: number): string {
  const date = new Date(createdAt).toISOString().slice(0, 10);
  const slug = (title ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug ? `${date}-${slug}.md` : `${date}-meeting.md`;
}
