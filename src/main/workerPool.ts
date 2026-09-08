/**
 * 画像処理ワーカーのプール（README §4.2）。
 *
 * 並列数だけでなく「処理中の総画素数」でも制限する。巨大画像が同時に走ると
 * 並列数が小さくてもメモリが破綻するため、画素予算のほうが実態に即している。
 */

import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { MAX_INFLIGHT_PX, MAX_TOTAL_PX, resolveConcurrency } from '@shared/limits';
import type {
  AnalyzeTask,
  AnalyzeTaskResult,
  ComposeTask,
  ComposeTaskResult,
  WorkerRequest,
  WorkerResponse,
} from '@shared/workerProtocol';

/** 1 件のタスクの待ち行列エントリ。 */
interface PendingTask {
  readonly request: (taskId: number) => WorkerRequest;
  /** このタスクが占有する画素数の見積り */
  readonly pixelCost: number;
  readonly resolve: (value: never) => void;
  readonly reject: (reason: Error) => void;
  readonly onPageWritten?: (fileName: string, pageIndex: number, pageCount: number) => void;
}

/** 起動中のワーカー 1 つぶん。 */
interface PoolWorker {
  readonly worker: Worker;
  busy: boolean;
}

/** 画像処理ワーカーのプール。 */
export class ImageWorkerPool {
  private readonly workers: PoolWorker[] = [];
  private readonly queue: PendingTask[] = [];
  private readonly inFlight = new Map<
    number,
    { task: PendingTask; workerIndex: number; pixelCost: number }
  >();
  private inFlightPixels = 0;
  private nextTaskId = 1;
  private disposed = false;

  /**
   * @param workerPath ビルド済みワーカーの絶対パス
   * @param cpuCount 論理 CPU 数
   */
  constructor(
    private readonly workerPath: string,
    cpuCount: number,
  ) {
    const size = resolveConcurrency(cpuCount);
    for (let i = 0; i < size; i += 1) this.spawnWorker(i);
  }

  /** プールの並列数。 */
  get size(): number {
    return this.workers.length;
  }

  /** 画像 1 枚を解析する。 */
  analyze(task: AnalyzeTask, pixelCost: number): Promise<AnalyzeTaskResult> {
    return this.enqueue<AnalyzeTaskResult>(
      (taskId) => ({ kind: 'analyze', taskId, task }),
      pixelCost,
    );
  }

  /**
   * ページを生成して書き出す。
   *
   * 出力は連番の採番を伴うため、**常に 1 タスクとして直列に実行する**。
   * 並列化すると採番が競合し、排他作成のリトライが増えるだけで利得がない。
   */
  compose(
    task: ComposeTask,
    onPageWritten?: (fileName: string, pageIndex: number, pageCount: number) => void,
  ): Promise<ComposeTaskResult> {
    return this.enqueue<ComposeTaskResult>(
      (taskId) => ({ kind: 'compose', taskId, task }),
      MAX_TOTAL_PX,
      onPageWritten,
    );
  }

  /** すべてのワーカーを停止する。 */
  async dispose(): Promise<void> {
    this.disposed = true;
    for (const pending of this.queue) {
      pending.reject(new Error('ワーカープールは停止しました'));
    }
    this.queue.length = 0;

    for (const entry of this.inFlight.values()) {
      entry.task.reject(new Error('ワーカープールは停止しました'));
    }
    this.inFlight.clear();

    await Promise.all(this.workers.map((w) => w.worker.terminate()));
    this.workers.length = 0;
  }

  private enqueue<T>(
    request: (taskId: number) => WorkerRequest,
    pixelCost: number,
    onPageWritten?: (fileName: string, pageIndex: number, pageCount: number) => void,
  ): Promise<T> {
    if (this.disposed) return Promise.reject(new Error('ワーカープールは停止しています'));

    return new Promise<T>((resolve, reject) => {
      this.queue.push({
        request,
        // 1 タスクが予算を超えていても永久に待たないよう、上限で頭打ちにする。
        pixelCost: Math.min(pixelCost, MAX_INFLIGHT_PX),
        resolve,
        reject,
        ...(onPageWritten === undefined ? {} : { onPageWritten }),
      });
      this.pump();
    });
  }

  /** 空きワーカーと画素予算がある限り、待ち行列からタスクを流す。 */
  private pump(): void {
    while (this.queue.length > 0) {
      const next = this.queue[0]!;

      // 何も走っていないときは、予算を超えるタスクでも 1 件だけは通す
      // （そうしないと巨大画像 1 枚で永久に止まる）。
      const budgetAllows =
        this.inFlightPixels === 0 || this.inFlightPixels + next.pixelCost <= MAX_INFLIGHT_PX;
      if (!budgetAllows) return;

      const workerIndex = this.workers.findIndex((w) => !w.busy);
      if (workerIndex < 0) return;

      this.queue.shift();
      this.dispatch(next, workerIndex);
    }
  }

  private dispatch(task: PendingTask, workerIndex: number): void {
    const poolWorker = this.workers[workerIndex]!;
    const taskId = this.nextTaskId++;

    poolWorker.busy = true;
    this.inFlightPixels += task.pixelCost;
    this.inFlight.set(taskId, { task, workerIndex, pixelCost: task.pixelCost });

    poolWorker.worker.postMessage(task.request(taskId));
  }

  private settle(taskId: number, apply: (task: PendingTask) => void): void {
    const entry = this.inFlight.get(taskId);
    if (entry === undefined) return;

    this.inFlight.delete(taskId);
    this.inFlightPixels -= entry.pixelCost;
    const poolWorker = this.workers[entry.workerIndex];
    if (poolWorker !== undefined) poolWorker.busy = false;

    apply(entry.task);
    this.pump();
  }

  private spawnWorker(index: number): void {
    const worker = new Worker(this.workerPath);
    const poolWorker: PoolWorker = { worker, busy: false };
    this.workers[index] = poolWorker;

    worker.on('message', (message: WorkerResponse) => {
      switch (message.kind) {
        case 'ready':
          break;
        case 'analyzed':
          this.settle(message.taskId, (task) => {
            task.resolve(message.result as never);
          });
          break;
        case 'composed':
          this.settle(message.taskId, (task) => {
            task.resolve(message.result as never);
          });
          break;
        case 'pageWritten': {
          const entry = this.inFlight.get(message.taskId);
          entry?.task.onPageWritten?.(message.fileName, message.pageIndex, message.pageCount);
          break;
        }
        case 'failed':
          this.settle(message.taskId, (task) => {
            task.reject(new Error(message.message));
          });
          break;
      }
    });

    worker.on('error', (error) => {
      // このワーカーで実行中のタスクだけを失敗させ、プール全体は生かす。
      for (const [taskId, entry] of [...this.inFlight.entries()]) {
        if (entry.workerIndex === index) {
          this.settle(taskId, (task) => {
            task.reject(error);
          });
        }
      }
      if (!this.disposed) this.spawnWorker(index);
    });

    worker.on('exit', () => {
      if (this.disposed) return;
      // 予期しない終了。実行中タスクを失敗させて再起動する。
      for (const [taskId, entry] of [...this.inFlight.entries()]) {
        if (entry.workerIndex === index) {
          this.settle(taskId, (task) => {
            task.reject(new Error('画像処理ワーカーが予期せず終了しました'));
          });
        }
      }
      this.spawnWorker(index);
    });
  }
}

/** ビルド済みワーカーの絶対パスを求める。 */
export function resolveWorkerPath(mainDirectory: string): string {
  return path.join(mainDirectory, 'worker.js');
}
