/**
 * A4 出力の幾何（仕様書 §6 / §7）。
 *
 * すべての寸法は「物理サイズ（mm）が正、画素はその写像」という方針で扱う。
 * 画素値を先に決めて mm を後から逆算すると丸め誤差が印刷結果に効いてくるため。
 */

import type { SizeMm, SizePx } from '@shared/types';

/** 1 インチのミリメートル数。 */
export const MM_PER_INCH = 25.4;

/** 出力 PNG の解像度（仕様書 §6）。 */
export const OUTPUT_DPI = 300;

/** A4 の物理サイズ（縦向き）。 */
export const A4_WIDTH_MM = 210;
export const A4_HEIGHT_MM = 297;

/** 印刷可能領域の全周セットバック（仕様書 §7.1）。 */
export const SETBACK_MM = 10;

/** 身分証カードの固定グリッド（仕様書 §7.2）。 */
export const GRID_COLUMNS = 2;
export const GRID_ROWS = 4;
export const CARDS_PER_PAGE = GRID_COLUMNS * GRID_ROWS;

/** 出力ページの白背景（仕様書 §7.1）。 */
export const PAGE_BACKGROUND = '#FFFFFF' as const;

/**
 * ミリメートルを、指定 DPI での画素数へ変換する。
 *
 * @param mm ミリメートル
 * @param dpi 解像度（既定は出力解像度）
 */
export function mmToPx(mm: number, dpi: number = OUTPUT_DPI): number {
  return (mm / MM_PER_INCH) * dpi;
}

/**
 * 画素数を、指定 DPI でのミリメートルへ変換する。
 *
 * @param px 画素数
 * @param dpi 解像度
 */
export function pxToMm(px: number, dpi: number): number {
  return (px / dpi) * MM_PER_INCH;
}

/** A4 ページ全体の画素サイズ（2480 x 3508）。 */
export const PAGE_SIZE_PX: SizePx = {
  width: Math.round(mmToPx(A4_WIDTH_MM)),
  height: Math.round(mmToPx(A4_HEIGHT_MM)),
};

/** セットバックの画素数（118 px）。 */
export const SETBACK_PX = Math.round(mmToPx(SETBACK_MM));

/** 矩形領域（画素座標、左上原点）。 */
export interface RectPx {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * 印刷可能領域（仕様書 §7.1）。
 * 2244 x 3272 px = 190.0 x 277.0 mm となることをテストで検証している。
 */
export const PRINTABLE_AREA_PX: RectPx = {
  x: SETBACK_PX,
  y: SETBACK_PX,
  width: PAGE_SIZE_PX.width - SETBACK_PX * 2,
  height: PAGE_SIZE_PX.height - SETBACK_PX * 2,
};

/** 印刷可能領域の物理サイズ（190.0 x 277.0 mm）。 */
export const PRINTABLE_AREA_MM: SizeMm = {
  widthMm: pxToMm(PRINTABLE_AREA_PX.width, OUTPUT_DPI),
  heightMm: pxToMm(PRINTABLE_AREA_PX.height, OUTPUT_DPI),
};

/**
 * 身分証カード用セルの画素サイズ（1122 x 818 px = 95.0 x 69.3 mm）。
 *
 * 端数はセル境界の重なりを避けるため切り捨てる。切り上げると最終列・最終行が
 * 印刷可能領域からはみ出しうる。
 */
export const CELL_SIZE_PX: SizePx = {
  width: Math.floor(PRINTABLE_AREA_PX.width / GRID_COLUMNS),
  height: Math.floor(PRINTABLE_AREA_PX.height / GRID_ROWS),
};

/** 身分証カード用セルの物理サイズ。 */
export const CELL_SIZE_MM: SizeMm = {
  widthMm: pxToMm(CELL_SIZE_PX.width, OUTPUT_DPI),
  heightMm: pxToMm(CELL_SIZE_PX.height, OUTPUT_DPI),
};

/**
 * ページ内 index（0..7）に対応するセル矩形を返す。
 *
 * 読み取り順は左上から右方向、次の行へ（仕様書 §7.2）。
 *
 * @param index ページ内のカード位置（0 始まり）
 * @throws index が範囲外の場合
 */
export function cellRect(index: number): RectPx {
  if (!Number.isInteger(index) || index < 0 || index >= CARDS_PER_PAGE) {
    throw new RangeError(
      `セル index は 0..${CARDS_PER_PAGE - 1} の整数である必要があります: ${index}`,
    );
  }
  const column = index % GRID_COLUMNS;
  const row = Math.floor(index / GRID_COLUMNS);
  return {
    x: PRINTABLE_AREA_PX.x + column * CELL_SIZE_PX.width,
    y: PRINTABLE_AREA_PX.y + row * CELL_SIZE_PX.height,
    width: CELL_SIZE_PX.width,
    height: CELL_SIZE_PX.height,
  };
}

/**
 * 物理サイズを保ったまま A4 上に置いたときの画素サイズを求める。
 *
 * 仕様書 §6 のとおり縦横比は変更しない。丸めは四捨五入で、
 * 1px 未満にはしない（0 幅の合成は sharp がエラーにするため）。
 */
export function physicalSizeToOutputPx(size: SizeMm): SizePx {
  return {
    width: Math.max(1, Math.round(mmToPx(size.widthMm))),
    height: Math.max(1, Math.round(mmToPx(size.heightMm))),
  };
}

/**
 * 指定サイズが枠に収まるか判定する。
 *
 * **縮小は行わない**（仕様書 §6）。収まらないものは呼び出し側で除外する。
 */
export function fitsWithin(size: SizePx, frame: SizePx): boolean {
  return size.width <= frame.width && size.height <= frame.height;
}

/** 身分証カードとしてセルに収まるか。 */
export function fitsInCell(size: SizePx): boolean {
  return fitsWithin(size, CELL_SIZE_PX);
}

/** パスポート見開きとして印刷可能領域に収まるか。 */
export function fitsInPrintableArea(size: SizePx): boolean {
  return fitsWithin(size, { width: PRINTABLE_AREA_PX.width, height: PRINTABLE_AREA_PX.height });
}

/**
 * 枠内に中央揃えで配置したときの左上座標を返す。
 *
 * 端数は切り捨てる。切り上げると右端・下端で 1px はみ出しうる。
 */
export function centerWithin(size: SizePx, frame: RectPx): { x: number; y: number } {
  return {
    x: frame.x + Math.floor((frame.width - size.width) / 2),
    y: frame.y + Math.floor((frame.height - size.height) / 2),
  };
}
