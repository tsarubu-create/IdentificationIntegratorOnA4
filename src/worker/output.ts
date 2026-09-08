/**
 * 出力ディレクトリの用意と、既存ファイルを上書きしない書き込み（仕様書 §4）。
 */

import { mkdir, open, readdir } from 'node:fs/promises';
import path from 'node:path';
import { formatOutputName, nextSequenceNumber } from '@core/naming/sequence';

/** 出力ディレクトリ名（`<出力ルート>/A4Integrate`）。 */
export const OUTPUT_DIRECTORY_NAME = 'A4Integrate';

/** 連番の衝突が続いた場合に諦める回数。 */
const MAX_COLLISION_RETRIES = 1000;

/**
 * 出力ディレクトリ `<出力ルート>/A4Integrate` を用意し、その絶対パスを返す。
 *
 * 既存のディレクトリはそのまま使う（中身は消さない）。
 */
export async function ensureOutputDirectory(outputRoot: string): Promise<string> {
  const directory = path.join(outputRoot, OUTPUT_DIRECTORY_NAME);
  await mkdir(directory, { recursive: true });
  return directory;
}

/** 出力ディレクトリの既存ファイルから、次に使う連番を求める。 */
export async function resolveStartSequence(directory: string): Promise<number> {
  try {
    const entries = await readdir(directory);
    return nextSequenceNumber(entries);
  } catch {
    // ディレクトリがまだ無い場合は 1 から始まる。
    return 1;
  }
}

/** 書き込み結果。 */
export interface WrittenPage {
  readonly fileName: string;
  readonly sequence: number;
}

/**
 * ページを書き出す。**既存ファイルを絶対に上書きしない**。
 *
 * `'wx'`（排他作成）で開くため、同名ファイルが存在すれば `EEXIST` になる。
 * ディレクトリ走査による採番だけでは、他プロセスが同時に書いた場合に
 * 上書きが起こりうるため、排他作成を最終防壁とする。
 *
 * @param directory 出力ディレクトリ（絶対パス）
 * @param sequence 使用したい連番
 * @param bytes PNG のバイト列
 * @returns 実際に使われたファイル名と連番
 */
export async function writePageExclusive(
  directory: string,
  sequence: number,
  bytes: Buffer,
): Promise<WrittenPage> {
  let candidate = sequence;

  for (let attempt = 0; attempt < MAX_COLLISION_RETRIES; attempt += 1) {
    const fileName = formatOutputName(candidate);
    const filePath = path.join(directory, fileName);

    let handle;
    try {
      handle = await open(filePath, 'wx');
    } catch (error) {
      if (isFileExistsError(error)) {
        candidate += 1;
        continue;
      }
      throw error;
    }

    try {
      await handle.writeFile(bytes);
    } finally {
      await handle.close();
    }

    return { fileName, sequence: candidate };
  }

  throw new Error(`出力ファイル名の空きが見つかりませんでした（${MAX_COLLISION_RETRIES} 回試行）`);
}

/** `EEXIST` かどうかを判定する。 */
function isFileExistsError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'EEXIST'
  );
}
