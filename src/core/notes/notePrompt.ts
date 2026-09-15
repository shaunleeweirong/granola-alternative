import { formatTranscript } from "../transcript/merge.ts";
import type { TranscriptSegment } from "../transcript/types.ts";

/**
 * Builds the note-generation request (FR-24, FR-25).
 *
 * The instruction set is adapted from OpenWhispr's "Detailed Notes" action
 * (MIT). Its most valuable property is the entity-preservation rule: local ASR
 * reliably misspells proper nouns, so the model is told to reconcile transcript
 * spellings against the meeting title, the user's manual notes and the
 * dictionary, and to mark a name unclear rather than guess.
 */
export const NOTE_SYSTEM_PROMPT = `Convert the provided meeting material into accurate, comprehensive, easy-to-scan notes in Markdown. Priorities, in order: factual accuracy, preservation of specifics, complete coverage of substantive topics, clear decisions and action items, concise presentation.

RULES:
- Use only information supported by the material. Never invent facts, decisions, owners, deadlines, or names.
- Keep the exact names of people, clients, companies, projects, products, tools, and acronyms, and the exact numbers, dates, deadlines, and document names. Never replace a named entity with a generic noun such as "the client" or "the project". If a name is unclear, write "[name unclear]" rather than guessing.
- Speech-to-text misspells names. When the transcript's spelling is an obvious variant of a name in the meeting title, the manual notes, or the glossary, use that spelling instead.
- Distinguish what was discussed, proposed, or requested from what was actually decided.
- Treat the user's manual notes as a signal of what matters most, reconciled against the transcript.
- The transcript labels the person recording as "You" and everyone else as "Them". Attribute actions accordingly; never invent individual names for "Them".
- Consolidate repeated discussion into one point. Drop greetings, filler, and false starts. Give longer meetings proportionally more detail.
- If there is no transcript, structure the user's own notes and skip the meeting-specific sections.

FORMAT:
- No title, date, attendee list, preamble, table, or horizontal rule. Omit any section with nothing to say.

## Summary
3-5 bullets: purpose, key subjects, major outcomes, immediate next steps.

## Discussion
Descriptive topic subheadings named after the actual client, project, or initiative, with enough context that someone who missed the meeting understands what happened and why.

## Decisions
Only decisions that were explicitly made or clearly agreed.

## Action Items
Only actions someone committed to or was asked to do; never turn a discussion topic into an action item. One checkbox per item in the form \`- [ ] Action (Owner)\`. Put a stated due date inside the action text. When the transcript shows no owner, end the line after the action; never write a placeholder.

## Open Questions
Unresolved questions, dependencies, and requested follow-ups.

Return only the finished Markdown notes.`;

export interface NotePromptInput {
  title?: string;
  createdAt?: number;
  manualNotes?: string;
  segments?: readonly TranscriptSegment[];
  dictionary?: readonly string[];
  /** Pre-rendered transcript, used when summarising a section (FR-28). */
  transcriptOverride?: string;
}

export interface ChatMessage {
  role: "system" | "user";
  content: string;
}

function section(heading: string, body: string): string {
  return body.trim() ? `${heading}\n${body.trim()}` : "";
}

export function buildNoteUserMessage(input: NotePromptInput): string {
  const transcript =
    input.transcriptOverride ?? formatTranscript(input.segments ?? [], { includeTimestamps: true });

  const context = [
    input.title?.trim() ? `Title: ${input.title.trim()}` : "",
    input.createdAt ? `Date: ${new Date(input.createdAt).toISOString().slice(0, 10)}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const glossary = (input.dictionary ?? []).map((t) => t.trim()).filter(Boolean);

  return [
    section("# Meeting Context", context),
    section("# Glossary (spelling reference only)", glossary.join(", ")),
    section("# Manual Notes", input.manualNotes ?? ""),
    section("# Transcript", transcript),
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function buildNoteMessages(input: NotePromptInput): ChatMessage[] {
  return [
    { role: "system", content: NOTE_SYSTEM_PROMPT },
    { role: "user", content: buildNoteUserMessage(input) },
  ];
}

/** True when there is nothing worth sending to a model. */
export function hasNoteMaterial(input: NotePromptInput): boolean {
  const hasTranscript = (input.segments ?? []).some((s) => s.text.trim().length > 0);
  return hasTranscript || (input.manualNotes ?? "").trim().length > 0;
}

/**
 * FR-28: split an over-long transcript into chunks that each fit the model's
 * context, rather than silently truncating. Splits between segments so a
 * sentence is never cut, and never returns an empty chunk.
 */
export function chunkTranscript(
  segments: readonly TranscriptSegment[],
  maxCharsPerChunk: number
): string[] {
  const rendered = formatTranscript(segments, { includeTimestamps: true });
  if (rendered.length <= maxCharsPerChunk) return rendered ? [rendered] : [];

  const lines = rendered.split("\n");
  const chunks: string[] = [];
  let current: string[] = [];
  let length = 0;

  for (const line of lines) {
    // A single line longer than the budget still has to go somewhere; it goes
    // into a chunk of its own rather than being dropped.
    if (current.length > 0 && length + line.length + 1 > maxCharsPerChunk) {
      chunks.push(current.join("\n"));
      current = [];
      length = 0;
    }
    current.push(line);
    length += line.length + 1;
  }
  if (current.length > 0) chunks.push(current.join("\n"));

  return chunks;
}
