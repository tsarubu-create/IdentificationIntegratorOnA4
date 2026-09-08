/**
 * 入力フォルダの再帰走査（仕様書 §3 / §4）。
 *
 * 不変条件:
 * - 入力に対しては **読み取りしか行わない**。この module は書き込み系 API を一切使わない。
 * - 出力ディレクトリ配下は必ず除外する。シンボリックリンク経由の再入も遮断する。
 */

import { opendir, realpath } from 'node:fs/promises';
import path from 'node:path';

/** 対象拡張子（仕様書 §3）。比較は小文字化して行う。 */
export const SUPPORTED_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.tif', '.tiff'] as const;

const SUPPORTED_EXTENSION_SET: ReadonlySet<string> = new Set(SUPPORTED_EXTENSIONS);

/** ファイル名が対象拡張子か判定する（大文字・小文字を区別しない）。 */
export function isSupportedImage(fileName: string): boolean {
  const dotIndex = fileName.lastIndexOf('.');
  // 先頭のドットのみ（`.gitignore` など）は拡張子とみなさない。
  if (dotIndex <= 0) return false;
  return SUPPORTED_EXTENSION_SET.has(fileName.slice(dotIndex).toLowerCase());
}

/**
 * `child` が `parent` の配下（または同一）かを判定する。
 *
 * 文字列の前方一致では `C:\out` が `C:\output` を誤って包含すると判定してしまうため、
 * `path.relative` の結果で判定する。Windows では大文字・小文字も吸収される。
 */
export function isPathWithin(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  if (relative === '') return true;
  return !relative.startsWith('..') && !path.isAbsolute(relative);
}

/** 走査の設定。 */
export interface ScanOptions {
  /** 入力ルートの絶対パス */
  readonly inputRoot: string;
  /** 走査から除外するディレクトリの絶対パス（出力ディレクトリなど） */
  readonly excludedDirectories?: readonly string[];
  /** 中止シグナル */
  readonly signal?: AbortSignal;
}

/** 走査結果。 */
export interface ScanResult {
  /** 入力ルートからの相対パス（POSIX 区切り）。順序は未定義（呼び出し側で自然順ソートする） */
  readonly files: readonly string[];
  /** 対象拡張子でなかったためスキップしたファイル数 */
  readonly skippedCount: number;
  /** 読み取り権限がない等で開けなかったディレクトリ数 */
  readonly unreadableDirectoryCount: number;
}

/**
 * ディレクトリの実パスを解決する。解決できない場合は元のパスを返す。
 *
 * 存在しないパス（未作成の出力先など）を除外指定できるようにするため、
 * 失敗を例外にしない。
 */
async function safeRealPath(target: string): Promise<string> {
  try {
    return await realpath(target);
  } catch {
    return path.resolve(target);
  }
}

/**
 * 入力ルート配下を再帰的に走査し、対象拡張子の画像を列挙する。
 *
 * @throws inputRoot が読み取れない場合（呼び出し側でモーダル表示する）
 */
export async function scanImages(options: ScanOptions): Promise<ScanResult> {
  const { inputRoot, excludedDirectories = [], signal } = options;

  const rootReal = await safeRealPath(inputRoot);
  const excludedReal = await Promise.all(excludedDirectories.map(safeRealPath));

  const files: string[] = [];
  let skippedCount = 0;
  let unreadableDirectoryCount = 0;

  /**
   * 訪問済みの実パス。シンボリックリンクによる循環（`a -> a/link`）で
   * 無限ループに陥るのを防ぐ。
   */
  const visited = new Set<string>([rootReal]);

  const isExcluded = (realDirectory: string): boolean =>
    excludedReal.some((excluded) => isPathWithin(excluded, realDirectory));

  const stack: { absolute: string; real: string }[] = [{ absolute: inputRoot, real: rootReal }];

  while (stack.length > 0) {
    signal?.throwIfAborted();
    const current = stack.pop();
    if (current === undefined) break;

    let dir;
    try {
      dir = await opendir(current.absolute);
    } catch {
      // 権限不足・削除済みなどで開けないディレクトリは、走査全体を止めずに数える。
      unreadableDirectoryCount += 1;
      continue;
    }

    try {
      for await (const entry of dir) {
        signal?.throwIfAborted();
        const absolute = path.join(current.absolute, entry.name);

        if (entry.isDirectory() || entry.isSymbolicLink()) {
          const real = await safeRealPath(absolute);
          // シンボリックリンクがファイルを指す場合は realpath がファイルを返す。
          // その場合は下の統計判定へ回さず、ディレクトリとして push しない。
          if (entry.isSymbolicLink() && !(await isDirectoryPath(real))) {
            if (isExcluded(real)) continue;
            if (isSupportedImage(entry.name)) {
              files.push(toRelativePosix(inputRoot, absolute));
            } else {
              skippedCount += 1;
            }
            continue;
          }
          if (isExcluded(real) || visited.has(real)) continue;
          visited.add(real);
          stack.push({ absolute, real });
          continue;
        }

        if (!entry.isFile()) continue;

        if (isSupportedImage(entry.name)) {
          files.push(toRelativePosix(inputRoot, absolute));
        } else {
          skippedCount += 1;
        }
      }
    } catch {
      unreadableDirectoryCount += 1;
    }
  }

  return { files, skippedCount, unreadableDirectoryCount };
}

/** パスがディレクトリかを判定する（開けなければ false）。 */
async function isDirectoryPath(target: string): Promise<boolean> {
  try {
    const dir = await opendir(target);
    await dir.close();
    return true;
  } catch {
    return false;
  }
}

/**
 * 入力ルートからの相対パスを POSIX 区切りで返す。
 *
 * ログ・確認画面へ渡すのはこの相対パスだけであり、絶対パスは境界を越えさせない（仕様書 §4）。
 */
function toRelativePosix(inputRoot: string, absolute: string): string {
  return path.relative(inputRoot, absolute).split(path.sep).join('/');
}
