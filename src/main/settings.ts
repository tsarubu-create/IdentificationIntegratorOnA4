/**
 * 設定の永続化（仕様書 §4）。
 *
 * 保存するのはフォルダのパスだけで、画像や個人情報は保存しない。
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AppSettings } from '@shared/types';

const SETTINGS_FILE_NAME = 'settings.json';

const DEFAULT_SETTINGS: AppSettings = {
  outputRoot: null,
  lastInputFolder: null,
};

/** 設定ファイルを読み込む。壊れていれば既定値へ戻す。 */
export async function loadSettings(userDataDirectory: string): Promise<AppSettings> {
  try {
    const raw = await readFile(path.join(userDataDirectory, SETTINGS_FILE_NAME), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    return normalize(parsed);
  } catch {
    // 未作成・破損のいずれでも既定値で続行する。設定の読み込み失敗で
    // アプリが起動できなくなるほうが害が大きい。
    return DEFAULT_SETTINGS;
  }
}

/** 設定ファイルを書き出す。 */
export async function saveSettings(
  userDataDirectory: string,
  settings: AppSettings,
): Promise<void> {
  await mkdir(userDataDirectory, { recursive: true });
  await writeFile(
    path.join(userDataDirectory, SETTINGS_FILE_NAME),
    `${JSON.stringify(settings, null, 2)}\n`,
    'utf8',
  );
}

/** 読み込んだ値を既知の形へ正規化する。 */
function normalize(value: unknown): AppSettings {
  if (typeof value !== 'object' || value === null) return DEFAULT_SETTINGS;
  const record = value as Record<string, unknown>;

  return {
    outputRoot: typeof record.outputRoot === 'string' ? record.outputRoot : null,
    lastInputFolder: typeof record.lastInputFolder === 'string' ? record.lastInputFolder : null,
  };
}
