/**
 * ジョブ統括（仕様書 §3 / §8）。
 *
 * 走査 -> 解析 -> （確認画面）-> 出力 の流れを管理する。
 * 確認画面での「中止」は出力を一切作らずに終わる。
 */

import path from 'node:path';
import { MAX_TOTAL_PX } from '@shared/limits';
import type { AnalyzedImage, DocumentKind, ProgressUpdate } from '@shared/types';
import type { AnalyzeTaskResult, ComposeTaskItem } from '@shared/workerProtocol';
import type { Logger } from '@core/logging/logger';
import { scanImages } from '@core/scan/scanner';
import { sortNatural } from '@core/scan/naturalSort';
import { OUTPUT_DIRECTORY_NAME } from '@worker/output';
import type { ImageWorkerPool } from '@main/workerPool';

/** 解析済みの状態（確認画面で利用者の操作を待っている間、main が保持する）。 */
export interface AnalyzedState {
  readonly inputFolder: string;
  readonly outputDirectory: string;
  readonly results: ReadonlyMap<string, AnalyzeTaskResult>;
  readonly order: readonly string[];
}

/** 走査と解析の結果。 */
export type AnalyzeOutcome =
  | { readonly ok: true; readonly state: AnalyzedState; readonly skippedCount: number }
  | { readonly ok: false; readonly reason: 'noImages' | 'unreadable' };

/** 解析フェーズの依存。 */
export interface AnalyzeDeps {
  readonly pool: ImageWorkerPool;
  readonly logger: Logger;
  readonly onProgress: (update: ProgressUpdate) => void;
  readonly signal?: AbortSignal;
}

/**
 * 入力フォルダを走査し、各画像を解析する。
 *
 * 出力ディレクトリ配下は必ず走査対象から外す（仕様書 §4）。
 */
export async function runAnalysis(
  inputFolder: string,
  outputRoot: string,
  deps: AnalyzeDeps,
): Promise<AnalyzeOutcome> {
  const outputDirectory = path.join(outputRoot, OUTPUT_DIRECTORY_NAME);

  deps.onProgress({ phase: 'scanning', completed: 0, total: 0, currentRelativePath: null });

  let scan;
  try {
    scan = await scanImages({
      inputRoot: inputFolder,
      excludedDirectories: [outputDirectory],
      ...(deps.signal === undefined ? {} : { signal: deps.signal }),
    });
  } catch {
    deps.logger.log({ level: 'error', relativePath: null, code: 'scanFailed' });
    return { ok: false, reason: 'unreadable' };
  }

  if (scan.files.length === 0) {
    deps.logger.log({ level: 'warn', relativePath: null, code: 'noImagesFound' });
    return { ok: false, reason: 'noImages' };
  }

  const order = sortNatural(scan.files);
  deps.logger.log({
    level: 'info',
    relativePath: null,
    code: 'analysisStarted',
    detail: { imageCount: order.length, skippedCount: scan.skippedCount },
  });

  const results = new Map<string, AnalyzeTaskResult>();
  let completed = 0;

  deps.onProgress({
    phase: 'analyzing',
    completed: 0,
    total: order.length,
    currentRelativePath: null,
  });

  // 画素数が事前に分からないため、予算は上限値で見積もる。
  // 実測のために全ファイルのヘッダを先読みするほうが正確だが、
  // 走査直後に I/O を二重に行うコストのほうが大きい。
  const tasks = order.map(async (relativePath) => {
    deps.signal?.throwIfAborted();
    const filePath = path.join(inputFolder, relativePath);

    try {
      const result = await deps.pool.analyze(
        { id: relativePath, filePath, relativePath },
        MAX_TOTAL_PX / Math.max(1, deps.pool.size),
      );
      results.set(relativePath, result);
      logAnalysis(deps.logger, result.image);
    } catch {
      deps.logger.log({ level: 'error', relativePath, code: 'analysisFailed' });
    } finally {
      completed += 1;
      deps.onProgress({
        phase: 'analyzing',
        completed,
        total: order.length,
        currentRelativePath: relativePath,
      });
    }
  });

  await Promise.all(tasks);

  return {
    ok: true,
    state: { inputFolder, outputDirectory, results, order },
    skippedCount: scan.skippedCount,
  };
}

/**
 * 確認画面の選択を反映して、出力対象の一覧を組み立てる。
 *
 * 除外理由が付いているもの、検出できなかったものは対象から外す。
 */
export function buildComposeItems(
  state: AnalyzedState,
  kinds: Readonly<Record<string, DocumentKind>>,
): ComposeTaskItem[] {
  const items: ComposeTaskItem[] = [];

  for (const relativePath of state.order) {
    const result = state.results.get(relativePath);
    if (result === undefined) continue;
    if (result.quad === null) continue;
    if (result.image.physicalSize === null) continue;
    // 上限超過・復号失敗など、種別に依らない除外はここで落とす。
    // セル超過（doesNotFitCell）は種別で変わるため compose 側で再判定する。
    if (result.image.exclusion !== null && result.image.exclusion !== 'doesNotFitCell') continue;

    items.push({
      id: result.image.id,
      relativePath,
      filePath: path.join(state.inputFolder, relativePath),
      quad: result.quad,
      cardSizeMm: result.image.physicalSize,
      kind: kinds[relativePath] ?? 'idCard',
      ignoreIcc: result.ignoreIcc,
      effectiveDpi: result.image.effectiveDpi,
      sourceWidth: result.sourceWidth,
      sourceHeight: result.sourceHeight,
    });
  }

  return items;
}

/** 解析結果を非機微ログへ記録する（相対パスとコードのみ）。 */
function logAnalysis(logger: Logger, image: AnalyzedImage): void {
  if (image.exclusion !== null) {
    logger.log({
      level: 'warn',
      relativePath: image.relativePath,
      code: `excluded:${image.exclusion}`,
      ...(image.limitViolation === null
        ? {}
        : {
            detail: {
              actual: image.limitViolation.actual,
              limit: image.limitViolation.limit,
            },
          }),
    });
    return;
  }

  logger.log({
    level: image.warnings.length > 0 ? 'warn' : 'info',
    relativePath: image.relativePath,
    code: `analyzed:${image.status}`,
    detail: { effectiveDpi: image.effectiveDpi, warningCount: image.warnings.length },
  });
}
