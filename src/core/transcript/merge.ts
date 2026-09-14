import type { Channel, TranscriptSegment } from "./types.ts";

/**
 * Ordering and rendering for the two-channel transcript.
 *
 * FR-19: order is by audio timestamp across both channels. Because every
 * segment is stamped from its own stream's sample cursor (FR-18), the two lanes
 * share one timeline and merging is a sort — no cross-stream alignment offset,
 * no holdback, no retraction. The reference implementation stamped segments
 * when transcription *returned*, so a long remote turn finished after a short
 * local interjection spoken during it, and the transcript read out of order.
 */

const CHANNEL_ORDER: Record<Channel, number> = { you: 0, them: 1 };

export function mergeSegments(segments: readonly TranscriptSegment[]): TranscriptSegment[] {
  return [...segments].sort((a, b) => {
    if (a.startMs !== b.startMs) return a.startMs - b.startMs;
    if (a.channel !== b.channel) return CHANNEL_ORDER[a.channel] - CHANNEL_ORDER[b.channel];
    if (a.endMs !== b.endMs) return a.endMs - b.endMs;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

export function formatTimestamp(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const mm = String(minutes).padStart(2, "0");
  const ss = String(seconds).padStart(2, "0");
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}

export interface FormatOptions {
  labels?: Record<Channel, string>;
  includeTimestamps?: boolean;
  /** Join consecutive segments from the same channel into one paragraph. */
  collapseRuns?: boolean;
}

const DEFAULT_LABELS: Record<Channel, string> = { you: "You", them: "Them" };

export function formatTranscript(
  segments: readonly TranscriptSegment[],
  options: FormatOptions = {}
): string {
  const { labels = DEFAULT_LABELS, includeTimestamps = true, collapseRuns = true } = options;
  const ordered = mergeSegments(segments).filter((s) => s.text.trim().length > 0);
  if (ordered.length === 0) return "";

  const lines: string[] = [];
  let runChannel: Channel | null = null;
  let runStartMs = 0;
  let runText: string[] = [];

  const flushRun = (): void => {
    if (runChannel === null || runText.length === 0) return;
    const stamp = includeTimestamps ? `[${formatTimestamp(runStartMs)}] ` : "";
    lines.push(`${stamp}${labels[runChannel]}: ${runText.join(" ")}`);
    runText = [];
  };

  for (const segment of ordered) {
    const text = segment.text.trim();
    if (!collapseRuns || segment.channel !== runChannel) {
      flushRun();
      runChannel = segment.channel;
      runStartMs = segment.startMs;
    }
    runText.push(text);
  }
  flushRun();

  return lines.join("\n");
}

/** Plain text of one channel, for building that channel's next initial prompt. */
export function channelText(segments: readonly TranscriptSegment[], channel: Channel): string {
  return mergeSegments(segments)
    .filter((s) => s.channel === channel)
    .map((s) => s.text.trim())
    .filter(Boolean)
    .join(" ");
}
