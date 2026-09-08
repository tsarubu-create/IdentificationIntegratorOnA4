import { describe, expect, it } from 'vitest';
import { formatOutputName, nextSequenceNumber, parseSequenceNumber } from '@core/naming/sequence';

describe('出力ファイル名の生成（仕様書 §4）', () => {
  it('連番は 3 桁ゼロ詰めになる', () => {
    expect(formatOutputName(1)).toBe('integrated_A4_001.png');
    expect(formatOutputName(42)).toBe('integrated_A4_042.png');
    expect(formatOutputName(999)).toBe('integrated_A4_999.png');
  });

  it('1000 以上は桁が増える（折り返して衝突させない）', () => {
    expect(formatOutputName(1000)).toBe('integrated_A4_1000.png');
    expect(formatOutputName(12345)).toBe('integrated_A4_12345.png');
  });

  it('不正な連番は例外になる', () => {
    expect(() => formatOutputName(0)).toThrow(RangeError);
    expect(() => formatOutputName(-1)).toThrow(RangeError);
    expect(() => formatOutputName(1.5)).toThrow(RangeError);
  });
});

describe('既存ファイル名の解析', () => {
  it('規則に一致する名前から連番を取り出す', () => {
    expect(parseSequenceNumber('integrated_A4_007.png')).toBe(7);
    expect(parseSequenceNumber('integrated_A4_1234.png')).toBe(1234);
  });

  it('Windows の大文字小文字非区別を考慮して一致させる', () => {
    // 大文字の既存ファイルを見落とすと、同名衝突で上書きが起こりうる。
    expect(parseSequenceNumber('INTEGRATED_A4_005.PNG')).toBe(5);
  });

  it.each([
    'integrated_A4_1.png', // 桁数不足
    'integrated_A4_001.jpg', // 拡張子違い
    'other_001.png',
    'integrated_A4_001.png.bak',
    'integrated_A4_abc.png',
    'integrated_A4_.png',
  ])('規則に一致しない "%s" は null を返す', (name) => {
    expect(parseSequenceNumber(name)).toBeNull();
  });
});

describe('次の連番の決定（既存を上書きしない）', () => {
  it('既存が無ければ 1 から始まる', () => {
    expect(nextSequenceNumber([])).toBe(1);
    expect(nextSequenceNumber(['readme.txt', 'photo.png'])).toBe(1);
  });

  it('既存の最大値 + 1 を返す', () => {
    expect(nextSequenceNumber(['integrated_A4_001.png', 'integrated_A4_003.png'])).toBe(4);
  });

  it('欠番は埋めない（印刷順と連番順の対応を保つ）', () => {
    // 002 が欠けていても 4 を返し、既存の間に割り込まない。
    const names = ['integrated_A4_001.png', 'integrated_A4_003.png'];
    expect(nextSequenceNumber(names)).toBe(4);
  });

  it('無関係なファイルは採番に影響しない', () => {
    const names = ['integrated_A4_010.png', 'notes.md', 'IMG_9999.jpg', 'integrated_A4_002.png'];
    expect(nextSequenceNumber(names)).toBe(11);
  });

  it('4 桁以上の既存も正しく扱う', () => {
    expect(nextSequenceNumber(['integrated_A4_0999.png', 'integrated_A4_1000.png'])).toBe(1001);
  });
});
