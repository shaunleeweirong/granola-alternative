/**
 * Removes the text a window repeats from its predecessor (FR-17).
 *
 * Windows overlap by ~1 s so a cut can never sever a word, which means the
 * first words of each window are already in the previous one. ASR will not
 * transcribe the same audio to byte-identical text twice, so the match has to
 * be on normalized tokens rather than raw strings.
 */

interface Token {
  normalized: string;
  /** Index into the original string where this token starts. */
  start: number;
}

/** Strip punctuation and case so "Right," and "right" match. */
function normalize(raw: string): string {
  return raw.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  const re = /\S+/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const normalized = normalize(match[0]);
    if (normalized) tokens.push({ normalized, start: match.index });
  }
  return tokens;
}

export interface DedupeOptions {
  /** Never consider an overlap longer than this. A 1 s overlap is at most a
   *  handful of words; a longer "match" means the speaker repeated themselves
   *  and we must not delete that. */
  maxOverlapTokens?: number;
  /** Shorter matches than this are coincidence ("the", "and") unless they run
   *  to the very end of the previous window. */
  minOverlapTokens?: number;
}

const DEFAULTS = { maxOverlapTokens: 12, minOverlapTokens: 2 };

/**
 * @returns `next` with any duplicated leading tokens removed.
 */
export function dedupeOverlap(
  previous: string,
  next: string,
  options: DedupeOptions = {}
): string {
  const { maxOverlapTokens, minOverlapTokens } = { ...DEFAULTS, ...options };

  const prevTokens = tokenize(previous);
  const nextTokens = tokenize(next);
  if (prevTokens.length === 0 || nextTokens.length === 0) return next.trim();

  const limit = Math.min(maxOverlapTokens, prevTokens.length, nextTokens.length);

  // Longest match wins: prefer deleting more, since a longer coincidental match
  // is far less likely than a short one.
  for (let k = limit; k >= minOverlapTokens; k -= 1) {
    let matches = true;
    for (let i = 0; i < k; i += 1) {
      if (prevTokens[prevTokens.length - k + i].normalized !== nextTokens[i].normalized) {
        matches = false;
        break;
      }
    }
    if (matches) {
      if (k === nextTokens.length) return "";
      return next.slice(nextTokens[k].start).trim();
    }
  }

  return next.trim();
}

/** Last `maxChars` of a transcript, cut at a word boundary. Feeds FR-12. */
export function tailOf(text: string, maxChars: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) return trimmed;
  const tail = trimmed.slice(trimmed.length - maxChars);
  const firstSpace = tail.indexOf(" ");
  return (firstSpace === -1 ? tail : tail.slice(firstSpace + 1)).trim();
}
