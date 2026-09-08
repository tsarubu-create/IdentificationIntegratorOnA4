/**
 * IPC の契約（README §1.2）。
 *
 * renderer は `window.api` 経由でのみ main と通信する。preload は
 * ここに列挙されたチャネルだけを橋渡しし、任意のチャネルは通さない。
 */

import type {
  AnalyzedImage,
  AppSettings,
  ComposeResult,
  DocumentKind,
  ProgressUpdate,
} from '@shared/types';

/** IPC チャネル名。 */
export const IpcChannel = {
  getSettings: 'settings:get',
  chooseInputFolder: 'dialog:choose-input-folder',
  chooseOutputRoot: 'dialog:choose-output-root',
  analyze: 'job:analyze',
  compose: 'job:compose',
  cancel: 'job:cancel',
  openOutputFolder: 'shell:open-output-folder',
  /** main -> renderer の一方向通知 */
  progress: 'job:progress',
} as const;

/** 解析要求。 */
export interface AnalyzeRequestPayload {
  readonly inputFolder: string;
}

/** 解析の応答。 */
export type AnalyzeResponse =
  | { readonly ok: true; readonly images: readonly AnalyzedImage[]; readonly skippedCount: number }
  | { readonly ok: false; readonly reason: 'noImages' | 'noOutputRoot' | 'unreadable' };

/** 出力要求。確認画面で利用者が選んだ種別を伴う。 */
export interface ComposeRequestPayload {
  /** 画像 ID -> 利用者が選択した種別 */
  readonly kinds: Readonly<Record<string, DocumentKind>>;
}

/** 出力の応答。 */
export type ComposeResponse =
  | { readonly ok: true; readonly result: ComposeResult }
  | {
      readonly ok: false;
      readonly reason: 'cancelled' | 'noOutputRoot' | 'failed';
      readonly message?: string;
    };

/** preload が renderer へ公開する API。 */
export interface RendererApi {
  getSettings(): Promise<AppSettings>;
  chooseInputFolder(): Promise<string | null>;
  chooseOutputRoot(): Promise<string | null>;
  analyze(payload: AnalyzeRequestPayload): Promise<AnalyzeResponse>;
  compose(payload: ComposeRequestPayload): Promise<ComposeResponse>;
  cancel(): Promise<void>;
  openOutputFolder(): Promise<void>;
  /** 進捗の購読。戻り値を呼ぶと購読を解除する */
  onProgress(listener: (update: ProgressUpdate) => void): () => void;
}
