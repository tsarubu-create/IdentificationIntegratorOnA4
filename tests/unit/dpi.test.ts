import { describe, expect, it } from 'vitest';
import { normalizeDpi, physicalSize, roundMm, swapSize } from '@core/dpi/dpi';
import { FALLBACK_DPI, MAX_VALID_DPI, MIN_VALID_DPI } from '@shared/limits';

describe('DPI の正規化（仕様書 §6）', () => {
  it('有効な DPI はそのまま採用される', () => {
    const result = normalizeDpi(600);
    expect(result).toEqual({ embeddedDpi: 600, effectiveDpi: 600, isFallback: false });
  });

  it.each([
    ['欠損 (null)', null],
    ['欠損 (undefined)', undefined],
    ['ゼロ', 0],
    ['負値', -300],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['下限未満', MIN_VALID_DPI - 1],
    ['上限超過', MAX_VALID_DPI + 1],
  ])('%s は 300dpi へフォールバックする', (_label, value) => {
    const result = normalizeDpi(value);
    expect(result.effectiveDpi).toBe(FALLBACK_DPI);
    expect(result.embeddedDpi).toBeNull();
    expect(result.isFallback).toBe(true);
  });

  it('境界値はいずれも有効として扱う', () => {
    expect(normalizeDpi(MIN_VALID_DPI).isFallback).toBe(false);
    expect(normalizeDpi(MAX_VALID_DPI).isFallback).toBe(false);
  });
});

describe('物理サイズ換算', () => {
  it('300dpi の 1011 x 638 px は ID-1 カードの実寸になる', () => {
    const size = physicalSize({ width: 1011, height: 638 }, 300);
    expect(size.widthMm).toBeCloseTo(85.6, 1);
    expect(size.heightMm).toBeCloseTo(54.0, 1);
  });

  it('DPI が倍なら物理サイズは半分になる', () => {
    const at300 = physicalSize({ width: 1200, height: 600 }, 300);
    const at600 = physicalSize({ width: 1200, height: 600 }, 600);
    expect(at600.widthMm).toBeCloseTo(at300.widthMm / 2, 9);
    expect(at600.heightMm).toBeCloseTo(at300.heightMm / 2, 9);
  });

  it('不正な DPI は例外になる（フォールバック漏れを検出するため）', () => {
    expect(() => physicalSize({ width: 100, height: 100 }, 0)).toThrow(RangeError);
    expect(() => physicalSize({ width: 100, height: 100 }, Number.NaN)).toThrow(RangeError);
  });
});

describe('表示・回転の補助', () => {
  it('mm は小数第 1 位へ丸められる', () => {
    expect(roundMm(85.649)).toBe(85.6);
    expect(roundMm(69.2573)).toBe(69.3);
  });

  it('90 度回転は幅と高さを入れ替える', () => {
    expect(swapSize({ widthMm: 176, heightMm: 125 })).toEqual({ widthMm: 125, heightMm: 176 });
  });
});
