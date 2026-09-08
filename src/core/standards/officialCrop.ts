/**
 * 規格値に基づく券面サイズの確定と、切り出し領域の組み立て（仕様書 §2 / §6）。
 *
 * 縁検出は「**どこにあるか・どれだけ傾いているか**」を決めるのに使い、
 * **券面の大きさは規格値から与える**。券面のきわの陰影は淡く、縁検出だけでは
 * 撮影条件ごとに 1mm 前後ぶれるが、対象書類のサイズは規格で一定だからである。
 *
 * 切り出す領域そのものは券面ぴったりではなく、**配置枠（セル）と同じ大きさ**を
 * 中心のまわりから取る。理由は `@core/layout/placement` の説明を参照。
 */

import type { DocumentKind, Quad, SizeMm } from '@shared/types';
import { mmToPx } from '@core/layout/a4';
import { quadAngle, quadCenter, quadFromCenter, warpTargetSize } from '@core/geometry/quad';
import { matchOfficialSize } from '@core/standards/documentSizes';

/** 券面サイズの確定結果。 */
export interface CardSize {
  /** 券面の物理サイズ（規格値と一致すればその確定値） */
  readonly sizeMm: SizeMm;
  /** 規格値へ合わせたか。false なら実測値のまま */
  readonly matched: boolean;
  /** 実測が規格値から何 % ずれていたか */
  readonly deviation: number;
}

/**
 * 検出した四隅の実測寸法を、規格値と突き合わせて券面サイズを確定する。
 *
 * 実測が規格値から大きく外れる場合は規格外の書類とみなし、実測のまま返す。
 *
 * @param detected 縁検出から得た四隅（原寸座標）
 * @param kind 利用者が選択した書類種別
 * @param dpi 画像に適用する解像度
 */
export function resolveCardSize(detected: Quad, kind: DocumentKind, dpi: number): CardSize {
  const measuredPx = warpTargetSize(detected);
  const measuredMm: SizeMm = {
    widthMm: (measuredPx.width / dpi) * 25.4,
    heightMm: (measuredPx.height / dpi) * 25.4,
  };

  const match = matchOfficialSize(measuredMm, kind);
  return { sizeMm: match.size, matched: match.matched, deviation: match.deviation };
}

/**
 * 元画像から切り出す四隅を組み立てる。
 *
 * **中心と傾きは検出結果、大きさは配置枠**から取る。券面の縁を当てにいかないため、
 * 縁の位置推定の誤差が見切れに直結しない。枠が元画像からはみ出す場合は
 * 呼び出し側（`warpQuad`）が白で埋める。
 *
 * @param detected 縁検出から得た四隅（原寸座標）
 * @param cropSizeMm 切り出す領域の物理サイズ（回転前）
 * @param dpi 画像に適用する解像度
 */
export function cropQuad(detected: Quad, cropSizeMm: SizeMm, dpi: number): Quad {
  const sizePx = {
    width: Math.max(1, Math.round(mmToPx(cropSizeMm.widthMm, dpi))),
    height: Math.max(1, Math.round(mmToPx(cropSizeMm.heightMm, dpi))),
  };
  return quadFromCenter(quadCenter(detected), quadAngle(detected), sizePx);
}
