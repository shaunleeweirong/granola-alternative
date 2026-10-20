import { useCallback, useEffect, useRef, useState } from "react";

import { buildMicConstraints } from "./audio/micConstraints.ts";
import { createCapturePipeline, type CapturePipeline } from "./audio/pcmWorklet.ts";
import type {
  AutoStopStatus,
  CurrentRecording,
  RendererApi,
  StartRecordingResult,
  SystemAudioStatus,
} from "../shared/ipc.ts";
import type { TranscriptSegment } from "../core/transcript/types.ts";

declare global {
  interface Window {
    api: RendererApi;
  }
}

export interface RecorderState {
  isRecording: boolean;
  isStarting: boolean;
  noteId: number | null;
  elapsedMs: number;
  micLevel: number;
  systemLevel: number;
  segments: TranscriptSegment[];
  warning: string | null;
  error: string | null;
  /**
   * Health of the "Them" capture. State rather than a message, so a helper that
   * dies mid-meeting stays on screen instead of scrolling away unnoticed.
   */
  systemAudio: SystemAudioStatus | null;
  /** A countdown to the recording stopping by itself, while one is running. */
  autoStop: AutoStopStatus | null;
  /** Why the last recording stopped, when it stopped by itself. */
  notice: string | null;
}

const INITIAL: RecorderState = {
  isRecording: false,
  isStarting: false,
  noteId: null,
  elapsedMs: 0,
  micLevel: 0,
  systemLevel: 0,
  segments: [],
  warning: null,
  error: null,
  systemAudio: null,
  autoStop: null,
  notice: null,
};

const micUnavailable = (error: unknown): string =>
  `Microphone unavailable: ${(error as Error).message}. Grant access in System Settings → Privacy & Security → Microphone.`;

