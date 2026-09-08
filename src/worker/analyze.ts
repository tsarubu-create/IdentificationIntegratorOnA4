/**
 * 1 枚の入力画像を解析して、確認画面に出す情報を作る（仕様書 §5 / §6 / §8 / §9）。
 *
 * 方針:
 * - 上限判定は復号前に行う。超過しても**停止せず**、その画像だけを除外する。
 * - 検出した四隅は保持するが、**切り出した画像はここでは保持しない**。
 *   出力時に再度切り出すことで、確認画面に何十枚並んでもメモリが膨らまない。
 * - 例外は握りつぶさず、必ず除外理由コードへ変換して呼び出し側へ返す。
 */

import { FALLBACK_DPI } from '@shared/limits';
import type { AnalyzedImage, ExclusionReason, Quad, WarningCode } from '@shared/types';
import { normalizeDpi, physicalSize } from '@core/dpi/dpi';
import { checkLimits } from '@core/limits/guard';
import { resolvePlacement } from '@core/layout/placement';
import { warpTargetSize } from '@core/geometry/quad';
import { detectCard } from '@worker/detector';
import { createDetectionProxy, encodeThumbnailFromFile, readHeader } from '@worker/imageIo';

/** 解析の入力。 */
export interface AnalyzeRequest {
  /** ジョブ内で一意な識別子 */
  readonly id: string;
  /** 読み取る画像の絶対パス。**この module は読み取りしか行わない** */
  readonly filePath: string;
  /** 入力ルートからの相対パス（表示・ログ用） */
  readonly relativePath: string;
}

/**
 * 解析結果。`image` は確認画面へ渡す表示用データ、それ以外は出力時に使う内部情報。
 */
export interface ImageAnalysis {
  readonly image: AnalyzedImage;
  /** 原寸座標系の四隅。検出できなければ null */
  readonly quad: Quad | null;
  /** ICC を無視して読む必要があったか（出力時も同じ条件で読む） */
  readonly ignoreIcc: boolean;
}

/**
 * 画像 1 枚を解析する。
 *
 * 例外を投げない。失敗はすべて `exclusion` として結果に載せる。
 * 1 枚の失敗でジョブ全体が止まらないようにするため（仕様書 §3）。
 */
export async function analyzeImage(request: AnalyzeRequest): Promise<ImageAnalysis> {
  const warnings: WarningCode[] = [];

  let header;
  try {
    header = await readHeader(request.filePath);
  } catch {
    return excluded(request, 'decodeFailed', warnings);
  }

  if (header.width <= 0 || header.height <= 0) {
    return excluded(request, 'unsupportedFormat', warnings);
  }

  // 復号前に上限を判定する（圧縮爆弾を展開しないための第一の防壁）。
  const violation = checkLimits({
    fileBytes: header.fileBytes,
    width: header.width,
    height: header.height,
  });
  if (violation !== null) {
    return {
      image: {
        ...baseImage(request),
        embeddedDpi: header.density,
        effectiveDpi: normalizeDpi(header.density).effectiveDpi,
        exclusion: violation.reason,
        limitViolation: violation,
        warnings,
      },
      quad: null,
      ignoreIcc: false,
    };
  }

  const dpi = normalizeDpi(header.density);
  if (dpi.isFallback) warnings.push('dpiMissing');

  // ICC が壊れている画像があるため、1 回目で失敗したら ICC を無視して再試行する。
  let proxy;
  let ignoreIcc = false;
  try {
    proxy = await createDetectionProxy(request.filePath, false);
  } catch {
    try {
      proxy = await createDetectionProxy(request.filePath, true);
      ignoreIcc = true;
      warnings.push('iccIgnored');
    } catch {
      return excluded(request, 'decodeFailed', warnings, dpi.embeddedDpi, dpi.effectiveDpi);
    }
  }

  const detection = await detectCard(proxy, proxy.scaleToOriginal);

  if (detection.hasMultipleCandidates) warnings.push('multipleCandidates');
  if (detection.status === 'needsReview' && !detection.hasMultipleCandidates) {
    warnings.push('lowConfidence');
  }

  const thumbnail = await safeThumbnail(request.filePath, ignoreIcc);

  if (detection.quad === null) {
    return {
      image: {
        ...baseImage(request),
        status: 'failed',
        embeddedDpi: dpi.embeddedDpi,
        effectiveDpi: dpi.effectiveDpi,
        confidence: detection.confidence,
        exclusion: 'detectionFailed',
        warnings,
        thumbnail,
      },
      quad: null,
      ignoreIcc,
    };
  }

  const cardSizePx = warpTargetSize(detection.quad);
  const cardSizeMm = physicalSize(cardSizePx, dpi.effectiveDpi);
  // 既定の種別（身分証カード）で収まるかを判定する。
  // 利用者が確認画面で種別を変えた場合は、UI 側が同じ関数で再計算する。
  const placement = resolvePlacement(cardSizeMm, 'idCard');

  return {
    image: {
      ...baseImage(request),
      status: detection.status,
      embeddedDpi: dpi.embeddedDpi,
      effectiveDpi: dpi.effectiveDpi,
      physicalSize: cardSizeMm,
      confidence: detection.confidence,
      exclusion: placement.exclusion,
      warnings,
      thumbnail,
    },
    quad: detection.quad,
    ignoreIcc,
  };
}

/** 解析結果の共通部分。 */
function baseImage(request: AnalyzeRequest): AnalyzedImage {
  return {
    id: request.id,
    relativePath: request.relativePath,
    status: 'failed',
    embeddedDpi: null,
    effectiveDpi: FALLBACK_DPI,
    physicalSize: null,
    confidence: null,
    warnings: [],
    exclusion: null,
    limitViolation: null,
    kind: 'idCard',
    thumbnail: null,
  };
}

/** 除外として解析を打ち切る。 */
function excluded(
  request: AnalyzeRequest,
  reason: ExclusionReason,
  warnings: readonly WarningCode[],
  embeddedDpi: number | null = null,
  effectiveDpi: number = FALLBACK_DPI,
): ImageAnalysis {
  return {
    image: { ...baseImage(request), embeddedDpi, effectiveDpi, exclusion: reason, warnings },
    quad: null,
    ignoreIcc: false,
  };
}

/**
 * サムネイル生成は失敗しても致命的でない。
 *
 * 確認画面の見た目が欠けるだけで、検出結果や出力の正しさには影響しないため、
 * ここでの例外は握りつぶして null を返す。
 */
async function safeThumbnail(filePath: string, ignoreIcc: boolean): Promise<ArrayBuffer | null> {
  try {
    const webp = await encodeThumbnailFromFile(filePath, ignoreIcc);
    // Buffer は共有プールの一部を指すことがあるため、必ず該当範囲だけを切り出す。
    return webp.buffer.slice(webp.byteOffset, webp.byteOffset + webp.byteLength) as ArrayBuffer;
  } catch {
    return null;
  }
}
