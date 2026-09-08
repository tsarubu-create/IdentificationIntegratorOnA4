/**
 * 画像処理ワーカーの入口（worker_threads）。
 *
 * sharp と OpenCV(WASM) をここへ閉じ込めることで、UI スレッドは
 * 100 Mpx 級の処理中もフリーズしない（README §1.2）。
 */

import { parentPort } from 'node:worker_threads';
import type { WorkerRequest, WorkerResponse } from '@shared/workerProtocol';
import { analyzeImage } from '@worker/analyze';
import { composePages } from '@worker/compose';
import { readHeader } from '@worker/imageIo';
import { loadOpenCv } from '@worker/opencv';

const port = parentPort;
if (port === null) {
  throw new Error('imageWorker は worker_threads から起動してください');
}

function reply(message: WorkerResponse): void {
  port!.postMessage(message);
}

port.on('message', (request: WorkerRequest) => {
  void handle(request).catch((error: unknown) => {
    reply({
      kind: 'failed',
      taskId: request.taskId,
      message: error instanceof Error ? error.message : String(error),
    });
  });
});

async function handle(request: WorkerRequest): Promise<void> {
  if (request.kind === 'analyze') {
    const analysis = await analyzeImage(request.task);
    // 出力時に外接矩形を画像内へ収めるため、元画像の寸法も返す。
    const header = await safeHeader(request.task.filePath);

    reply({
      kind: 'analyzed',
      taskId: request.taskId,
      result: {
        image: analysis.image,
        quad: analysis.quad,
        ignoreIcc: analysis.ignoreIcc,
        sourceWidth: header.width,
        sourceHeight: header.height,
      },
    });
    return;
  }

  const outcome = await composePages(request.task.items, {
    outputDirectory: request.task.outputDirectory,
    onPageWritten: (fileName, pageIndex, pageCount) => {
      reply({ kind: 'pageWritten', taskId: request.taskId, fileName, pageIndex, pageCount });
    },
  });

  reply({ kind: 'composed', taskId: request.taskId, result: outcome });
}

/** ヘッダ取得に失敗しても解析結果を返せるよう、0 で代替する。 */
async function safeHeader(filePath: string): Promise<{ width: number; height: number }> {
  try {
    const header = await readHeader(filePath);
    return { width: header.width, height: header.height };
  } catch {
    return { width: 0, height: 0 };
  }
}

// OpenCV の初期化を先に済ませ、最初の 1 枚だけ遅くなるのを避ける。
void loadOpenCv().then(
  () => {
    reply({ kind: 'ready' });
  },
  () => {
    // 初期化に失敗しても、個々のタスクでエラーとして報告される。
    reply({ kind: 'ready' });
  },
);
