/**
 * main と画像処理ワーカーの間で交わすメッセージ定義。
 *
 * ここを 1 か所に集約することで、main / worker の双方が同じ型で検査される。
 * **画像の生バッファはサムネイル（ArrayBuffer）以外やり取りしない。**
 */

import type { AnalyzedImage, DocumentKind, ExclusionReason, Quad, SizeMm } from '@shared/types';

/** 解析タスクの入力。 */
export interface AnalyzeTask {
  readonly id: string;
  readonly filePath: string;
  readonly relativePath: string;
}

/** 解析タスクの結果（main 側が保持する内部情報を含む）。 */
export interface AnalyzeTaskResult {
  readonly image: AnalyzedImage;
  readonly quad: Quad | null;
  readonly ignoreIcc: boolean;
  /** Exif 回転を適用した後の元画像寸法 */
  readonly sourceWidth: number;
  readonly sourceHeight: number;
}

/** 出力タスクの 1 件。 */
export interface ComposeTaskItem {
  readonly id: string;
  readonly relativePath: string;
  readonly filePath: string;
  readonly quad: Quad;
  readonly cardSizeMm: SizeMm;
  readonly kind: DocumentKind;
  readonly ignoreIcc: boolean;
  /** 画像に適用する解像度（規格値を画素へ換算するために使う） */
  readonly effectiveDpi: number;
  readonly sourceWidth: number;
  readonly sourceHeight: number;
}

/** 出力タスクの入力。 */
export interface ComposeTask {
  readonly items: readonly ComposeTaskItem[];
  readonly outputDirectory: string;
}

/** 出力タスクの結果。 */
export interface ComposeTaskResult {
  readonly fileNames: readonly string[];
  readonly excluded: readonly { relativePath: string; reason: ExclusionReason }[];
  /** 生成ページのサムネイル（WebP）。ファイル名と同じ順序 */
  readonly pageThumbnails: readonly ArrayBuffer[];
}

/** main -> worker。 */
export type WorkerRequest =
  | { readonly kind: 'analyze'; readonly taskId: number; readonly task: AnalyzeTask }
  | { readonly kind: 'compose'; readonly taskId: number; readonly task: ComposeTask };

/** worker -> main。 */
export type WorkerResponse =
  | { readonly kind: 'ready' }
  | { readonly kind: 'analyzed'; readonly taskId: number; readonly result: AnalyzeTaskResult }
  | { readonly kind: 'composed'; readonly taskId: number; readonly result: ComposeTaskResult }
  | {
      readonly kind: 'pageWritten';
      readonly taskId: number;
      readonly fileName: string;
      readonly pageIndex: number;
      readonly pageCount: number;
    }
  | { readonly kind: 'failed'; readonly taskId: number; readonly message: string };
