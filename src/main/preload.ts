import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

import { IPC, type RendererApi } from "../shared/ipc.ts";

/**
 * The whole renderer surface. Context isolation is on and nodeIntegration off,
 * so this is the only way the UI can reach the main process.
 */
const subscribe = <T>(channel: string, handler: (payload: T) => void): (() => void) => {
  const listener = (_event: IpcRendererEvent, payload: T): void => handler(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

const api: RendererApi = {
  startRecording: (input) => ipcRenderer.invoke(IPC.recordingStart, input),
  stopRecording: (input) => ipcRenderer.invoke(IPC.recordingStop, input),
  sendMicChunk: (pcm, startSample) => ipcRenderer.send(IPC.recordingMicChunk, pcm, startSample),

  listNotes: (input) => ipcRenderer.invoke(IPC.notesList, input),
  getNote: (input) => ipcRenderer.invoke(IPC.notesGet, input),
  updateNote: (input) => ipcRenderer.invoke(IPC.notesUpdate, input),
  deleteNote: (input) => ipcRenderer.invoke(IPC.notesDelete, input),
  exportNote: (input) => ipcRenderer.invoke(IPC.notesExport, input),
  generateNotes: (input) => ipcRenderer.invoke(IPC.notesGenerate, input),

  getDictionary: () => ipcRenderer.invoke(IPC.dictionaryGet),
  setDictionary: (terms) => ipcRenderer.invoke(IPC.dictionarySet, terms),
  getServicesStatus: () => ipcRenderer.invoke(IPC.servicesStatus),
  getModelStatus: () => ipcRenderer.invoke(IPC.modelStatus),
  downloadModel: () => ipcRenderer.invoke(IPC.modelDownload),
  cancelModelDownload: () => ipcRenderer.invoke(IPC.modelCancel),
  requestSystemAudioAccess: () => ipcRenderer.invoke(IPC.permissionsRequestSystemAudio),

  onLevel: (handler) => subscribe(IPC.recordingLevel, handler),
  onSegment: (handler) => subscribe(IPC.transcriptSegment, handler),
  onTranscriptError: (handler) => subscribe(IPC.transcriptError, handler),
  onGenerateChunk: (handler) => subscribe(IPC.notesGenerateChunk, handler),
  onSystemAudioSilent: (handler) => subscribe(IPC.audioSystemSilent, () => handler()),
  onModelProgress: (handler) => subscribe(IPC.modelProgress, handler),
};

contextBridge.exposeInMainWorld("api", api);
