/**
 * preload。
 *
 * **列挙したチャネルだけ**を橋渡しする。`ipcRenderer` をそのまま公開すると、
 * レンダラから任意のチャネルを叩けてしまい contextIsolation の意味が薄れる。
 */

import { contextBridge, ipcRenderer } from 'electron';
import type { AnalyzeRequestPayload, ComposeRequestPayload, RendererApi } from '@shared/ipc';
import { IpcChannel } from '@shared/ipc';
import type { ProgressUpdate } from '@shared/types';

const api: RendererApi = {
  getSettings: () => ipcRenderer.invoke(IpcChannel.getSettings),
  chooseInputFolder: () => ipcRenderer.invoke(IpcChannel.chooseInputFolder),
  chooseOutputRoot: () => ipcRenderer.invoke(IpcChannel.chooseOutputRoot),
  analyze: (payload: AnalyzeRequestPayload) => ipcRenderer.invoke(IpcChannel.analyze, payload),
  compose: (payload: ComposeRequestPayload) => ipcRenderer.invoke(IpcChannel.compose, payload),
  cancel: () => ipcRenderer.invoke(IpcChannel.cancel),
  openOutputFolder: () => ipcRenderer.invoke(IpcChannel.openOutputFolder),

  onProgress: (listener: (update: ProgressUpdate) => void) => {
    const handler = (_event: unknown, update: ProgressUpdate): void => {
      listener(update);
    };
    ipcRenderer.on(IpcChannel.progress, handler);
    return () => {
      ipcRenderer.off(IpcChannel.progress, handler);
    };
  },
};

contextBridge.exposeInMainWorld('api', api);
