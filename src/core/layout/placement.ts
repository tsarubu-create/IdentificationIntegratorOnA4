/**
 * 書類種別ごとの配置（タイル）の決定と収まり判定（仕様書 §6 / §7）。
 *
 * ## 方針: 券面の縁ではなく「枠いっぱい」を切り出す
 *
 * 当初は券面の縁ちょうどで切り出していたが、この方式は**縁の位置推定の誤差が
 * そのまま見切れになる**。券面のきわの陰影は淡く、推定が 1mm ずれれば 1mm 欠ける。
 * 許容誤差が実質ゼロの設計であり、実機で左右非対称の見切れが繰り返し発生した。
 *
 * そこで、**配置枠（セル）と同じ大きさの領域を元画像から切り出す**方式に改めた。
 * 必要な精度が「縁」ではなく「**中心**」だけになるため、許容誤差が桁で広がる。
 *
 * - 身分証カード: セル 95.0 x 69.3mm に対し券面 85.6 x 53.98mm
 *   -> 中心が左右 ±4.7mm / 上下 ±7.6mm ずれても券面は完全に収まる
 * - タイルはセル寸法ちょうどなので、隣接タイルと接しても**重ならない**
 *   （仕様書 §7.1「配置対象は重ねない」を満たす。タイル間の隙間は不要）
 *
 * 券面のまわりには元画像の背景が入るが、スキャナ背景は白であり、
 * 白い A4 ページ上では視認できない。見切れは明確な欠陥である一方、
 * 背景が少し写り込むことに実害はない、という安全側の判断による。
 */

import type { DocumentKind, ExclusionReason, SizeMm, SizePx } from '@shared/types';
import { swapSize } from '@core/dpi/dpi';
import {
  CELL_SIZE_MM,
  CELL_SIZE_PX,
  PRINTABLE_AREA_MM,
  PRINTABLE_AREA_PX,
  fitsWithin,
  physicalSizeToOutputPx,
} from '@core/layout/a4';

/** 配置の解決結果。 */
export interface Placement {
  /** A4 上に置くタイルの物理サイズ（＝枠の大きさ。回転を反映済み） */
  readonly sizeMm: SizeMm;
  /** A4 上に置くタイルの画素サイズ（300dpi 換算） */
  readonly sizePx: SizePx;
  /**
   * 元画像から切り出す領域の物理サイズ（**回転前**）。
   *
   * パスポート見開きは切り出した後に 90 度回転するため、
   * 回転後に枠へ一致するよう、切り出し時点では幅と高さが入れ替わる。
   */
  readonly cropSizeMm: SizeMm;
  /** 90 度回転が必要か（パスポート見開き） */
  readonly requiresRotation: boolean;
  /** 券面が枠に収まるか。収まらない場合は出力対象から除外する */
  readonly fits: boolean;
  /** 収まらない場合の理由。収まる場合は null */
  readonly exclusion: ExclusionReason | null;
}

/**
 * 券面の物理サイズから、A4 上のタイルと切り出し領域を決める。
 *
 * **縮小は行わない**（仕様書 §6）。券面が枠に収まらない場合は理由付きで除外する。
 * 収まる場合、タイルは常に枠いっぱいの大きさになる。
 *
 * @param cardSize 券面の物理サイズ（規格値。回転前）
 * @param kind 利用者が確認画面で選択した書類種別
 */
export function resolvePlacement(cardSize: SizeMm, kind: DocumentKind): Placement {
  const requiresRotation = kind === 'passportSpread';

  // 枠（＝タイル）の大きさ。カードはセル、パスポート見開きは印刷可能領域。
  const frameMm = requiresRotation ? PRINTABLE_AREA_MM : CELL_SIZE_MM;
  const framePx = requiresRotation ? PRINTABLE_AREA_PX : CELL_SIZE_PX;

  // 収まり判定は「券面」で行う。枠いっぱいに切り出すこととは独立の判断。
  const cardOnPage = requiresRotation ? swapSize(cardSize) : cardSize;
  const fits = fitsWithin(physicalSizeToOutputPx(cardOnPage), framePx);

  const exclusion: ExclusionReason | null = fits
    ? null
    : requiresRotation
      ? 'doesNotFitPrintableArea'
      : 'doesNotFitCell';

  return {
    sizeMm: { widthMm: frameMm.widthMm, heightMm: frameMm.heightMm },
    sizePx: { width: framePx.width, height: framePx.height },
    // 回転する場合、切り出しは回転前の向きで行うため縦横を入れ替える。
    cropSizeMm: requiresRotation ? swapSize(frameMm) : frameMm,
    requiresRotation,
    fits,
    exclusion,
  };
}
