import { describe, expect, it } from 'vitest';
import { createMemoryLogger, formatLogEntry, isSafeRelativePath } from '@core/logging/logger';

describe('相対パスの安全性検査（仕様書 §4）', () => {
  it.each(['scan001.jpg', 'sub/scan.jpg', 'サブ/画像.png', 'a/b/c/d.tif'])(
    '相対パス "%s" は安全と判定される',
    (value) => {
      expect(isSafeRelativePath(value)).toBe(true);
    },
  );

  it.each([
    ['Windows 絶対パス', 'C:\\Users\\taro\\scan.jpg'],
    ['Windows 絶対パス（スラッシュ）', 'D:/private/scan.jpg'],
    ['UNC パス', '\\\\server\\share\\scan.jpg'],
    ['POSIX 絶対パス', '/home/taro/scan.jpg'],
    ['親ディレクトリ参照', '../outside/scan.jpg'],
    ['中間の親参照', 'sub/../../scan.jpg'],
    ['空文字', ''],
  ])('%s は危険と判定される', (_label, value) => {
    expect(isSafeRelativePath(value)).toBe(false);
  });
});

describe('ログ整形（個人情報を残さない）', () => {
  it('相対パス・コード・数値のみを記録する', () => {
    const line = formatLogEntry({
      timestamp: '2026-01-01T00:00:00.000Z',
      level: 'warn',
      relativePath: 'sub/scan001.jpg',
      code: 'dpiMissing',
      detail: { appliedDpi: 300 },
    });

    expect(JSON.parse(line)).toEqual({
      timestamp: '2026-01-01T00:00:00.000Z',
      level: 'warn',
      relativePath: 'sub/scan001.jpg',
      code: 'dpiMissing',
      detail: { appliedDpi: 300 },
    });
  });

  it('絶対パスが渡されても、そのままは書き出さない', () => {
    // ユーザー名を含む絶対パスは、それ自体が個人情報になりうる。
    const line = formatLogEntry({
      timestamp: '2026-01-01T00:00:00.000Z',
      level: 'error',
      relativePath: 'C:\\Users\\山田太郎\\Desktop\\免許証.jpg',
      code: 'decodeFailed',
    });

    expect(line).not.toContain('山田太郎');
    expect(line).not.toContain('C:');
    expect(JSON.parse(line).relativePath).toBe('<invalid-path>');
  });

  it('ジョブ全体のログでは相対パスを null にできる', () => {
    const line = formatLogEntry({
      timestamp: '2026-01-01T00:00:00.000Z',
      level: 'info',
      relativePath: null,
      code: 'jobStarted',
    });
    expect(JSON.parse(line).relativePath).toBeNull();
  });

  it('detail が無ければキー自体を出さない', () => {
    const parsed = JSON.parse(
      formatLogEntry({
        timestamp: '2026-01-01T00:00:00.000Z',
        level: 'info',
        relativePath: null,
        code: 'jobFinished',
      }),
    ) as Record<string, unknown>;

    expect('detail' in parsed).toBe(false);
  });

  it('1 行に収まる（JSON Lines として壊れない）', () => {
    const line = formatLogEntry({
      timestamp: '2026-01-01T00:00:00.000Z',
      level: 'info',
      relativePath: 'a/b.jpg',
      code: 'ok',
    });
    expect(line).not.toContain('\n');
  });
});

describe('メモリロガー', () => {
  it('記録件数と内容を保持する', () => {
    const logger = createMemoryLogger();
    logger.log({ level: 'info', relativePath: 'a.jpg', code: 'detected' });
    logger.log({ level: 'warn', relativePath: 'b.jpg', code: 'lowConfidence' });

    expect(logger.pendingCount).toBe(2);
    expect(logger.lines).toHaveLength(2);
    expect(JSON.parse(logger.lines[0]!).code).toBe('detected');
  });

  it('タイムスタンプが自動で付与される', () => {
    const logger = createMemoryLogger();
    logger.log({ level: 'info', relativePath: null, code: 'jobStarted' });
    const timestamp = JSON.parse(logger.lines[0]!).timestamp as string;
    expect(Number.isNaN(Date.parse(timestamp))).toBe(false);
  });
});
