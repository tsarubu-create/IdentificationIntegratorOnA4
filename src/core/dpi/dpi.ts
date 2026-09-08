/**
 * DPI の正規化と物理サイズ換算（仕様書 §6）。
 */

import { FALLBACK_DPI, MAX_VALID_DPI, MIN_VALID_DPI } from '@shared/limits';
import type { SizeMm, SizePx } from '@shared/types';
import { MM_PER_INCH } from '@core/layout/a4';

/** DPI 正規化の結果。 */
export interface NormalizedDpi {
  /** 画像に埋め込まれていた有効な DPI。無効・欠損なら null */
  readonly embeddedDpi: number | null;
  /** 実際に適用する DPI（無効・欠損なら 300） */
  readonly effectiveDpi: number;
  /** 確認画面に「DPI情報なし・300dpiとして配置」を表示すべきか */
  readonly isFallback: boolean;
}

/**
 * 画像メタデータの DPI を正規化する。
 *
 * sharp の `metadata().density` は、DPI 情報を持たない画像でも 72 を返すことがあるなど
 * 信頼できない値を含みうる。ここでは「有限の数値」かつ「50..2400 の範囲」のみを
 * 有効とみなし、それ以外は 300dpi へフォールバックする（仕様書 §6）。
 *
 * @param density 画像メタデータの解像度（dpi）。欠損時は null / undefined
 */
export function normalizeDpi(density: number | null | undefined): NormalizedDpi {
  const isValid =
    typeof density === 'number' &&
    Number.isFinite(density) &&
    density >= MIN_VALID_DPI &&
    density <= MAX_VALID_DPI;

  if (!isValid) {
    return { embeddedDpi: null, effectiveDpi: FALLBACK_DPI, isFallback: true };
  }
  return { embeddedDpi: density, effectiveDpi: density, isFallback: false };
}

/**
 * 画素サイズと DPI から物理サイズ（mm）を求める。
 *
 * @param size 画素サイズ
 * @param dpi 適用する DPI（`normalizeDpi` で正規化済みの値を渡すこと）
 */
export function physicalSize(size: SizePx, dpi: number): SizeMm {
  if (!Number.isFinite(dpi) || dpi <= 0) {
    throw new RangeError(`DPI は正の有限値である必要があります: ${dpi}`);
  }
  return {
    widthMm: (size.width / dpi) * MM_PER_INCH,
    heightMm: (size.height / dpi) * MM_PER_INCH,
  };
}

/** 表示用に mm を小数第 1 位へ丸める。 */
export function roundMm(mm: number): number {
  return Math.round(mm * 10) / 10;
}

/** 幅・高さを入れ替える（パスポート見開きの 90 度回転に対応）。 */
export function swapSize(size: SizeMm): SizeMm {
  return { widthMm: size.heightMm, heightMm: size.widthMm };
}
