import { tailOf } from "./overlapDedup.ts";

/**
 * Builds the `initial_prompt` handed to whisper.cpp for every window (FR-12).
 *
 * Two jobs. First, carry the previous window's tail so the decoder has
 * conversational context across a cut — Whisper conditions on this text and
 * without it every window starts cold. Second, carry the user's dictionary so
 * names and jargon are spelled consistently.
 *
 * The reference implementation set an initial prompt in exactly one place, the
 * dictation path, so meeting transcription ran with no context and no
 * dictionary at all (teardown finding 5b).
 *
 * Whisper's prompt budget is 224 tokens. Overrunning it silently truncates from
 * the *front*, which would drop the dictionary, so the total is capped here.
 */
export interface InitialPromptOptions {
  previousText?: string;
  dictionary?: string[];
  /** Characters of previous transcript to carry. */
  maxTailChars?: number;
  /** Hard ceiling on the whole prompt. ~4 chars/token against a 224-token budget. */
  maxTotalChars?: number;
}

const DEFAULTS = { maxTailChars: 200, maxTotalChars: 700 };

export function buildInitialPrompt(options: InitialPromptOptions = {}): string {
  const { previousText = "", dictionary = [], maxTailChars, maxTotalChars } = {
    ...DEFAULTS,
    ...options,
  };

  const terms = dictionary.map((t) => t.trim()).filter(Boolean);
  // Dictionary first: if anything has to be dropped it should be old context,
  // not the spellings the user explicitly asked for.
  const glossary = terms.length > 0 ? `Glossary: ${terms.join(", ")}.` : "";

  const budgetForTail = Math.max(0, maxTotalChars - glossary.length - 1);
  const tail = tailOf(previousText, Math.min(maxTailChars, budgetForTail));

  return [glossary, tail].filter(Boolean).join(" ").trim();
}
