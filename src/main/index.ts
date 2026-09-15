import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import path from "node:path";
import { existsSync } from "node:fs";
import { availableParallelism } from "node:os";
import { writeFile } from "node:fs/promises";
import Database from "better-sqlite3";

import { NotesRepo } from "../core/db/notesRepo.ts";
import { RecordingController } from "./recordingController.ts";
import { AudioTapHost } from "./audioTapHost.ts";
import { WhisperClient } from "./whisperClient.ts";
import { LlamaClient } from "./llamaClient.ts";
import { LocalService } from "./localService.ts";
import { buildNoteMessages, chunkTranscript, hasNoteMaterial } from "../core/notes/notePrompt.ts";
import { exportNoteToMarkdown, suggestFilename } from "../core/notes/exportMarkdown.ts";
import { resolveModelPath } from "../core/modelPaths.ts";
import { WHISPER_MODEL } from "../core/models/catalog.ts";
import {
  downloadModel,
  isModelInstalled,
  partialBytes,
  type DownloadProgress,
} from "./modelDownloader.ts";
import { IPC, type ModelStatus, type ServicesStatus } from "../shared/ipc.ts";
import type { TranscriptSegment } from "../core/transcript/types.ts";

// The main process is emitted as CommonJS (see tsconfig.main.json), so
// __dirname is available and import.meta is not.
declare const __dirname: string;
const dirname = __dirname;

const WHISPER_PORT = 8178;
const LLAMA_PORT = 8179;
const WHISPER_URL = `http://127.0.0.1:${WHISPER_PORT}`;
const LLAMA_URL = `http://127.0.0.1:${LLAMA_PORT}`;

/** macOS 14.2 is the first release with CoreAudio process taps. */
function systemAudioSupported(): boolean {
  if (process.platform !== "darwin") return false;
  const [major, minor] = process.getSystemVersion().split(".").map(Number);
  return major > 14 || (major === 14 && (minor ?? 0) >= 2);
}

function resourcePath(...parts: string[]): string {
  const base = app.isPackaged ? process.resourcesPath : path.join(dirname, "..", "..", "resources");
  return path.join(base, ...parts);
}

let mainWindow: BrowserWindow | null = null;
let repo: NotesRepo;
let controller: RecordingController;
let whisper: WhisperClient;
let llama: LlamaClient;
let whisperService: LocalService;
let llamaService: LocalService;

/** Set only while a model download is in flight. */
let modelDownload: { controller: AbortController; progress: DownloadProgress } | null = null;
let modelError: string | null = null;
let userModelDir = "";

