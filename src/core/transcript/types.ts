/** The microphone channel is the local user; the loopback channel is everyone else.
 *  v1 has no per-speaker diarization, so these two labels are the whole model (FR-20). */
export type Channel = "you" | "them";

export const CHANNELS: readonly Channel[] = ["you", "them"];

export interface TranscriptSegment {
  id: string;
  channel: Channel;
  text: string;
  /** Milliseconds from the start of the recording, derived from the audio sample
   *  cursor (FR-18). Never the wall-clock time transcription finished — that is
   *  what scrambled transcript order in the reference implementation. */
  startMs: number;
  endMs: number;
}
