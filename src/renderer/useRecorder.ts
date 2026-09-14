import { useCallback, useEffect, useRef, useState } from "react";

import { buildMicConstraints } from "./audio/micConstraints.ts";
import { createCapturePipeline, type CapturePipeline } from "./audio/pcmWorklet.ts";
import type { RendererApi, StartRecordingResult } from "../shared/ipc.ts";
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
};

export function useRecorder(onFinished?: (noteId: number) => void) {
  const [state, setState] = useState<RecorderState>(INITIAL);
  const pipelineRef = useRef<CapturePipeline | null>(null);
  const sessionRef = useRef<string | null>(null);
  const startedAtRef = useRef<number>(0);

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

    return () => {
      offSegment();
      offLevel();
      offError();
      offSilent();
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
      setState({
        ...INITIAL,
        error: `Microphone unavailable: ${(error as Error).message}. Grant access in System Settings → Privacy & Security → Microphone.`,
      });
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
        : "Recording the microphone only — system audio is unavailable, so the other participants will not be transcribed.",
    }));

    return started;
  }, []);

  const stop = useCallback(async (): Promise<void> => {
    const sessionId = sessionRef.current;
    sessionRef.current = null;

    await pipelineRef.current?.stop().catch(() => {});
    pipelineRef.current = null;

    if (!sessionId) {
      setState((prev) => ({ ...prev, isRecording: false }));
      return;
    }

    try {
      const result = await window.api.stopRecording({ sessionId });
      setState((prev) => ({ ...prev, isRecording: false }));
      onFinished?.(result.noteId);
    } catch (error) {
      setState((prev) => ({ ...prev, isRecording: false, error: (error as Error).message }));
    }
  }, [onFinished]);

  // Never leave the microphone open if the window goes away mid-recording.
  useEffect(() => {
    return () => {
      void pipelineRef.current?.stop().catch(() => {});
    };
  }, []);

  return { state, start, stop };
}
