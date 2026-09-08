/**
 * 出力ファイルの連番採番（仕様書 §4）。
 *
 * 既存ファイルを上書きしないことが要件。ここでは「既存名から次の番号を決める」
 * 純粋ロジックのみを扱い、実際の書き込みは排他作成（'wx'）で行う。
 * ディレクトリ走査と排他作成を組み合わせて初めて上書きが防げる。
 */

/** 出力ファイル名の接頭辞。 */
export const OUTPUT_PREFIX = 'integrated_A4_';

/** 出力ファイルの拡張子。 */
export const OUTPUT_EXTENSION = '.png';

/** 連番の最小桁数（`integrated_A4_001.png`）。 */
export const SEQUENCE_MIN_DIGITS = 3;

/**
 * 出力ファイル名にマッチする正規表現。
 *
 * 既存ファイルの検出時は大文字小文字を区別しない。Windows のファイルシステムは
 * 既定で大文字小文字を区別しないため、`INTEGRATED_A4_001.PNG` を見落とすと
 * 上書き衝突を起こしうる。
 */
const OUTPUT_NAME_PATTERN = /^integrated_A4_(\d{3,})\.png$/i;

/**
 * ファイル名が出力ファイルの命名規則に一致すれば連番を返す。一致しなければ null。
 */
export function parseSequenceNumber(fileName: string): number | null {
  const match = OUTPUT_NAME_PATTERN.exec(fileName);
  if (match === null) return null;
  const digits = match[1];
  if (digits === undefined) return null;
  const value = Number.parseInt(digits, 10);
  return Number.isSafeInteger(value) ? value : null;
}

/**
 * 連番から出力ファイル名を組み立てる。
 *
 * 1000 以上は桁数が自然に増える（`integrated_A4_1000.png`）。桁を固定して
 * 折り返すと衝突するため、上限は設けない。
 *
 * @param sequence 1 以上の整数
 */
export function formatOutputName(sequence: number): string {
  if (!Number.isInteger(sequence) || sequence < 1) {
    throw new RangeError(`連番は 1 以上の整数である必要があります: ${sequence}`);
  }
  return `${OUTPUT_PREFIX}${String(sequence).padStart(SEQUENCE_MIN_DIGITS, '0')}${OUTPUT_EXTENSION}`;
}

/**
 * 既存のファイル名一覧から、次に使うべき連番を決める。
 *
 * 「最大値 + 1」を採る。欠番を埋める方式にしないのは、後から追加された出力が
 * 既存の連番の間に割り込み、印刷順と連番順の対応が崩れるのを避けるため。
 *
 * @param existingNames 出力ディレクトリ内のファイル名一覧（ディレクトリ名を含んでよい）
 * @returns 次に使う連番（既存が無ければ 1）
 */
export function nextSequenceNumber(existingNames: readonly string[]): number {
  let max = 0;
  for (const name of existingNames) {
    const sequence = parseSequenceNumber(name);
    if (sequence !== null && sequence > max) max = sequence;
  }
  return max + 1;
}
