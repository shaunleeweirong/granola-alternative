import { CHANNEL_COUNT, SAMPLE_RATE } from "../../core/audio/format.ts";

/**
 * FR-1. The single most important twelve lines in this application.
 *
 * The microphone is opened with the platform echo canceller, noise suppression
 * and automatic gain control ON. Because v1 labels speakers by channel rather
 * than by diarization (FR-20), nothing downstream needs unprocessed audio, so
 * the operating system's echo canceller can do the job it is good at.
 *
 * The reference implementation set all three to `false` because its diarizer
 * needed raw audio. Having disabled the OS echo canceller it then had to
 * rebuild one in JavaScript — roughly 1,500 lines of correlation heuristics,
 * RMS gates, hold-back timers and retraction logic — and that reconstruction is
 * what deleted the local speaker's words from the transcript. Six of the seven
 * findings in the teardown descend from this one flag.
 *
 * Do not set these to false to "improve" anything. If per-speaker diarization
 * is added later, it needs a separate raw tap, not this stream.
 */
export const MIC_AUDIO_CONSTRAINTS = Object.freeze({
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
  channelCount: CHANNEL_COUNT,
  sampleRate: SAMPLE_RATE,
});

export function buildMicConstraints(deviceId?: string): MediaStreamConstraints {
  return {
    audio: deviceId
      ? { deviceId: { exact: deviceId }, ...MIC_AUDIO_CONSTRAINTS }
      : { ...MIC_AUDIO_CONSTRAINTS },
    video: false,
  };
}
