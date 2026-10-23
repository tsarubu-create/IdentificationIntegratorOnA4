import type { AnalyzedImage, DocumentKind, ManualAdjustment, Quad, SizePx } from '@shared/types';
import { quadFromCenter, quadToArray } from '@core/geometry/quad';
import { OFFICIAL_SIZE_MM } from '@core/standards/documentSizes';
import { mmToPx } from '@core/layout/a4';

/** 読み取り不能・安全上限超過の画像を編集へ回さない。 */
export function canEditImage(image: AnalyzedImage): boolean {
  return (
    image.thumbnail !== null &&
    (image.exclusion === null ||
      ['detectionFailed', 'doesNotFitCell', 'doesNotFitPrintableArea'].includes(image.exclusion))
  );
}

export function recommendsEditing(image: AnalyzedImage): boolean {
  return (
    canEditImage(image) &&
    !image.warnings.includes('manualAdjustment') &&
    (image.status !== 'detected' || image.warnings.includes('nonStandardSize'))
  );
}

/** 画面とworkerで同じ検査を通し、規格寸法の四隅を作る。 */
export function manualQuad(
  adjustment: ManualAdjustment,
  kind: DocumentKind,
  dpi: number,
  bounds: SizePx,
): Quad {
  if (
    ![
      adjustment.centerX,
      adjustment.centerY,
      adjustment.angleDegrees,
      dpi,
      bounds.width,
      bounds.height,
    ].every(Number.isFinite) ||
    dpi <= 0 ||
    bounds.width <= 0 ||
    bounds.height <= 0 ||
    Math.abs(adjustment.angleDegrees) > 90 ||
    (kind !== 'idCard' && kind !== 'passportSpread')
  )
    throw new RangeError('切り出し位置または角度が不正です');
  const size = OFFICIAL_SIZE_MM[kind];
  const quad = quadFromCenter(
    { x: adjustment.centerX, y: adjustment.centerY },
    (adjustment.angleDegrees * Math.PI) / 180,
    { width: mmToPx(size.widthMm, dpi), height: mmToPx(size.heightMm, dpi) },
  );
  if (
    quadToArray(quad).some((p) => p.x < 0 || p.y < 0 || p.x > bounds.width || p.y > bounds.height)
  )
    throw new RangeError('券面の枠全体が元画像に入る位置へ移動してください');
  return quad;
}
