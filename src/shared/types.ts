/**
 * main / preload / renderer / worker で共有する型定義。
 *
 * 重要: ここに定義する型は IPC 境界を越える。**画像の生バッファや絶対パスを
 * ログ用の型へ混入させないこと**（仕様書 §4 / §9）。
 */

/** 利用者が確認画面で選択する書類種別（仕様書 §2 / §8）。 */
export type DocumentKind = 'idCard' | 'passportSpread';

/** 検出状態（仕様書 §8）。 */
export type DetectionStatus = 'detected' | 'needsReview' | 'failed';

/**
 * 除外理由コード。
 * 表示文言はレンダラ側で解決する。ログにはこのコードのみを記録する。
 */
export type ExclusionReason =
  | 'fileTooLarge'
  | 'sideTooLarge'
  | 'tooManyPixels'
  | 'decodeFailed'
  | 'unsupportedFormat'
  | 'iccUnreadable'
  | 'detectionFailed'
  | 'doesNotFitCell'
  | 'doesNotFitPrintableArea';

/** 警告コード（除外はしないが利用者へ知らせる事象）。 */
export type WarningCode =
  | 'dpiMissing'
  | 'multipleCandidates'
  | 'lowConfidence'
  | 'iccIgnored'
  /** 実測寸法が規格値（運転免許証・マイナンバーカード・旅券）と一致しない */
  | 'nonStandardSize';

/** 上限超過の詳細。利用者への具体的な対処提示に使う（仕様書 §9）。 */
export interface LimitViolation {
  readonly reason: Extract<ExclusionReason, 'fileTooLarge' | 'sideTooLarge' | 'tooManyPixels'>;
  /** 実測値（バイト数、画素数など） */
  readonly actual: number;
  /** 超過した上限値 */
  readonly limit: number;
}

/** 画像上の点（画素座標）。 */
export interface Point {
  readonly x: number;
  readonly y: number;
}

/** 左上・右上・右下・左下の順に整列済みの四隅。 */
export interface Quad {
  readonly topLeft: Point;
  readonly topRight: Point;
  readonly bottomRight: Point;
  readonly bottomLeft: Point;
}

/** 物理サイズ（ミリメートル）。 */
export interface SizeMm {
  readonly widthMm: number;
  readonly heightMm: number;
}

/** 画素サイズ。 */
export interface SizePx {
  readonly width: number;
  readonly height: number;
}

/** 確認画面の 1 行に対応する、解析済みの入力画像。 */
export interface AnalyzedImage {
  /** ジョブ内で一意な識別子 */
  readonly id: string;
  /** 入力ルートからの相対パス。**絶対パスは保持しない**（仕様書 §4） */
  readonly relativePath: string;
  readonly status: DetectionStatus;
  /** 埋め込み DPI。無効・欠損なら null（その場合 300dpi として扱う） */
  readonly embeddedDpi: number | null;
  /** 実際に適用した DPI */
  readonly effectiveDpi: number;
  /**
   * A4 上へ配置する物理サイズ（券面＋余白）。検出失敗時は null。
   * レイアウトの収まり判定にはこちらを使う。
   */
  readonly physicalSize: SizeMm | null;
  /**
   * 券面そのものの物理サイズ。規格値と一致すればその確定値が入る。
   * 確認画面の表示に使う（利用者が関心を持つのは券面の大きさであるため）。
   */
  readonly cardSizeMm: SizeMm | null;
  /** 検出スコア（0..1）。検出失敗時は null */
  readonly confidence: number | null;
  readonly warnings: readonly WarningCode[];
  /** 除外理由。出力対象なら null */
  readonly exclusion: ExclusionReason | null;
  /** 上限超過の詳細（該当時のみ） */
  readonly limitViolation: LimitViolation | null;
  /** 利用者が選択した書類種別（初期値は 'idCard'） */
  readonly kind: DocumentKind;
  /** メモリ上のサムネイル（WebP）。ディスクへは書き出さない（仕様書 §11-5） */
  readonly thumbnail: ArrayBuffer | null;
}

/** 解析フェーズの結果全体。 */
export interface AnalysisResult {
  readonly images: readonly AnalyzedImage[];
  /** 走査したが対応拡張子でなかった等でスキップした件数 */
  readonly skippedCount: number;
}

/** 出力フェーズの進捗通知。 */
export interface ProgressUpdate {
  readonly phase: 'scanning' | 'analyzing' | 'composing' | 'done';
  readonly completed: number;
  readonly total: number;
  /** 直近に処理した相対パス（表示用） */
  readonly currentRelativePath: string | null;
}

/** 出力フェーズの最終結果。 */
export interface ComposeResult {
  /** 生成した A4 ページ数 */
  readonly pageCount: number;
  /** 生成したファイル名（絶対パスではなくファイル名のみ） */
  readonly fileNames: readonly string[];
  /** 出力ディレクトリの絶対パス（「フォルダを開く」用。ログには残さない） */
  readonly outputDirectory: string;
  /** 生成ページのサムネイル（WebP）。メモリ上のみ。ファイル名と同じ順序 */
  readonly pageThumbnails: readonly ArrayBuffer[];
  /** 除外された画像とその理由 */
  readonly excluded: readonly {
    readonly relativePath: string;
    readonly reason: ExclusionReason;
  }[];
}

/** 永続化する設定。 */
export interface AppSettings {
  /** 出力ルートの絶対パス。未設定なら null */
  readonly outputRoot: string | null;
  /** 直近に選択した入力フォルダの絶対パス。未設定なら null */
  readonly lastInputFolder: string | null;
}

/** 非機微なログ 1 行（仕様書 §4）。画像・個人情報は構造上入らない。 */
export interface LogEntry {
  readonly timestamp: string;
  readonly level: 'info' | 'warn' | 'error';
  /** 入力ルートからの相対パス。ジョブ全体に関する記録なら null */
  readonly relativePath: string | null;
  /** 機械可読な事象コード */
  readonly code: string;
  /** 補足の数値（サイズ・上限値など）。自由文字列は受け付けない */
  readonly detail?: Readonly<Record<string, number>>;
}
