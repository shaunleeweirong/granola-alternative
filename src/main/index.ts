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
import { IPC, type ServicesStatus } from "../shared/ipc.ts";
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
  else void mainWindow.loadFile(path.join(dirname, "..", "renderer", "index.html"));

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

function initServices(): void {
  const dbPath = path.join(app.getPath("userData"), "notes.db");
  repo = new NotesRepo(new Database(dbPath));

  whisper = new WhisperClient({ baseUrl: WHISPER_URL });
  llama = new LlamaClient({ baseUrl: LLAMA_URL });

  const modelDir = path.join(app.getPath("userData"), "models");
  const whisperModel = repo.getSetting("whisperModel") ?? "ggml-base.en.bin";
  const llamaModel = repo.getSetting("llamaModel") ?? "";

  whisperService = new LocalService({
    name: "whisper",
    binaryPath: resourcePath("bin", "whisper-server"),
    args: [
      "--host", "127.0.0.1",
      "--port", String(WHISPER_PORT),
      "--model", path.join(modelDir, whisperModel),
      // Leave headroom: the UI and the tap helper share this machine.
      "--threads", String(Math.max(2, Math.floor(availableParallelism() / 2))),
    ],
    healthCheck: () => whisper.isHealthy(),
  });

  llamaService = new LocalService({
    name: "llama",
    binaryPath: llamaModel ? resourcePath("bin", "llama-server") : null,
    args: [
      "--host", "127.0.0.1",
      "--port", String(LLAMA_PORT),
      "--model", path.join(modelDir, llamaModel),
      "--ctx-size", "16384",
    ],
    healthCheck: () => llama.isHealthy(),
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
    };
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
