/**
 * 書類種別ごとの配置サイズと収まり判定（仕様書 §6 / §7）。
 *
 * 切り出したカードの物理サイズは種別に依らないが、**A4 上での配置**は種別で変わる。
 * パスポート見開きは 90 度回転してから印刷可能領域へ置くため、幅と高さが入れ替わる。
 */

import type { DocumentKind, ExclusionReason, SizeMm, SizePx } from '@shared/types';
import { swapSize } from '@core/dpi/dpi';
import { fitsInCell, fitsInPrintableArea, physicalSizeToOutputPx } from '@core/layout/a4';

/** 配置の解決結果。 */
export interface Placement {
  /** A4 上での物理サイズ（回転を反映済み） */
  readonly sizeMm: SizeMm;
  /** A4 上での画素サイズ（300dpi 換算） */
  readonly sizePx: SizePx;
  /** 90 度回転が必要か（パスポート見開き） */
  readonly requiresRotation: boolean;
  /** 枠に収まるか。収まらない場合は出力対象から除外する */
  readonly fits: boolean;
  /** 収まらない場合の理由。収まる場合は null */
  readonly exclusion: ExclusionReason | null;
}

/**
 * 切り出したカードの物理サイズから、A4 上の配置を決める。
 *
 * **縮小は行わない**（仕様書 §6）。収まらない場合は理由付きで除外対象とする。
 *
 * @param cardSize 切り出した領域の物理サイズ（回転前）
 * @param kind 利用者が確認画面で選択した書類種別
 */
export function resolvePlacement(cardSize: SizeMm, kind: DocumentKind): Placement {
  const requiresRotation = kind === 'passportSpread';
  const sizeMm = requiresRotation ? swapSize(cardSize) : cardSize;
  const sizePx = physicalSizeToOutputPx(sizeMm);

  const fits = requiresRotation ? fitsInPrintableArea(sizePx) : fitsInCell(sizePx);
  const exclusion: ExclusionReason | null = fits
    ? null
    : requiresRotation
      ? 'doesNotFitPrintableArea'
      : 'doesNotFitCell';

  return { sizeMm, sizePx, requiresRotation, fits, exclusion };
}