export function useRecorder(onFinished?: (noteId: number) => void) {
  const [state, setState] = useState<RecorderState>(INITIAL);
  const pipelineRef = useRef<CapturePipeline | null>(null);
  const sessionRef = useRef<string | null>(null);
  const startedAtRef = useRef<number>(0);
  // Read from listeners registered once for the app's lifetime.
  const onFinishedRef = useRef(onFinished);
  onFinishedRef.current = onFinished;

  // Segments, levels and errors stream in from main for the whole app lifetime.
  useEffect(() => {
    const offSegment = window.api.onSegment(({ sessionId, segment }) => {
      if (sessionRef.current && sessionId && sessionId !== sessionRef.current) return;
      setState((prev) => {
        const without = prev.segments.filter((s) => s.id !== segment.id);
        const next = [...without, segment].sort((a, b) => a.startMs - b.startMs);
        return { ...prev, segments: next };
      });
    });

    // Without this the meters sit at zero, which is exactly the "silently
    // recording nothing" failure they exist to catch.
    const offLevel = window.api.onLevel(({ channel, rms }) => {
      setState((prev) =>
        channel === "you" ? { ...prev, micLevel: rms } : { ...prev, systemLevel: rms }
      );
    });

    const offError = window.api.onTranscriptError(({ message, fatal }) => {
      setState((prev) => ({ ...prev, error: message, isRecording: fatal ? false : prev.isRecording }));
    });

    const offSilent = window.api.onSystemAudioSilent(() => {
      setState((prev) => ({
        ...prev,
        warning:
          "No system audio has been heard for a while. Check that the call is playing through this Mac's speakers.",
      }));
    });

    const offSystemAudio = window.api.onSystemAudioStatus((systemAudio) => {
      setState((prev) => ({ ...prev, systemAudio }));
    });

    const offAutoStop = window.api.onAutoStopStatus((autoStop) => {
      setState((prev) => ({ ...prev, autoStop }));
    });

    // The main process can now end a recording by itself. A stop this window
    // asked for has already cleared the session, so only those are handled here.
    const offStopped = window.api.onRecordingStopped(({ sessionId, noteId, message }) => {
      if (!sessionId || sessionId !== sessionRef.current) return;
      sessionRef.current = null;
      void pipelineRef.current?.stop().catch(() => {});
      pipelineRef.current = null;
      setState((prev) => ({ ...prev, isRecording: false, autoStop: null, notice: message }));
      onFinishedRef.current?.(noteId);
    });

    return () => {
      offSegment();
      offLevel();
      offError();
      offSilent();
      offSystemAudio();
      offAutoStop();
      offStopped();
    };
  }, []);

  // A reload builds a fresh window while the main process carries on
  // recording. Pick that recording back up, microphone included, instead of
  // offering "Record meeting" over one that could then never be stopped.
  useEffect(() => {
    let cancelled = false;

    const adopt = async (current: CurrentRecording): Promise<void> => {
      sessionRef.current = current.sessionId;
      startedAtRef.current = current.startedAt;
      const note = await window.api.getNote({ noteId: current.noteId }).catch(() => null);
      if (cancelled || sessionRef.current !== current.sessionId) return;
      setState({
        ...INITIAL,
        isRecording: true,
        noteId: current.noteId,
        elapsedMs: Date.now() - current.startedAt,
        segments: note?.segments ?? [],
        systemAudio: current.systemAudio,
        autoStop: current.autoStop,
      });

      try {
        const stream = await navigator.mediaDevices.getUserMedia(buildMicConstraints());
        if (cancelled || sessionRef.current !== current.sessionId) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        pipelineRef.current = await createCapturePipeline(stream, ({ pcm }) => {
          window.api.sendMicChunk(pcm, 0);
        });
      } catch (error) {
        setState((prev) => ({ ...prev, error: micUnavailable(error) }));
      }
    };

    void window.api.getCurrentRecording().then((current) => {
      if (!cancelled && current && !sessionRef.current) void adopt(current);
    });

    return () => {
      cancelled = true;
    };
  }, []);

  // Elapsed time ticker.
  useEffect(() => {
    if (!state.isRecording) return undefined;
    const timer = window.setInterval(() => {
      setState((prev) => ({ ...prev, elapsedMs: Date.now() - startedAtRef.current }));
    }, 500);
    return () => window.clearInterval(timer);
  }, [state.isRecording]);

  const start = useCallback(async (title?: string): Promise<StartRecordingResult | null> => {
    setState({ ...INITIAL, isStarting: true });

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia(buildMicConstraints());
    } catch (error) {
      setState({ ...INITIAL, error: micUnavailable(error) });
      return null;
    }

    let started: StartRecordingResult;
    try {
      started = await window.api.startRecording({ title });
    } catch (error) {
      stream.getTracks().forEach((t) => t.stop());
      setState({ ...INITIAL, error: (error as Error).message });
      return null;
    }

    sessionRef.current = started.sessionId;
    startedAtRef.current = Date.now();

    pipelineRef.current = await createCapturePipeline(stream, ({ pcm }) => {
      window.api.sendMicChunk(pcm, 0);
    });

    setState((prev) => ({
      ...prev,
      isStarting: false,
      isRecording: true,
      noteId: started.noteId,
      warning: started.systemAudioReady
        ? null
        : "Recording the microphone only. System audio is unavailable, so the other participants will not be transcribed.",
    }));

    return started;
  }, []);

  const stop = useCallback(async (): Promise<void> => {
    const sessionId = sessionRef.current;
    sessionRef.current = null;

    await pipelineRef.current?.stop().catch(() => {});
    pipelineRef.current = null;

    if (!sessionId) {
      setState((prev) => ({ ...prev, isRecording: false, autoStop: null }));
      return;
    }

    try {
      const result = await window.api.stopRecording({ sessionId });
      setState((prev) => ({ ...prev, isRecording: false, autoStop: null }));
      onFinished?.(result.noteId);
    } catch (error) {
      setState((prev) => ({ ...prev, isRecording: false, autoStop: null, error: (error as Error).message }));
    }
  }, [onFinished]);

  const keepRecording = useCallback(() => void window.api.respondToAutoStop("keep"), []);
  const dismissNotice = useCallback(() => setState((prev) => ({ ...prev, notice: null })), []);

  // Never leave the microphone open if the window goes away mid-recording.
  useEffect(() => {
    return () => {
      void pipelineRef.current?.stop().catch(() => {});
    };
  }, []);

  return { state, start, stop, keepRecording, dismissNotice };
}
