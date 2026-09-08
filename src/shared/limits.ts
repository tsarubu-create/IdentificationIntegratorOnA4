/**
 * 安全上限（仕様書 §9 / §11-3）。
 *
 * 根拠は README §4.1 に記載。ここを単一の情報源とし、worker・UI・テストの
 * すべてが本ファイルを参照する。値を変更する場合は README も併せて更新すること。
 */

/** 最大ファイルサイズ（バイト）。A4 全面 600dpi・16bit・非圧縮 TIFF ≒ 209 MB を包含する。 */
export const MAX_FILE_BYTES = 300 * 1024 * 1024;

/** 各辺の最大画素数。A4 長辺を 2400dpi で読むと 28,063 px。極端なアスペクト比も遮断する。 */
export const MAX_SIDE_PX = 30_000;

/** 最大総画素数。A4 全面 1200dpi = 139 Mpx を包含する最小水準。 */
export const MAX_TOTAL_PX = 160_000_000;

/**
 * 同時に処理中の総画素数の予算。
 * 160 Mpx の巨大画像は事実上 1 枚ずつ、通常サイズなら並列数の上限まで流れる。
 */
export const MAX_INFLIGHT_PX = 200_000_000;

/** 並列ワーカー数の上限（実際の値は CPU 数から決める）。 */
export const MAX_WORKERS = 4;

/** 検出用プロキシ画像の長辺画素数。原寸を扱うのはカード外接矩形のみとする設計の要。 */
export const PROXY_LONG_EDGE_PX = 1600;

/** 確認画面サムネイルの長辺画素数（メモリ上の WebP として保持する）。 */
export const THUMBNAIL_LONG_EDGE_PX = 240;

/** OpenCV(WASM) へ渡す Mat の最大画素数。原寸全体を WASM へ渡さないための防壁。 */
export const MAX_WASM_MAT_PX = 40_000_000;

/**
 * DPI として有効とみなす下限。これ未満は「情報なし」として扱う。
 *
 * 100 という値には根拠がある。sharp は **解像度情報を持たない JPEG に対して 72 を返す**
 * （JFIF の既定値。PNG で pHYs が無い場合は undefined を返すのと対照的）。
 * 72 を実測値として採用すると、ID-1 カードを 302 x 190 mm と誤って算出し、
 * 「セルに収まらない」として除外してしまう。スキャナが 72dpi を出すことは実務上ないため、
 * 100 未満は「情報なし」とみなして 300dpi へフォールバックする（仕様書 §6）。
 */
export const MIN_VALID_DPI = 100;

/** DPI として有効とみなす上限。これを超える値は誤ったメタデータとみなす。 */
export const MAX_VALID_DPI = 2400;

/** DPI が無効・欠損のときに適用する既定値（仕様書 §6）。 */
export const FALLBACK_DPI = 300;

/**
 * 実際に使用する並列数を決める。
 *
 * @param cpuCount 論理 CPU 数
 * @returns 1 以上 MAX_WORKERS 以下の並列数
 */
export function resolveConcurrency(cpuCount: number): number {
  if (!Number.isFinite(cpuCount) || cpuCount < 1) return 1;
  return Math.max(1, Math.min(MAX_WORKERS, Math.floor(cpuCount) - 1));
}
