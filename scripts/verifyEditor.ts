/** 合成画像だけで、ビルド済みの画面・preload・workerの編集操作を確認する。 */
import { app, BrowserWindow, ipcMain } from 'electron';
import { Worker } from 'node:worker_threads';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { IpcChannel } from '../src/shared/ipc';
import type { AdjustRequestPayload, EditorRequestPayload } from '../src/shared/ipc';
import type {
  AnalyzeTaskResult,
  ComposeTaskResult,
  EditTaskResult,
  WorkerRequest,
  WorkerResponse,
} from '../src/shared/workerProtocol';
import { buildComposeItems } from '../src/main/job';
import { quadCenter } from '../src/core/geometry/quad';
import { syntheticScan } from '../tests/fixtures/synthetic';

const scratch = path.resolve('.tmp/editor-check');
app.setPath('userData', path.join(scratch, 'profile'));
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');
let worker: Worker | null = null;
let window: BrowserWindow | null = null;
let nextId = 1;
const pending = new Map<
  number,
  { resolve: (value: unknown) => void; reject: (error: Error) => void }
>();

function request<T>(message: WorkerRequest): Promise<T> {
  return new Promise((resolve, reject) => {
    pending.set(message.taskId, { resolve: (value) => resolve(value as T), reject });
    worker!.postMessage(message);
  });
}
function evaluate<T>(expression: string): Promise<T> {
  return window!.webContents.executeJavaScript(expression) as Promise<T>;
}
async function until(expression: string): Promise<void> {
  for (let i = 0; i < 240; i += 1) {
    if (await evaluate<boolean>(expression)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`画面の待機が時間内に完了しませんでした: ${expression}`);
}
async function click(text: string): Promise<void> {
  await window!.webContents.executeJavaScript(
    `[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(text)}).click()`,
  );
}
async function centers(): Promise<number[]> {
  return evaluate<number[]>(
    `[...document.querySelectorAll('.editor input[type=number]')].map(i=>Number(i.value))`,
  );
}
async function setCenter(x: number, y: number): Promise<void> {
  await window!.webContents.executeJavaScript(
    `(() => { const inputs=document.querySelectorAll('.editor input[type=number]'); const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set; [${x},${y}].forEach((v,i)=>{setter.call(inputs[i],String(v));inputs[i].dispatchEvent(new Event('input',{bubbles:true}));}); })()`,
  );
  await until(`document.querySelector('.editor input[type=number]').value==='${x}'`);
}

void app
  .whenReady()
  .then(async () => {
    await mkdir(scratch, { recursive: true });
    const input = path.join(scratch, 'input');
    const output = path.join(scratch, 'output');
    await mkdir(input, { recursive: true });
    await mkdir(output, { recursive: true });
    const filePath = path.join(input, 'synthetic.png');
    const bytes = await syntheticScan({
      canvasWidth: 2400,
      canvasHeight: 1800,
      cardWidth: 1011,
      cardHeight: 638,
      centerX: 700,
      centerY: 500,
      cardColor: '#205090',
      withInnerPattern: false,
      density: 300,
    });
    await writeFile(filePath, bytes);
    worker = new Worker(path.resolve('dist-electron/main/worker.js'));
    worker.on('message', (message: WorkerResponse) => {
      if (message.kind === 'ready' || message.kind === 'pageWritten') return;
      const waiter = pending.get(message.taskId);
      if (!waiter) return;
      pending.delete(message.taskId);
      if (message.kind === 'failed') waiter.reject(new Error(message.message));
      else waiter.resolve(message.result);
    });
    worker.on('error', (error) => {
      for (const waiter of pending.values()) waiter.reject(error);
      pending.clear();
    });
    let analysis: AnalyzeTaskResult;
    ipcMain.handle(IpcChannel.getSettings, () => ({ outputRoot: output, lastInputFolder: input }));
    ipcMain.handle(IpcChannel.analyze, async () => {
      analysis = await request<AnalyzeTaskResult>({
        kind: 'analyze',
        taskId: nextId++,
        task: { id: 'synthetic.png', relativePath: 'synthetic.png', filePath },
      });
      // 自動検出が印刷部分へずれた場合の状態を模し、編集の導線を確認する。
      analysis = {
        ...analysis,
        quad: {
          topLeft: { x: 1450, y: 1150 },
          topRight: { x: 1850, y: 1150 },
          bottomRight: { x: 1850, y: 1450 },
          bottomLeft: { x: 1450, y: 1450 },
        },
        image: {
          ...analysis.image,
          status: 'needsReview',
          warnings: ['lowConfidence', 'nonStandardSize'],
          cardSizeMm: { widthMm: 28.2, heightMm: 40.2 },
        },
      };
      return { ok: true, images: [analysis.image], skippedCount: 0 };
    });
    ipcMain.handle(IpcChannel.loadEditor, async (_event, payload: EditorRequestPayload) => {
      const result = await request<EditTaskResult>({
        kind: 'edit',
        taskId: nextId++,
        task: { filePath, analysis, kind: payload.kind, adjustment: null },
      });
      return { ok: true, preview: result.preview };
    });
    ipcMain.handle(IpcChannel.adjust, async (_event, payload: AdjustRequestPayload) => {
      const result = await request<EditTaskResult>({
        kind: 'edit',
        taskId: nextId++,
        task: { filePath, analysis, kind: payload.kind, adjustment: payload.adjustment },
      });
      assert(result.updated);
      analysis = result.updated;
      return { ok: true, image: analysis.image };
    });
    ipcMain.handle(IpcChannel.compose, async () => {
      const items = buildComposeItems(
        {
          inputFolder: input,
          outputDirectory: output,
          order: ['synthetic.png'],
          results: new Map([['synthetic.png', analysis]]),
        },
        {},
      );
      const result = await request<ComposeTaskResult>({
        kind: 'compose',
        taskId: nextId++,
        task: { items, outputDirectory: output },
      });
      return {
        ok: true,
        result: { ...result, pageCount: result.fileNames.length, outputDirectory: output },
      };
    });
    window = new BrowserWindow({
      show: false,
      width: 1180,
      height: 820,
      webPreferences: {
        preload: path.resolve('dist-electron/preload/index.cjs'),
        contextIsolation: true,
        sandbox: true,
        offscreen: true,
        backgroundThrottling: false,
        partition: 'editor-check',
      },
    });
    await window.loadFile(path.resolve('dist/index.html'));
    await until(
      `[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='解析を開始'&&!b.disabled)`,
    );
    await click('解析を開始');
    await until(
      `document.querySelector('.review__reasons')?.textContent.includes('サムネイルを押して')`,
    );
    async function open(): Promise<void> {
      await window!.webContents.executeJavaScript(
        `document.querySelector('.review__edit-button').click()`,
      );
      await until(
        `document.querySelector('.editor__canvas image')?.href.baseVal.startsWith('blob:')`,
      );
      await window!.webContents.executeJavaScript(
        `new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`,
      );
    }
    await open();
    await click('2倍');
    await until(`document.querySelector('.editor__canvas').width.baseVal.value>1000`);
    await click('4倍');
    await until(
      `document.querySelector('.editor__viewport').scrollWidth>document.querySelector('.editor__viewport').clientWidth`,
    );
    await click('1倍');
    window.setSize(900, 600);
    await until(
      `(() => { const r=document.querySelector('.editor').getBoundingClientRect(); return r.right<=innerWidth&&r.bottom<=innerHeight; })()`,
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    await writeFile(
      path.join(scratch, 'editor-small.png'),
      (await window.webContents.capturePage()).toPNG(),
    );
    window.setSize(1180, 820);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const rect = await evaluate<{
      x: number;
      y: number;
      width: number;
      height: number;
    }>(
      `(() => {const r=document.querySelector('.editor__canvas').getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};})()`,
    );
    const x = Math.round(rect.x + (700 / 2400) * rect.width);
    const y = Math.round(rect.y + (500 / 1800) * rect.height);
    window.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
    window.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
    await until(
      `Math.abs(Number(document.querySelector('.editor input[type=number]').value)-700)<8`,
    );
    await until(`!document.querySelector('.editor__canvas').hasPointerCapture(1)`);
    const beforeDrag = await centers();
    window.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
    await until(`document.querySelector('.editor__canvas').hasPointerCapture(1)`);
    window.webContents.sendInputEvent({
      type: 'mouseMove',
      x: x + 12,
      y: y + 8,
      modifiers: ['leftbuttondown'],
    });
    await until(
      `Number(document.querySelector('.editor input[type=number]').value)>${beforeDrag[0]! + 20}`,
    );
    window.webContents.sendInputEvent({
      type: 'mouseUp',
      x: x + 12,
      y: y + 8,
      button: 'left',
      clickCount: 1,
    });
    await until(
      `Number(document.querySelector('.editor input[type=number]').value)>${beforeDrag[0]! + 20}`,
    );
    const afterDrag = await centers();
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Right', modifiers: ['shift'] });
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Right', modifiers: ['shift'] });
    await until(
      `Number(document.querySelector('.editor input[type=number]').value)>=${afterDrag[0]! + 9}`,
    );
    await new Promise((resolve) => setTimeout(resolve, 250));
    await writeFile(
      path.join(scratch, 'editor.png'),
      (await window.webContents.capturePage()).toPNG(),
    );
    await click('変更を破棄');
    assert.equal(quadCenter(analysis!.quad!).x, 1650);
    await open();
    await setCenter(1, 1);
    await until(
      `[...document.querySelectorAll('.editor button')].find(b=>b.textContent==='調整を反映').disabled`,
    );
    await setCenter(700, 500);
    await click('水平に戻す');
    await click('調整を反映');
    await until(
      `!document.querySelector('.editor')&&document.querySelector('.review__reasons')?.textContent.includes('手動で調整済み')`,
    );
    assert(Math.abs(quadCenter(analysis!.quad!).x - 700) < 0.001);
    assert(Math.abs(quadCenter(analysis!.quad!).y - 500) < 0.001);
    assert.deepEqual(analysis!.image.cardSizeMm, { widthMm: 85.6, heightMm: 53.98 });
    await open();
    assert.deepEqual(await centers(), [700, 500]);
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
    await until(`!document.querySelector('.editor')`);
    await click('出力開始');
    await until(`document.querySelector('.result__page')!==null`);
    assert.deepEqual(await readFile(filePath), bytes);
    console.log(
      '編集画面の検証成功：案内・サムネイル起動・クリック移動・ドラッグ・矢印キー・破棄・画像外指定の拒否・保存・再表示・A4出力・入力不変',
    );
    await worker.terminate();
    window.destroy();
    app.quit();
  })
  .catch(async (error) => {
    console.error(error);
    await worker?.terminate();
    window?.destroy();
    app.exit(1);
  });
