/**
 * Electron main プロセスの入口。
 *
 * 責務: ウィンドウ管理、フォルダ選択ダイアログ、設定の永続化、ジョブ統括、
 * 一時ディレクトリの生涯管理。**画像処理そのものは行わない**（worker の担当）。
 */

import path from 'node:path';
import { cpus } from 'node:os';
import { fileURLToPath } from 'node:url';
import { BrowserWindow, app, dialog, ipcMain, shell } from 'electron';
import type { AnalyzeResponse, ComposeRequestPayload, ComposeResponse } from '@shared/ipc';
import { IpcChannel } from '@shared/ipc';
import type { AppSettings, ProgressUpdate } from '@shared/types';
import { createFileLogger } from '@core/logging/logger';
import { ensureOutputDirectory } from '@worker/output';
import { type AnalyzedState, buildComposeItems, runAnalysis } from '@main/job';
import { loadSettings, saveSettings } from '@main/settings';
import { cleanupOwnedTempDirectories, sweepStaleTempDirectories } from '@main/tempDirectory';
import { ImageWorkerPool, resolveWorkerPath } from '@main/workerPool';

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));

let mainWindow: BrowserWindow | null = null;
let pool: ImageWorkerPool | null = null;
let settings: AppSettings = { outputRoot: null, lastInputFolder: null };
let analyzedState: AnalyzedState | null = null;
let jobController: AbortController | null = null;

const logger = createFileLogger(path.join(app.getPath('userData'), 'logs'), 'app.jsonl');