const send = (channel: string, payload: unknown): void => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
};

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 720,
    minHeight: 520,
    titleBarStyle: "hiddenInset",
    backgroundColor: "#12151a",
    webPreferences: {
      preload: path.join(dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  // Transcript text must never appear in a screen share.
  mainWindow.setContentProtection(true);

  const devServer = process.env.VITE_DEV_SERVER_URL;
  if (devServer) void mainWindow.loadURL(devServer);
  // __dirname is dist/src/main at runtime; vite writes the UI to dist/renderer.
  else void mainWindow.loadFile(path.join(dirname, "..", "..", "renderer", "index.html"));

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

/**
 * The speech engine, pointed at a model. Built by a function rather than
 * inline so it can be replaced once a download finishes, instead of asking the
 * user to quit and reopen the app the first time they ever use it.
 */
function createWhisperService(modelPath: string | null): LocalService {
  return new LocalService({
    name: "whisper",
    // No model means no point spawning the server; the UI explains instead.
    binaryPath: modelPath ? resourcePath("bin", "whisper-server") : null,
    args: [
      "--host", "127.0.0.1",
      "--port", String(WHISPER_PORT),
      "--model", modelPath ?? "",
      // Leave headroom: the UI and the tap helper share this machine.
      "--threads", String(Math.max(2, Math.floor(availableParallelism() / 2))),
    ],
    healthCheck: () => whisper.isHealthy(),
    // Without this the engine's own errors go nowhere, and a failure to launch
    // can only ever surface as "fetch failed".
    onLog: (line) => console.log(`[service] ${line}`),
  });
}

async function currentModelStatus(): Promise<ModelStatus> {
  const installed = await isModelInstalled(userModelDir, WHISPER_MODEL);
  return {
    installed,
    displayName: WHISPER_MODEL.displayName,
    description: WHISPER_MODEL.description,
    approxBytes: WHISPER_MODEL.approxBytes,
    downloading: modelDownload !== null,
    receivedBytes: modelDownload?.progress.receivedBytes ?? 0,
    totalBytes: modelDownload?.progress.totalBytes ?? null,
    resumableBytes: installed ? 0 : await partialBytes(userModelDir, WHISPER_MODEL),
    error: modelError,
  };
}

const pushModelStatus = async (): Promise<void> => send(IPC.modelProgress, await currentModelStatus());

function initServices(): void {
  const dbPath = path.join(app.getPath("userData"), "notes.db");
  repo = new NotesRepo(new Database(dbPath));

  whisper = new WhisperClient({ baseUrl: WHISPER_URL });
  llama = new LlamaClient({ baseUrl: LLAMA_URL });

  // The speech model is downloaded on first launch and lives here. A build may
  // still carry one inside the bundle (a developer build, or a side-loaded
  // copy), and that is searched second.
  userModelDir = path.join(app.getPath("userData"), "models");
  const bundledModelDir = app.isPackaged ? resourcePath("models") : null;
  const findModel = (name: string): string | null =>
    resolveModelPath({ name, userModelDir, bundledModelDir, exists: existsSync, join: path.join })
      ?.path ?? null;

  const whisperModelPath = findModel(repo.getSetting("whisperModel") ?? WHISPER_MODEL.fileName);
  const llamaModelName = repo.getSetting("llamaModel") ?? "";
  const llamaModelPath = llamaModelName ? findModel(llamaModelName) : null;

  whisperService = createWhisperService(whisperModelPath);

  llamaService = new LocalService({
    name: "llama",
    binaryPath: llamaModelPath ? resourcePath("bin", "llama-server") : null,
    args: [
      "--host", "127.0.0.1",
      "--port", String(LLAMA_PORT),
      "--model", llamaModelPath ?? "",
      "--ctx-size", "16384",
    ],
    healthCheck: () => llama.isHealthy(),
    onLog: (line) => console.log(`[service] ${line}`),
  });

  controller = new RecordingController({
    repo,
    whisper,
    audioDir: path.join(app.getPath("temp"), "granola-alternative"),
    language: repo.getSetting("language") ?? "en",
    retainAudio: repo.getSetting("retainAudio") === "true",
    createTapHost: () => {
      if (!systemAudioSupported()) return null;
      const binary = resourcePath("bin", "meeting-audio-tap");
      if (!existsSync(binary)) return null;
      return new AudioTapHost({
        command: binary,
        args: ["--sample-rate", "16000", "--chunk-ms", "100"],
      });
    },
    onSegment: (noteId, segment: TranscriptSegment) =>
      send(IPC.transcriptSegment, {
        sessionId: controller.current?.sessionId ?? "",
        noteId,
        segment,
      }),
    onLevel: (channel, rms) => send(IPC.recordingLevel, { channel, rms }),
    onError: (message, fatal) =>
      send(IPC.transcriptError, { sessionId: controller.current?.sessionId ?? "", message, fatal }),
    onSystemAudioSilent: () => send(IPC.audioSystemSilent, {}),
  });
}

function registerIpc(): void {
  ipcMain.handle(IPC.recordingStart, async (_event, input: { title?: string }) =>
    controller.start(input ?? {})
  );

  ipcMain.handle(IPC.recordingStop, async () => controller.stop());

  ipcMain.on(IPC.recordingMicChunk, (_event, pcm: ArrayBuffer) => {
    controller.pushMicAudio(Buffer.from(pcm));
  });

  ipcMain.handle(
    IPC.notesList,
    async (_event, input: { query?: string; limit?: number; offset?: number } = {}) => {
      if (input.query?.trim()) {
        return repo.search(input.query, { limit: input.limit ?? 30 }).map((hit) => ({
          id: hit.id,
          title: hit.title,
          createdAt: hit.createdAt,
          durationMs: hit.durationMs,
          segmentCount: 0,
          snippet: hit.snippet,
        }));
      }
      return repo.listNotes({ limit: input.limit ?? 50, offset: input.offset ?? 0 }).map((note) => ({
        id: note.id,
        title: note.title,
        createdAt: note.createdAt,
        durationMs: note.durationMs,
        segmentCount: note.segmentCount,
      }));
    }
  );

  ipcMain.handle(IPC.notesGet, async (_event, { noteId }: { noteId: number }) =>
    repo.getNote(noteId)
  );

  ipcMain.handle(
    IPC.notesUpdate,
    async (
      _event,
      input: { noteId: number; title?: string; manualNotes?: string; generatedNotes?: string }
    ) => {
      const { noteId, ...patch } = input;
      repo.updateNote(noteId, patch);
    }
  );

  ipcMain.handle(IPC.notesDelete, async (_event, { noteId }: { noteId: number }) => {
    repo.deleteNote(noteId);
  });

  ipcMain.handle(IPC.notesExport, async (_event, { noteId }: { noteId: number }) => {
    const note = repo.getNote(noteId);
    if (!note || !mainWindow) return null;

    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
      defaultPath: suggestFilename(note.title, note.createdAt),
      filters: [{ name: "Markdown", extensions: ["md"] }],
    });
    if (canceled || !filePath) return null;

    await writeFile(filePath, exportNoteToMarkdown(note), "utf8");
    return { path: filePath };
  });

  ipcMain.handle(IPC.notesGenerate, async (_event, { noteId }: { noteId: number }) => {
    const note = repo.getNote(noteId);
    if (!note) throw new Error("That note no longer exists.");

    if (!hasNoteMaterial({ segments: note.segments, manualNotes: note.manualNotes })) {
      throw new Error("There is no transcript or notes to summarise yet.");
    }
    if (!(await llama.isHealthy())) {
      throw new Error(
        "No local language model is running. Add a model in Settings to generate notes."
      );
    }

    const dictionary = repo.getDictionary();
    // FR-28: summarise in sections when the transcript exceeds the context.
    const sections = chunkTranscript(note.segments, 24_000);
    let generated = "";

    try {
      if (sections.length <= 1) {
        generated = await llama.generate({
          messages: buildNoteMessages({
            title: note.title,
            createdAt: note.createdAt,
            manualNotes: note.manualNotes,
            segments: note.segments,
            dictionary,
          }),
          onDelta: (delta) => send(IPC.notesGenerateChunk, { noteId, delta }),
        });
      } else {
        const partials: string[] = [];
        for (const section of sections) {
          partials.push(
            await llama.generate({
              messages: buildNoteMessages({
                title: note.title,
                createdAt: note.createdAt,
                dictionary,
                transcriptOverride: section,
              }),
            })
          );
        }
        generated = await llama.generate({
          messages: buildNoteMessages({
            title: note.title,
            createdAt: note.createdAt,
            manualNotes: note.manualNotes,
            dictionary,
            transcriptOverride: partials.join("\n\n"),
          }),
          onDelta: (delta) => send(IPC.notesGenerateChunk, { noteId, delta }),
        });
      }

      // FR-27: generation never overwrites the transcript.
      repo.updateNote(noteId, { generatedNotes: generated });
      send(IPC.notesGenerateChunk, { noteId, delta: "", done: true });
    } catch (error) {
      send(IPC.notesGenerateChunk, { noteId, delta: "", error: (error as Error).message });
      throw error;
    }
  });

  ipcMain.handle(IPC.dictionaryGet, async () => repo.getDictionary());
  ipcMain.handle(IPC.dictionarySet, async (_event, terms: string[]) => repo.setDictionary(terms));

  ipcMain.handle(IPC.servicesStatus, async (): Promise<ServicesStatus> => {
    const [transcriptionReady, languageModelReady] = await Promise.all([
      whisper.isHealthy(),
      llama.isHealthy(),
    ]);
    return {
      transcriptionReady,
      languageModelReady,
      systemAudioSupported: systemAudioSupported(),
      systemAudioGranted: existsSync(resourcePath("bin", "meeting-audio-tap")),
      transcriptionReason: transcriptionReady
        ? null
        : whisperService?.isAvailable === false && !(await isModelInstalled(userModelDir, WHISPER_MODEL))
          ? "The speech model has not been downloaded yet."
          : whisperService?.reason ?? null,
      transcriptionStarting: !transcriptionReady && whisperService?.status === "starting",
      transcriptionLog: transcriptionReady ? [] : whisperService?.log ?? [],
    };
  });

  ipcMain.handle(IPC.modelStatus, async (): Promise<ModelStatus> => currentModelStatus());

  ipcMain.handle(IPC.modelCancel, async () => {
    modelDownload?.controller.abort();
  });

  ipcMain.handle(IPC.modelDownload, async (): Promise<ModelStatus> => {
    // Two windows, or an impatient double-click, must not start two transfers
    // into the same file.
    if (modelDownload) return currentModelStatus();
    if (await isModelInstalled(userModelDir, WHISPER_MODEL)) return currentModelStatus();

    const controller = new AbortController();
    modelDownload = { controller, progress: { receivedBytes: 0, totalBytes: null } };
    modelError = null;
    void pushModelStatus();

    try {
      const modelPath = await downloadModel({
        spec: WHISPER_MODEL,
        destDir: userModelDir,
        signal: controller.signal,
        onProgress: (progress) => {
          if (modelDownload) modelDownload.progress = progress;
          void pushModelStatus();
        },
      });

      repo.setSetting("whisperModel", WHISPER_MODEL.fileName);
      modelDownload = null;

      // Start transcribing now rather than after a restart: this is the first
      // thing a new user does, and "quit and reopen" is a poor welcome.
      await whisperService.stop();
      whisperService = createWhisperService(modelPath);
      void whisperService.start();
    } catch (error) {
      modelDownload = null;
      // Cancelling is a choice, not a fault. Reporting it in red alongside
      // genuine failures teaches people to ignore the red.
      modelError = controller.signal.aborted ? null : (error as Error).message;
    }

    const status = await currentModelStatus();
    send(IPC.modelProgress, status);
    return status;
  });

  ipcMain.handle(IPC.permissionsRequestSystemAudio, async () => {
    // The OS prompt is raised by the helper itself on first capture; a short
    // probe run is enough to trigger it.
    const binary = resourcePath("bin", "meeting-audio-tap");
    if (!systemAudioSupported() || !existsSync(binary)) return { granted: false };

    const probe = new AudioTapHost({ command: binary, args: ["--sample-rate", "16000"] });
    try {
      await probe.start({ onChunk: () => {} });
      await probe.stop();
      return { granted: true };
    } catch {
      return { granted: false };
    }
  });
}

void app.whenReady().then(async () => {
  initServices();
  registerIpc();
  createWindow();

  // Servers boot in the background; the UI polls status and explains what is
  // missing rather than blocking the window on them.
  void whisperService.start();
  void llamaService.start();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", async () => {
  await Promise.all([whisperService?.stop(), llamaService?.stop()]);
});
