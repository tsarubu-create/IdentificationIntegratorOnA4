/**
 * 規格値に基づく切り出し領域の確定（仕様書 §6）。
 *
 * 縁検出は「どこにあるか・どれだけ傾いているか」を決めるのに使い、
 * **大きさは規格値から与える**。券面のきわの陰影は淡く、縁検出だけでは
 * 撮影条件ごとに 1mm 前後ぶれるが、対象書類のサイズは規格で一定だからである。
 */

import type { DocumentKind, Quad, SizeMm } from '@shared/types';
import { mmToPx } from '@core/layout/a4';
import { quadAngle, quadCenter, quadFromCenter, warpTargetSize } from '@core/geometry/quad';
import { matchOfficialSize } from '@core/standards/documentSizes';

/**
 * 切り出し枠に付ける余白（片側、ミリ）。
 *
 * 規格ちょうどの枠を置くと、中心のわずかな偏りがそのまま見切れになる。
 * 実測では検出中心が券面の真の中心から 0.6mm ずれており、規格ちょうどでは
 * 片側が 0.6mm 削れていた。
 *
 * 余白は**配置サイズにも同じだけ加える**ため、券面そのものは規格どおりの
 * 大きさで印刷される。白地の上の白い余白なので視認できない一方、
 * 見切れは明確な欠陥になる。非対称な誤差を吸収できるよう片側 1mm とした。
 */
export const CROP_BLEED_MM = 1;

/** 規格値へ合わせた切り出し結果。 */
export interface OfficialCrop {
  /** 切り出しに使う四隅（規格値＋余白の大きさ、検出した中心と傾き） */
  readonly quad: Quad;
  /** A4 上へ配置する物理サイズ（規格値＋余白） */
  readonly sizeMm: SizeMm;
  /** 券面そのものの物理サイズ（規格値。確認画面の表示に使う） */
  readonly cardSizeMm: SizeMm;
  /** 規格値へ合わせたか。false なら実測値のまま */
  readonly matched: boolean;
  /** 実測が規格値から何 % ずれていたか */
  readonly deviation: number;
}

/**
 * 検出した四隅を、規格値の大きさへ揃えた四隅に置き換える。
 *
 * - 中心と傾きは検出結果をそのまま使う
 * - 大きさは規格値（`kind` に対応する確定寸法）を画素へ換算して使う
 * - 実測が規格値から大きく外れる場合は規格外の書類とみなし、実測のまま返す
 *
 * 規格値のほうが実測より大きい場合、切り出し枠は外側へ広がる。券面のきわの
 * 陰影を取り逃していても見切れないのはこのためである。
 *
 * @param detected 縁検出から得た四隅（原寸座標）
 * @param kind 利用者が選択した書類種別
 * @param dpi 画像に適用する解像度
 */
export function officialCrop(detected: Quad, kind: DocumentKind, dpi: number): OfficialCrop {
  const measuredPx = warpTargetSize(detected);
  const measuredMm: SizeMm = {
    widthMm: (measuredPx.width / dpi) * 25.4,
    heightMm: (measuredPx.height / dpi) * 25.4,
  };

  const match = matchOfficialSize(measuredMm, kind);
  if (!match.matched) {
    // 規格外の書類は実測のまま扱う。余白も付けない（基準が無いため）。
    return {
      quad: detected,
      sizeMm: measuredMm,
      cardSizeMm: measuredMm,
      matched: false,
      deviation: match.deviation,
    };
  }

  // 規格値に余白を加えたものが、切り出し枠かつ配置サイズになる。
  const withBleed: SizeMm = {
    widthMm: match.size.widthMm + CROP_BLEED_MM * 2,
    heightMm: match.size.heightMm + CROP_BLEED_MM * 2,
  };
  const sizePx = {
    width: Math.max(1, Math.round(mmToPx(withBleed.widthMm, dpi))),
    height: Math.max(1, Math.round(mmToPx(withBleed.heightMm, dpi))),
  };

  return {
    quad: quadFromCenter(quadCenter(detected), quadAngle(detected), sizePx),
    sizeMm: withBleed,
    cardSizeMm: match.size,
    matched: true,
    deviation: match.deviation,
  };
}
