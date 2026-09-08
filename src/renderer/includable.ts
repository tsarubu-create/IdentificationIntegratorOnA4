/**
 * 「この画像は出力対象か」の判定（仕様書 §6 / §8）。
 *
 * 除外理由には 2 種類ある。
 * - 種別に依らないもの（上限超過・復号失敗・検出失敗）: 解析時に確定する
 * - 種別で変わるもの（枠に収まらない）: 確認画面で種別を選び直すと変わる
 *
 * 前者だけで判定すると、パスポート見開きを選び直しても除外扱いのままになる。
 * 判定をこの 1 か所に集約し、行の表示・件数・出力ボタンの活性が食い違わないようにする。
 */

import type { AnalyzedImage, DocumentKind, ExclusionReason } from '@shared/types';
import { resolvePlacement } from '@core/layout/placement';

/** 種別を変えても解消しない除外理由。 */
function isKindIndependent(reason: ExclusionReason): boolean {
  return reason !== 'doesNotFitCell' && reason !== 'doesNotFitPrintableArea';
}

/**
 * 選択中の種別における除外理由を返す。出力対象なら null。
 */
export function resolveExclusion(image: AnalyzedImage, kind: DocumentKind): ExclusionReason | null {
  if (image.exclusion !== null && isKindIndependent(image.exclusion)) return image.exclusion;
  if (image.physicalSize === null) return image.exclusion;

  return resolvePlacement(image.physicalSize, kind).exclusion;
}

/** 選択中の種別を反映した、出力対象の件数。 */
export function countIncludable(
  images: readonly AnalyzedImage[],
  kinds: Readonly<Record<string, DocumentKind>>,
): number {
  return images.filter((image) => resolveExclusion(image, kinds[image.id] ?? 'idCard') === null)
    .length;
}
