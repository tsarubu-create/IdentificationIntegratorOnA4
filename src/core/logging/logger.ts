/**
 * 非機微ログ（仕様書 §4 / §9）。
 *
 * 記録してよいのは「入力ルートからの相対パス・結果コード・理由コード・数値」だけ。
 * カード画像、OCR 結果、個人情報、絶対パスは記録しない。
 *
 * 型（`LogEntry`）で画像バッファや自由文字列を受け取れないようにしたうえで、
 * さらに実行時にも絶対パスの混入を検査する。型は開発時の誤りしか防げないため、
 * 相対パスは呼び出し側で組み立てられる以上、実行時の検査も要る。
 */

import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { LogEntry } from '@shared/types';

/** Windows のドライブレター付き絶対パス、UNC パス、POSIX 絶対パス。 */
const ABSOLUTE_PATH_PATTERN = /^(?:[A-Za-z]:[\\/]|\\\\|\/)/;

/** 相対パスに絶対パスが紛れ込んでいないか検査する。 */
export function isSafeRelativePath(relativePath: string): boolean {
  if (relativePath === '') return false;
  if (ABSOLUTE_PATH_PATTERN.test(relativePath)) return false;
  // 上位ディレクトリへの参照は、入力ルート外を指すため相対パスとして不正。
  return !relativePath.split(/[\\/]/).includes('..');
}

/**
 * ログ 1 行を JSON Lines として整形する。
 *
 * 絶対パスが渡された場合は例外にせず、`'<invalid-path>'` へ置換する。
 * ログ出力の失敗で処理全体を止めるのは本末転倒であり、
 * かといって個人情報を含みうる絶対パスをそのまま書くわけにもいかないため。
 */
export function formatLogEntry(entry: LogEntry): string {
  const relativePath =
    entry.relativePath === null
      ? null
      : isSafeRelativePath(entry.relativePath)
        ? entry.relativePath
        : '<invalid-path>';

  const record: Record<string, unknown> = {
    timestamp: entry.timestamp,
    level: entry.level,
    relativePath,
    code: entry.code,
  };
  if (entry.detail !== undefined) record.detail = entry.detail;

  return JSON.stringify(record);
}

/** ログ出力口。 */
export interface Logger {
  /** 1 件記録する（バッファへ積む） */
  log(entry: Omit<LogEntry, 'timestamp'>): void;
  /** バッファをファイルへ書き出す */
  flush(): Promise<void>;
  /** 記録済みの件数（テスト・進捗表示用） */
  readonly pendingCount: number;
}

/** ログファイルを持たない、メモリ上のみのロガー（テスト用）。 */
export function createMemoryLogger(): Logger & { readonly lines: readonly string[] } {
  const lines: string[] = [];
  return {
    log(entry) {
      lines.push(formatLogEntry({ ...entry, timestamp: new Date().toISOString() }));
    },
    flush() {
      return Promise.resolve();
    },
    get pendingCount() {
      return lines.length;
    },
    lines,
  };
}

/**
 * ファイルへ追記するロガーを作る。
 *
 * @param directory ログディレクトリの絶対パス（`userData/logs` を想定）
 * @param fileName ログファイル名
 */
export function createFileLogger(directory: string, fileName: string): Logger {
  let buffer: string[] = [];
  const filePath = path.join(directory, fileName);

  return {
    log(entry) {
      buffer.push(formatLogEntry({ ...entry, timestamp: new Date().toISOString() }));
    },
    async flush() {
      if (buffer.length === 0) return;
      const payload = `${buffer.join('\n')}\n`;
      buffer = [];
      await mkdir(directory, { recursive: true });
      await appendFile(filePath, payload, 'utf8');
    },
    get pendingCount() {
      return buffer.length;
    },
  };
}
