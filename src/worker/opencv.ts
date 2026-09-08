/**
 * OpenCV(WASM) の初期化。
 *
 * `@techstark/opencv-js` は WASM を JS へ埋め込んだ単一ファイルとして配布されており、
 * サイドカーの `.wasm` を読み込まない。したがってネットワーク取得も、
 * パッケージング時の追加設定も不要（README §2.2）。
 */

import { createRequire } from 'node:module';
import type { OpenCv } from '@worker/opencvTypes';

export type { OpenCv };

/**
 * **バンドラを通さずに** OpenCV を読み込む。
 *
 * 10.8MB の単一 CJS ファイルを Vite / Vitest の変換パイプラインへ通すと
 * 読み込みが完了しない。Node の `require` へ直接渡すことで、テストでも本番でも
 * 同じ経路（ネイティブの CJS 読み込み）に揃う。electron-vite 側でも
 * `externalizeDepsPlugin` により同様に外部化している。
 */
const requireFromHere = createRequire(import.meta.url);

/** 初期化を待つ上限。これを超えたら異常とみなす。 */
const INIT_TIMEOUT_MS = 30_000;

/** 初期化完了を確認する間隔。 */
const INIT_POLL_INTERVAL_MS = 25;

let readyPromise: Promise<OpenCv> | null = null;

/**
 * OpenCV ランタイムの初期化を待つ。
 *
 * 複数回呼ばれても初期化は 1 度だけ行う（Promise をキャッシュする）。
 */
export function loadOpenCv(): Promise<OpenCv> {
  readyPromise ??= initializeOpenCv();
  return readyPromise;
}

async function initializeOpenCv(): Promise<OpenCv> {
  const cv = requireFromHere('@techstark/opencv-js') as OpenCv & { then?: unknown };

  // Emscripten が生成するモジュールオブジェクトは `then` を持つ **thenable** である。
  // このまま `await` すると、Promise の解決処理が `cv.then(resolve, reject)` を呼び、
  // その resolve が二度と呼ばれずに永久停止する。値として扱う前に必ず取り除く。
  if (typeof cv.then === 'function') {
    delete cv.then;
  }

  const isReady = (): boolean => typeof cv.Mat === 'function';
  if (isReady()) return cv;

  // ランタイム初期化が完了した時点でハンドラが設定されていなければ Emscripten は
  // これを呼ばない。別経路で先に require されていると取りこぼすため、
  // ポーリングと併用してどちらが先でも進めるようにする。
  let callbackFired = false;
  cv.onRuntimeInitialized = () => {
    callbackFired = true;
  };

  const deadline = Date.now() + INIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await delay(INIT_POLL_INTERVAL_MS);
    if (isReady() || callbackFired) return cv;
  }

  throw new Error('OpenCV(WASM) の初期化がタイムアウトしました');
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * `Mat` を確実に解放しながら処理を行う。
 *
 * OpenCV(WASM) の `Mat` は GC 対象にならず、`delete()` を呼ばないと WASM ヒープを
 * 食い潰す。例外経路でも解放されるよう、確保した `Mat` をここで一括管理する。
 */
export function withMats<T>(fn: (track: <M extends { delete: () => void }>(mat: M) => M) => T): T {
  const allocated: { delete: () => void }[] = [];
  const track = <M extends { delete: () => void }>(mat: M): M => {
    allocated.push(mat);
    return mat;
  };

  try {
    return fn(track);
  } finally {
    // 確保と逆順に解放する（依存関係がある場合に安全側へ倒す）。
    for (let i = allocated.length - 1; i >= 0; i -= 1) {
      try {
        allocated[i]!.delete();
      } catch {
        // 二重解放などは無視する。ここで例外を投げると本来のエラーを覆い隠す。
      }
    }
  }
}

/**
 * OpenCV の定数を数値として取り出す。
 *
 * `opencv-js` の型定義は多くの定数を `any` としており、綴り誤りやビルド差で
 * 定数が存在しない場合でも `undefined` が黙って渡ってしまう。ここで検査することで、
 * 「なぜか検出結果がおかしい」ではなく明確な失敗として現れるようにする。
 */
export function cvConstant(value: unknown, name: string): number {
  if (typeof value !== 'number') {
    throw new TypeError(`OpenCV の定数 ${name} が利用できません`);
  }
  return value;
}
