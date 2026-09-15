import type { Channel, TranscriptSegment } from "../core/transcript/types.ts";

/** Channel names for renderer <-> main. Kept in one place so both sides agree. */
export const IPC = {
  recordingStart: "recording:start",
  recordingStop: "recording:stop",
  recordingMicChunk: "recording:mic-chunk",
  recordingLevel: "recording:level",
  transcriptSegment: "transcript:segment",
  transcriptError: "transcript:error",
  audioSystemSilent: "audio:system-silent",
  permissionsSystemAudio: "permissions:system-audio",
  permissionsRequestSystemAudio: "permissions:request-system-audio",
  notesGenerate: "notes:generate",
  notesGenerateChunk: "notes:generate-chunk",
  notesList: "notes:list",
  notesGet: "notes:get",
  notesUpdate: "notes:update",
  notesDelete: "notes:delete",
  notesExport: "notes:export",
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
  /** A verified copy is on disk and transcription can run. */
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
  getDictionary(): Promise<string[]>;
  setDictionary(terms: string[]): Promise<void>;
  getServicesStatus(): Promise<ServicesStatus>;
  getModelStatus(): Promise<ModelStatus>;
  downloadModel(): Promise<ModelStatus>;
  cancelModelDownload(): Promise<void>;
  requestSystemAudioAccess(): Promise<{ granted: boolean }>;

  onLevel(handler: (event: LevelUpdate) => void): () => void;
  onSegment(handler: (event: SegmentEvent) => void): () => void;
  onTranscriptError(handler: (event: TranscriptErrorEvent) => void): () => void;
  onGenerateChunk(handler: (event: GenerateChunkEvent) => void): () => void;
  onSystemAudioSilent(handler: () => void): () => void;
  onModelProgress(handler: (status: ModelStatus) => void): () => void;
}
