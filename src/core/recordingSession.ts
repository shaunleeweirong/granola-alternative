import { VadSegmenter, type VadSegmenterOptions } from "./audio/vadSegmenter.ts";
import {
  TranscriptionQueue,
  type TranscriptionJob,
} from "./queue/transcriptionQueue.ts";
import { dedupeOverlap } from "./transcript/overlapDedup.ts";
import { buildInitialPrompt } from "./transcript/promptBuilder.ts";
import { mergeSegments } from "./transcript/merge.ts";
import { CHANNELS, type Channel, type TranscriptSegment } from "./transcript/types.ts";

/**
 * Orchestrates one recording: two capture channels in, an ordered transcript out.
 *
 * The whole point of this class is how little it does. There is no echo
 * detector, no energy gate, no cross-channel duplicate check, no hold-back
 * timer and no retraction — the microphone is captured with the platform echo
 * canceller on (FR-1), so the two channels are genuinely independent and the
 * transcript is a sort (FR-19).
 */
export interface TranscribeRequest {
  pcm: Buffer;
  channel: Channel;
  /** Previous-window context plus the dictionary (FR-12). */
  initialPrompt: string;
  /** Always explicit; auto-detection is never relied on (FR-14). */
  language: string;
}

export interface RecordingSessionDeps {
  transcribe: (request: TranscribeRequest) => Promise<string>;
  language?: string;
  dictionary?: readonly string[];
  segmenterOptions?: VadSegmenterOptions;
  /** FR-8: raw PCM is persisted so a transcription failure never loses audio. */
  onAudio?: (channel: Channel, pcm: Buffer) => void;
  /** FR-22: called as each segment is committed, for live UI and persistence. */
  onSegment?: (segment: TranscriptSegment) => void;
  onError?: (channel: Channel, error: Error) => void;
}

interface ChannelState {
  segmenter: VadSegmenter;
  /** Everything transcribed on this channel so far, for the next prompt. */
  text: string;
}

export class RecordingSession {
  private readonly deps: RecordingSessionDeps;
  private readonly language: string;
  private readonly dictionary: string[];
  private readonly channels: Record<Channel, ChannelState>;
  private readonly queue: TranscriptionQueue;
  private readonly collected: TranscriptSegment[] = [];
  private stopped = false;

  constructor(deps: RecordingSessionDeps) {
    this.deps = deps;
    this.language = deps.language ?? "en";
    this.dictionary = [...(deps.dictionary ?? [])];

    this.channels = {
      you: { segmenter: new VadSegmenter(deps.segmenterOptions), text: "" },
      them: { segmenter: new VadSegmenter(deps.segmenterOptions), text: "" },
    };

    this.queue = new TranscriptionQueue((job) => this.runJob(job), {
      onError: (job, error) => this.deps.onError?.(job.channel, error),
    });
  }

  /** Feed captured PCM16 for one channel. */
  pushAudio(channel: Channel, pcm: Buffer): void {
    if (this.stopped || pcm.length === 0) return;

    this.deps.onAudio?.(channel, pcm);

    const windows = this.channels[channel].segmenter.push(pcm);
    for (const window of windows) {
      this.queue.enqueue({ id: this.jobId(channel, window.startSample), channel, window });
    }
  }

  /** Close both channels, transcribe what remains, and return the transcript. */
  async stop(): Promise<TranscriptSegment[]> {
    if (this.stopped) {
      await this.queue.drain();
      return this.segments;
    }
    this.stopped = true;

    for (const channel of CHANNELS) {
      for (const window of this.channels[channel].segmenter.flush()) {
        this.queue.enqueue({ id: this.jobId(channel, window.startSample), channel, window });
      }
    }

    await this.queue.drain();
    return this.segments;
  }

  get segments(): TranscriptSegment[] {
    return mergeSegments(this.collected);
  }

  get queueDepth(): number {
    return this.queue.depth;
  }

  /**
   * The prompt is built here rather than at enqueue time so it sees the result
   * of the window before it. The queue is serial and oldest-first, so within a
   * channel that is always the immediately preceding window.
   */
  private async runJob(job: TranscriptionJob): Promise<string> {
    const state = this.channels[job.channel];

    const raw = await this.deps.transcribe({
      pcm: job.window.pcm,
      channel: job.channel,
      initialPrompt: buildInitialPrompt({
        previousText: state.text,
        dictionary: this.dictionary,
      }),
      language: this.language,
    });

    const text = this.removeOverlap(state.text, (raw ?? "").trim(), job.window.overlapMs);
    if (!text) return "";

    state.text = state.text ? `${state.text} ${text}` : text;

    const segment: TranscriptSegment = {
      id: job.id,
      channel: job.channel,
      text,
      startMs: Math.round(job.window.startMs),
      endMs: Math.round(job.window.endMs),
    };

    // Re-transcribing the same window replaces rather than duplicates, matching
    // the repo's INSERT OR REPLACE on segment id.
    const existing = this.collected.findIndex((s) => s.id === segment.id);
    if (existing >= 0) this.collected[existing] = segment;
    else this.collected.push(segment);

    this.deps.onSegment?.(segment);
    return text;
  }

  /**
   * Dedup is bounded by how much audio the window actually repeats.
   *
   * An unbounded token match deletes real content: a speaker who says the same
   * short phrase in two consecutive windows ("Yes." ... "Yes.") would lose the
   * second one. Only the overlap region can contain duplicated text, so the
   * match is capped at roughly the number of words that fit in it, and a window
   * with no overlap — the first one, or the first after a long silence — is
   * never deduplicated at all.
   */
  private removeOverlap(previous: string, next: string, overlapMs: number): string {
    if (!next) return "";
    if (overlapMs <= 0) return next;

    // 6 words/second is faster than anyone sustains; +2 for a clipped word at
    // each edge. At the default 1 s overlap this is 8 tokens.
    const maxOverlapTokens = Math.ceil((overlapMs / 1000) * 6) + 2;
    return dedupeOverlap(previous, next, { maxOverlapTokens });
  }

  private jobId(channel: Channel, startSample: number): string {
    return `${channel}-${startSample}`;
  }
}
