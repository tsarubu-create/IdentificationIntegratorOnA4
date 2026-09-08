/**
 * 安全上限の判定（仕様書 §9）。
 *
 * **復号する前に**メタデータだけで判定することが重要。ヘッダのみを読んで弾けば、
 * 圧縮爆弾を一度も展開せずに除外できる。
 */

import { MAX_FILE_BYTES, MAX_SIDE_PX, MAX_TOTAL_PX } from '@shared/limits';
import type { LimitViolation } from '@shared/types';

/** 上限判定に必要な最小限のメタデータ。 */
export interface ImageHeaderInfo {
  readonly fileBytes: number;
  readonly width: number;
  readonly height: number;
}

/**
 * 上限超過を判定する。超過していなければ null。
 *
 * 判定順はファイルサイズ → 辺長 → 総画素数。復号コストが軽い順ではなく、
 * **利用者にとって対処しやすい順**に並べている（ファイルサイズが最も分かりやすい）。
 */
export function checkLimits(info: ImageHeaderInfo): LimitViolation | null {
  if (info.fileBytes > MAX_FILE_BYTES) {
    return { reason: 'fileTooLarge', actual: info.fileBytes, limit: MAX_FILE_BYTES };
  }

  const longestSide = Math.max(info.width, info.height);
  if (longestSide > MAX_SIDE_PX) {
    return { reason: 'sideTooLarge', actual: longestSide, limit: MAX_SIDE_PX };
  }

  const totalPixels = info.width * info.height;
  if (totalPixels > MAX_TOTAL_PX) {
    return { reason: 'tooManyPixels', actual: totalPixels, limit: MAX_TOTAL_PX };
  }

  return null;
}

/**
 * 上限を満たすために必要な、再スキャン時の最大 DPI を求める（仕様書 §9 の「利用者がとれる対応」）。
 *
 * 現在の画素数と DPI から実寸を逆算し、総画素数の上限に収まる DPI を返す。
 * 100 dpi 単位へ切り下げるのは、スキャナの設定値が段階的なため。
 *
 * @returns 推奨 DPI。算出できない場合は null
 */
export function suggestedRescanDpi(info: ImageHeaderInfo, currentDpi: number): number | null {
  const totalPixels = info.width * info.height;
  if (totalPixels <= 0 || !Number.isFinite(currentDpi) || currentDpi <= 0) return null;

  // 画素数は DPI の 2 乗に比例する。
  const ratio = Math.sqrt(MAX_TOTAL_PX / totalPixels);
  const suggested = Math.floor((currentDpi * ratio) / 100) * 100;
  return suggested >= 100 ? suggested : null;
}
