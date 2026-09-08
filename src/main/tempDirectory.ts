/**
 * 一時ディレクトリの生涯管理（仕様書 §9 / §11-5）。
 *
 * 通常経路では一時ファイルを作らない設計だが、必要になった場合に備えて
 * 「アプリ自身が作ったものだけを、確実に消す」仕組みを用意する。
 *
 * **削除対象は `a4int-` で始まる自作ディレクトリに限定する。**
 * 利用者が指定したフォルダや、他アプリの一時ファイルには一切触れない。
 */

import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';

/** アプリが作る一時ディレクトリの接頭辞。 */
export const TEMP_PREFIX = 'a4int-';

/** 起動時の掃除で「古い」とみなす経過時間。 */
const STALE_AGE_MS = 24 * 60 * 60 * 1000;

/** このプロセスが作った一時ディレクトリ。 */
const owned = new Set<string>();

/**
 * アプリ専用の一時ディレクトリを作る。
 *
 * @param systemTempDirectory `app.getPath('temp')` の値
 */
export async function createTempDirectory(systemTempDirectory: string): Promise<string> {
  const directory = await mkdtemp(path.join(systemTempDirectory, TEMP_PREFIX));
  owned.add(directory);
  return directory;
}

/**
 * このプロセスが作った一時ディレクトリをすべて削除する。
 *
 * ジョブ成功・失敗・中止、および終了時に呼ぶ。
 */
export async function cleanupOwnedTempDirectories(): Promise<void> {
  const targets = [...owned];
  owned.clear();

  await Promise.all(
    targets.map(async (directory) => {
      try {
        await rm(directory, { recursive: true, force: true });
      } catch {
        // 削除できなくても処理は続行する。次回起動時の掃除で回収される。
      }
    }),
  );
}

/**
 * 異常終了で残った古い一時ディレクトリを掃除する（起動時に呼ぶ）。
 *
 * 接頭辞と経過時間の両方で絞り込む。接頭辞だけで消すと、同時に起動している
 * 別のインスタンスの作業ディレクトリを消してしまう恐れがあるため。
 */
export async function sweepStaleTempDirectories(systemTempDirectory: string): Promise<number> {
  let removed = 0;

  let entries: string[];
  try {
    entries = await readdir(systemTempDirectory);
  } catch {
    return 0;
  }

  const threshold = Date.now() - STALE_AGE_MS;

  for (const entry of entries) {
    if (!entry.startsWith(TEMP_PREFIX)) continue;

    const directory = path.join(systemTempDirectory, entry);
    if (owned.has(directory)) continue;

    try {
      const info = await stat(directory);
      if (!info.isDirectory() || info.mtimeMs >= threshold) continue;
      await rm(directory, { recursive: true, force: true });
      removed += 1;
    } catch {
      // 権限不足などは無視する。
    }
  }

  return removed;
}

/** テスト用: 管理中の一時ディレクトリ一覧。 */
export function ownedTempDirectories(): readonly string[] {
  return [...owned];
}
