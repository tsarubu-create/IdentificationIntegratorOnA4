import type { EditTask, EditTaskResult } from '@shared/workerProtocol';
import { canEditImage, manualQuad } from '@core/geometry/manualAdjustment';
import { quadAngle, quadCenter, scaleQuad } from '@core/geometry/quad';
import { checkLimits } from '@core/limits/guard';
import { OFFICIAL_SIZE_MM } from '@core/standards/documentSizes';
import { resolvePlacement } from '@core/layout/placement';
import { cropQuad } from '@core/standards/officialCrop';
import { createDetectionProxy, encodeThumbnail, readHeader, rawToWebp } from '@worker/imageIo';
import { cropPreview } from '@worker/analyze';
import { rotate90 } from '@worker/warp';

function detached(bytes: Buffer): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/** 入力の読み取りとプレビューだけを行う。編集時にA4ファイルは作らない。 */
export async function editImage(task: EditTask): Promise<EditTaskResult> {
  const previous = task.analysis;
  if (!canEditImage(previous.image)) throw new Error('この画像は編集できません');
  const header = await readHeader(task.filePath);
  if (checkLimits({ fileBytes: header.fileBytes, width: header.width, height: header.height }))
    throw new Error('画像が安全上限を超えています');
  if (header.width !== previous.sourceWidth || header.height !== previous.sourceHeight)
    throw new Error('元画像の寸法が変わりました。再解析してください');
  const proxy = await createDetectionProxy(task.filePath, previous.ignoreIcc);
  const center = previous.quad
    ? quadCenter(previous.quad)
    : { x: header.width / 2, y: header.height / 2 };
  const angle = previous.quad ? (quadAngle(previous.quad) * 180) / Math.PI : 0;
  const adjustment = task.adjustment ?? {
    centerX: center.x,
    centerY: center.y,
    angleDegrees: Math.max(-90, Math.min(90, angle)),
  };
  const preview = {
    bytes: detached(await rawToWebp(proxy)),
    sourceWidth: header.width,
    sourceHeight: header.height,
    effectiveDpi: previous.image.effectiveDpi,
    adjustment,
  };
  if (task.adjustment === null) return { preview, updated: null };
  const quad = manualQuad(task.adjustment, task.kind, previous.image.effectiveDpi, header);
  const size = OFFICIAL_SIZE_MM[task.kind];
  const placement = resolvePlacement(size, task.kind);
  const previewQuad = scaleQuad(
    cropQuad(quad, placement.cropSizeMm, previous.image.effectiveDpi),
    1 / proxy.scaleToOriginal,
  );
  const cropped = await cropPreview(proxy, previewQuad);
  const thumbnail = detached(
    await encodeThumbnail(task.kind === 'passportSpread' ? await rotate90(cropped) : cropped),
  );
  return {
    preview,
    updated: {
      ...previous,
      quad,
      image: {
        ...previous.image,
        kind: task.kind,
        status: 'detected',
        confidence: null,
        cardSizeMm: size,
        physicalSize: placement.sizeMm,
        exclusion: placement.exclusion,
        warnings: [
          ...previous.image.warnings.filter((w) => w === 'dpiMissing' || w === 'iccIgnored'),
          'manualAdjustment',
        ],
        thumbnail,
      },
    },
  };
}
