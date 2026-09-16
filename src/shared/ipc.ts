import type { Channel, TranscriptSegment } from "../core/transcript/types.ts";
import { MODELS, type ModelKind } from "../core/models/catalog.ts";
import type { NotePreferences } from "../core/notes/noteStyles.ts";

/** Channel names for renderer <-> main. Kept in one place so both sides agree. */
export const IPC = {
  recordingStart: "recording:start",
  recordingStop: "recording:stop",
  recordingMicChunk: "recording:mic-chunk",
  recordingLevel: "recording:level",
  transcriptSegment: "transcript:segment",
  transcriptError: "transcript:error",
  audioSystemSilent: "audio:system-silent",
  audioSystemStatus: "audio:system-status",
  permissionsSystemAudio: "permissions:system-audio",
  permissionsRequestSystemAudio: "permissions:request-system-audio",
  notesGenerate: "notes:generate",
  notesGenerateChunk: "notes:generate-chunk",
  notesList: "notes:list",
  notesGet: "notes:get",
  notesUpdate: "notes:update",
  notesDelete: "notes:delete",
  notesExport: "notes:export",
  notePrefsGet: "notes:prefs-get",
  notePrefsSet: "notes:prefs-set",
  dictionaryGet: "dictionary:get",
  dictionarySet: "dictionary:set",
  servicesStatus: "services:status",
  modelStatus: "model:status",
  modelDownload: "model:download",
  modelCancel: "model:cancel",
  modelProgress: "model:progress",
} as const;

export interface StartRecordingResult {
  sessionId: string;
  noteId: number;
  /** False when the system-audio tap could not start; the app records mic-only. */
  systemAudioReady: boolean;
  systemAudioReason?: string;
}

export interface StopRecordingResult {
  noteId: number;
  segmentCount: number;
  durationMs: number;
}

export interface LevelUpdate {
  channel: Channel;
  rms: number;
}

/**
 * Health of the system-audio ("Them") capture during a recording.
 *
 * The helper is a separate process and it can die mid-meeting, most plausibly
 * when the output device changes under it (headphones, AirPods, a Bluetooth
 * speaker). Losing it silently costs the entire remote half of the
 * conversation, so its state is tracked explicitly rather than announced once
 * in a message that scrolls away.
 */
export type SystemAudioState = "capturing" | "recovering" | "lost" | "unsupported";

export interface SystemAudioStatus {
  state: SystemAudioState;
  /** The helper's own last words, so the next failure diagnoses itself. */
  detail?: string | null;
  /** Which recovery attempt is in flight, for "reconnecting, 2 of 3". */
  attempt?: number;
  maxAttempts?: number;
}

export interface SegmentEvent {
  sessionId: string;
  noteId: number;
  segment: TranscriptSegment;
}

export interface TranscriptErrorEvent {
  sessionId: string;
  message: string;
  fatal: boolean;
}

export interface NoteSummaryDto {
  id: number;
  title: string;
  createdAt: number;
  durationMs: number;
  segmentCount: number;
  snippet?: string;
}

export interface NoteDto {
  id: number;
  title: string;
  manualNotes: string;
  generatedNotes: string;
  createdAt: number;
  durationMs: number;
  segments: TranscriptSegment[];
}

export interface ServicesStatus {
  transcriptionReady: boolean;
  languageModelReady: boolean;
  systemAudioSupported: boolean;
  systemAudioGranted: boolean;
  /** Why transcription is unavailable, in words a user can act on. */
  transcriptionReason?: string | null;
  /** Whether the engine is still loading, so the UI can say "starting" not "broken". */
  transcriptionStarting?: boolean;
  /** Recent engine output, for a bug report. */
  transcriptionLog?: string[];
}

/**
 * State of the one speech model the app needs.
 *
 * The model is fetched on first launch rather than shipped inside the
 * installer, so the UI has to be able to say where that has got to.
 */
export interface ModelStatus {
  kind: ModelKind;
  /** A verified copy is on disk and the engine that needs it can run. */
  installed: boolean;
  displayName: string;
  description: string;
  /** Rough size, for "this will download about X" before a request is made. */
  approxBytes: number;
  downloading: boolean;
  receivedBytes: number;
  /** Null when the server did not say; the UI shows an indeterminate bar. */
  totalBytes: number | null;
  /** Bytes already on disk from an interrupted attempt, which will be resumed. */
  resumableBytes: number;
  error: string | null;
}

/**
 * A stand-in for a model whose real status has not arrived from the main
 * process yet, or whose status request failed.
 *
 * Exists because the alternative was rendering nothing: the download offer used
 * to be gated on the real status being present, so pressing Generate notes
 * before it loaded did nothing at all, silently. Describing the model from the
 * catalog is always possible and always honest, since the catalog is what the
 * download would use anyway.
 */
export function unknownModelStatus(kind: ModelKind): ModelStatus {
  const spec = MODELS[kind];
  return {
    kind,
    installed: false,
    displayName: spec.displayName,
    description: spec.description,
    approxBytes: spec.approxBytes,
    downloading: false,
    receivedBytes: 0,
    totalBytes: null,
    resumableBytes: 0,
    error: null,
  };
}

export interface GenerateChunkEvent {
  noteId: number;
  delta: string;
  done?: boolean;
  error?: string;
}

/** The surface the preload script exposes on `window.api`. */
export interface RendererApi {
  startRecording(input: { title?: string }): Promise<StartRecordingResult>;
  stopRecording(input: { sessionId: string }): Promise<StopRecordingResult>;
  sendMicChunk(pcm: ArrayBuffer, startSample: number): void;
  listNotes(input: { query?: string; limit?: number; offset?: number }): Promise<NoteSummaryDto[]>;
  getNote(input: { noteId: number }): Promise<NoteDto | null>;
  updateNote(input: {
    noteId: number;
    title?: string;
    manualNotes?: string;
    generatedNotes?: string;
  }): Promise<void>;
  deleteNote(input: { noteId: number }): Promise<void>;
  exportNote(input: { noteId: number }): Promise<{ path: string } | null>;
  generateNotes(input: { noteId: number }): Promise<void>;
  getNotePreferences(): Promise<NotePreferences>;
  setNotePreferences(prefs: NotePreferences): Promise<void>;
  getDictionary(): Promise<string[]>;
  setDictionary(terms: string[]): Promise<void>;
  getServicesStatus(): Promise<ServicesStatus>;
  getModelStatus(kind: ModelKind): Promise<ModelStatus>;
  downloadModel(kind: ModelKind): Promise<ModelStatus>;
  cancelModelDownload(kind: ModelKind): Promise<void>;
  requestSystemAudioAccess(): Promise<{ granted: boolean }>;

  onLevel(handler: (event: LevelUpdate) => void): () => void;
  onSegment(handler: (event: SegmentEvent) => void): () => void;
  onTranscriptError(handler: (event: TranscriptErrorEvent) => void): () => void;
  onGenerateChunk(handler: (event: GenerateChunkEvent) => void): () => void;
  onSystemAudioSilent(handler: () => void): () => void;
  onSystemAudioStatus(handler: (status: SystemAudioStatus) => void): () => void;
  onModelProgress(handler: (status: ModelStatus) => void): () => void;
}

export type { NotePreferences };