function sendProgress(update: ProgressUpdate): void {
  mainWindow?.webContents.send(IpcChannel.progress, update);
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    show: false,
    title: 'スキャン身分証 A4 統合',
    webPreferences: {
      preload: path.join(currentDirectory, '../preload/index.cjs'),
      // 仕様書 §9: レンダラから OS / ネットワークへ直接触れさせない。
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow?.show());

  // 外部サイトへの遷移・新規ウィンドウを禁止する（ローカル完結の担保）。
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event) => {
    event.preventDefault();
  });

  const devServerUrl = process.env.ELECTRON_RENDERER_URL;
  if (devServerUrl !== undefined && devServerUrl !== '') {
    void mainWindow.loadURL(devServerUrl);
  } else {
    void mainWindow.loadFile(path.join(currentDirectory, '../../dist/index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function registerIpcHandlers(): void {
  ipcMain.handle(IpcChannel.getSettings, () => settings);

  ipcMain.handle(IpcChannel.chooseInputFolder, async () => {
    const result = await dialog.showOpenDialog({
      title: '入力フォルダを選択',
      properties: ['openDirectory'],
      ...(settings.lastInputFolder === null ? {} : { defaultPath: settings.lastInputFolder }),
    });
    const chosen = result.canceled ? null : (result.filePaths[0] ?? null);
    if (chosen !== null) {
      settings = { ...settings, lastInputFolder: chosen };
      await saveSettings(app.getPath('userData'), settings);
    }
    return chosen;
  });

  ipcMain.handle(IpcChannel.chooseOutputRoot, async () => {
    const result = await dialog.showOpenDialog({
      title: '出力ルートを選択',
      properties: ['openDirectory', 'createDirectory'],
      ...(settings.outputRoot === null ? {} : { defaultPath: settings.outputRoot }),
    });
    const chosen = result.canceled ? null : (result.filePaths[0] ?? null);
    if (chosen !== null) {
      settings = { ...settings, outputRoot: chosen };
      await saveSettings(app.getPath('userData'), settings);
    }
    return chosen;
  });

  ipcMain.handle(
    IpcChannel.analyze,
    async (_event, payload: { inputFolder: string }): Promise<AnalyzeResponse> => {
      if (settings.outputRoot === null) return { ok: false, reason: 'noOutputRoot' };
      if (pool === null) return { ok: false, reason: 'unreadable' };

      jobController = new AbortController();
      analyzedState = null;

      const outcome = await runAnalysis(payload.inputFolder, settings.outputRoot, {
        pool,
        logger,
        onProgress: sendProgress,
        signal: jobController.signal,
      });

      await logger.flush();

      if (!outcome.ok) return { ok: false, reason: outcome.reason };

      analyzedState = outcome.state;
      const images = outcome.state.order
        .map((relativePath) => outcome.state.results.get(relativePath)?.image)
        .filter((image): image is NonNullable<typeof image> => image !== undefined);

      return { ok: true, images, skippedCount: outcome.skippedCount };
    },
  );

  ipcMain.handle(
    IpcChannel.compose,
    async (_event, payload: ComposeRequestPayload): Promise<ComposeResponse> => {
      if (analyzedState === null)
        return { ok: false, reason: 'failed', message: '解析結果がありません' };
      if (settings.outputRoot === null) return { ok: false, reason: 'noOutputRoot' };
      if (pool === null)
        return { ok: false, reason: 'failed', message: 'ワーカーが利用できません' };

      const state = analyzedState;
      const items = buildComposeItems(state, payload.kinds);

      try {
        const directory = await ensureOutputDirectory(settings.outputRoot);
        sendProgress({ phase: 'composing', completed: 0, total: 0, currentRelativePath: null });

        const outcome = await pool.compose(
          { items, outputDirectory: directory },
          (fileName, index, count) => {
            sendProgress({
              phase: 'composing',
              completed: index,
              total: count,
              currentRelativePath: fileName,
            });
          },
        );

        logger.log({
          level: 'info',
          relativePath: null,
          code: 'composeFinished',
          detail: { pageCount: outcome.fileNames.length, excludedCount: outcome.excluded.length },
        });
        for (const entry of outcome.excluded) {
          logger.log({
            level: 'warn',
            relativePath: entry.relativePath,
            code: `excluded:${entry.reason}`,
          });
        }
        await logger.flush();

        sendProgress({
          phase: 'done',
          completed: outcome.fileNames.length,
          total: outcome.fileNames.length,
          currentRelativePath: null,
        });

        return {
          ok: true,
          result: {
            pageCount: outcome.fileNames.length,
            fileNames: outcome.fileNames,
            outputDirectory: directory,
            excluded: outcome.excluded,
            pageThumbnails: outcome.pageThumbnails,
          },
        };
      } catch (error) {
        logger.log({ level: 'error', relativePath: null, code: 'composeFailed' });
        await logger.flush();
        return {
          ok: false,
          reason: 'failed',
          message: error instanceof Error ? error.message : String(error),
        };
      } finally {
        // 成功・失敗のいずれでも一時ディレクトリを片付ける（仕様書 §9）。
        await cleanupOwnedTempDirectories();
      }
    },
  );

  ipcMain.handle(IpcChannel.cancel, async () => {
    jobController?.abort();
    analyzedState = null;
    // 中止時も一時ファイルを残さない。
    await cleanupOwnedTempDirectories();
    logger.log({ level: 'info', relativePath: null, code: 'jobCancelled' });
    await logger.flush();
  });

  ipcMain.handle(IpcChannel.openOutputFolder, async () => {
    if (settings.outputRoot === null) return;
    const directory = await ensureOutputDirectory(settings.outputRoot);
    await shell.openPath(directory);
  });
}

void app.whenReady().then(async () => {
  settings = await loadSettings(app.getPath('userData'));
  // 異常終了で残った自作の一時ディレクトリを回収する。
  await sweepStaleTempDirectories(app.getPath('temp'));

  pool = new ImageWorkerPool(resolveWorkerPath(currentDirectory), cpus().length);

  registerIpcHandlers();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  // 終了時にも一時ファイルを残さない（仕様書 §9）。
  void cleanupOwnedTempDirectories();
  void pool?.dispose();
  void logger.flush();
});

process.on('exit', () => {
  void cleanupOwnedTempDirectories();
});
