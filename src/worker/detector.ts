/**
 * カード領域の検出（仕様書 §5、README §3.2）。
 *
 * 手順:
 *   背景色推定（外周リングの Lab 中央値）
 *     -> 色差マスク（適応的閾値）
 *     -> モルフォロジー処理
 *     -> 輪郭抽出と候補評価
 *     -> 四隅決定
 *
 * 入力は必ず**プロキシ画像**（長辺 1600px）。原寸を OpenCV へ渡さないことで、
 * WASM ヒープの逼迫とアドレス空間制限を構造的に回避する（README §4.2）。
 */

import type { CandidateMetrics } from '@core/detect/scoring';
import { evaluateCandidates } from '@core/detect/scoring';
import { orderCorners, scaleQuad } from '@core/geometry/quad';
import type { DetectionStatus, Point, Quad } from '@shared/types';
import type { RawImage } from '@worker/imageIo';
import { type OpenCv, cvConstant, loadOpenCv, withMats } from '@worker/opencv';

/** 検出結果。 */
export interface DetectionOutcome {
  readonly status: DetectionStatus;
  /** 原寸座標系の四隅。検出失敗なら null */
  readonly quad: Quad | null;
  readonly confidence: number;
  readonly hasMultipleCandidates: boolean;
}

/** 背景推定に使う外周リングの幅（画像の短辺に対する比）。 */
const BORDER_RING_RATIO = 0.04;

/** 色差の最小閾値。これを下回る差は紙の地色ムラとみなす。 */
const MIN_DELTA_E_THRESHOLD = 12;

/** 適応的閾値の係数（中央値 + k * MAD）。 */
const MAD_MULTIPLIER = 3;

/** 端に接していると判定する許容画素数。 */
const EDGE_TOUCH_TOLERANCE_PX = 2;

/** 輪郭の近似精度（周長に対する比）。 */
const APPROX_EPSILON_RATIO = 0.02;

/**
 * プロキシ画像からカードの四隅を検出する。
 *
 * @param proxy 長辺 1600px のプロキシ画像（RGB）
 * @param scaleToOriginal 原寸 / プロキシ の倍率
 */
export async function detectCard(
  proxy: RawImage,
  scaleToOriginal: number,
): Promise<DetectionOutcome> {
  const cv = await loadOpenCv();

  return withMats((track) => {
    const source = track(matFromRgb(cv, proxy));
    const lab = track(new cv.Mat());
    cv.cvtColor(source, lab, cvConstant(cv.COLOR_RGB2Lab, 'COLOR_RGB2Lab'));

    const background = estimateBackgroundLab(lab.data, proxy.width, proxy.height);
    const deltaE = computeDeltaE(lab.data, proxy.width * proxy.height, background);
    const threshold = adaptiveThreshold(deltaE);

    const mask = track(maskFromDeltaE(cv, deltaE, proxy.width, proxy.height, threshold));
    applyMorphology(cv, mask, track);

    const contours = track(new cv.MatVector());
    const hierarchy = track(new cv.Mat());
    cv.findContours(
      mask,
      contours,
      hierarchy,
      cvConstant(cv.RETR_EXTERNAL, 'RETR_EXTERNAL'),
      cvConstant(cv.CHAIN_APPROX_SIMPLE, 'CHAIN_APPROX_SIMPLE'),
    );

    const candidates: { metrics: CandidateMetrics; corners: Point[] }[] = [];
    const imageArea = proxy.width * proxy.height;

    for (let i = 0; i < contours.size(); i += 1) {
      const contour = contours.get(i);
      try {
        const candidate = describeContour(cv, contour, imageArea, proxy.width, proxy.height);
        if (candidate !== null) candidates.push(candidate);
      } finally {
        contour.delete();
      }
    }

    const evaluation = evaluateCandidates(candidates.map((c) => c.metrics));
    if (evaluation.bestIndex === null) {
      return {
        status: 'failed' as const,
        quad: null,
        confidence: evaluation.bestScore,
        hasMultipleCandidates: evaluation.hasMultipleCandidates,
      };
    }

    const best = candidates[evaluation.bestIndex]!;
    return {
      status: evaluation.status,
      quad: scaleQuad(orderCorners(best.corners), scaleToOriginal),
      confidence: evaluation.bestScore,
      hasMultipleCandidates: evaluation.hasMultipleCandidates,
    };
  });
}

/** RGB の生データから OpenCV の Mat を作る。 */
function matFromRgb(cv: OpenCv, image: RawImage): InstanceType<OpenCv['Mat']> {
  if (image.channels !== 3) {
    throw new RangeError(`検出には RGB 3 チャンネルが必要です: ${image.channels}`);
  }
  const mat = new cv.Mat(image.height, image.width, cv.CV_8UC3);
  mat.data.set(image.data);
  return mat;
}

/** Lab 空間の背景色（L, a, b）。OpenCV の 8U 表現のまま保持する。 */
interface LabColor {
  readonly l: number;
  readonly a: number;
  readonly b: number;
}

/**
 * 外周リングから背景色を推定する。
 *
 * **平均ではなく中央値**を採る。カードが画像の端に接している場合、平均だと
 * カードの色が背景推定へ混入して検出が崩れるため。
 */
export function estimateBackgroundLab(
  labData: Uint8Array,
  width: number,
  height: number,
): LabColor {
  const ring = Math.max(1, Math.round(Math.min(width, height) * BORDER_RING_RATIO));
  const histograms = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
  let count = 0;

  for (let y = 0; y < height; y += 1) {
    const isVerticalBorder = y < ring || y >= height - ring;
    for (let x = 0; x < width; x += 1) {
      if (!isVerticalBorder && x >= ring && x < width - ring) {
        // 内側は背景推定に使わないので、まとめて読み飛ばす。
        x = width - ring - 1;
        continue;
      }
      const offset = (y * width + x) * 3;
      histograms[0]![labData[offset]!]! += 1;
      histograms[1]![labData[offset + 1]!]! += 1;
      histograms[2]![labData[offset + 2]!]! += 1;
      count += 1;
    }
  }

  if (count === 0) return { l: 255, a: 128, b: 128 };

  return {
    l: medianFromHistogram(histograms[0]!, count),
    a: medianFromHistogram(histograms[1]!, count),
    b: medianFromHistogram(histograms[2]!, count),
  };
}

/** ヒストグラムから中央値を求める。 */
function medianFromHistogram(histogram: Uint32Array, total: number): number {
  const target = total / 2;
  let cumulative = 0;
  for (let value = 0; value < histogram.length; value += 1) {
    cumulative += histogram[value]!;
    if (cumulative >= target) return value;
  }
  return histogram.length - 1;
}

/**
 * 各画素の背景色からの色差（CIE76 の ΔE）を求める。
 *
 * OpenCV の 8U Lab は L を 0..255 へ引き伸ばしているため、実際の ΔE 単位へ
 * 戻すには L に 100/255 を掛ける。a, b はオフセット付きだが差を取れば相殺される。
 */
export function computeDeltaE(
  labData: Uint8Array,
  pixelCount: number,
  background: LabColor,
): Float32Array {
  const result = new Float32Array(pixelCount);
  const lScale = 100 / 255;

  for (let i = 0; i < pixelCount; i += 1) {
    const offset = i * 3;
    const dl = (labData[offset]! - background.l) * lScale;
    const da = labData[offset + 1]! - background.a;
    const db = labData[offset + 2]! - background.b;
    result[i] = Math.sqrt(dl * dl + da * da + db * db);
  }

  return result;
}

/**
 * 適応的な閾値を決める（中央値 + 3 * MAD、下限 12）。
 *
 * 固定閾値では、白背景と淡色背景のどちらかで必ず破綻する。中央値と MAD は
 * 外れ値（＝カード本体）に引きずられないため、背景側の分布だけを捉えられる。
 */
export function adaptiveThreshold(deltaE: Float32Array): number {
  const histogram = new Uint32Array(256);
  for (const value of deltaE) {
    histogram[Math.min(255, Math.max(0, Math.round(value)))]! += 1;
  }

  const median = medianFromHistogram(histogram, deltaE.length);

  const deviations = new Uint32Array(256);
  for (const value of deltaE) {
    const deviation = Math.abs(Math.round(value) - median);
    deviations[Math.min(255, deviation)]! += 1;
  }
  const mad = medianFromHistogram(deviations, deltaE.length);

  return Math.max(MIN_DELTA_E_THRESHOLD, median + MAD_MULTIPLIER * mad);
}

/** 閾値を超えた画素を 255 とする 2 値マスクを作る。 */
function maskFromDeltaE(
  cv: OpenCv,
  deltaE: Float32Array,
  width: number,
  height: number,
  threshold: number,
): InstanceType<OpenCv['Mat']> {
  const mat = new cv.Mat(height, width, cv.CV_8UC1);
  const buffer = mat.data;
  for (let i = 0; i < deltaE.length; i += 1) {
    buffer[i] = deltaE[i]! > threshold ? 255 : 0;
  }
  return mat;
}

/**
 * モルフォロジー処理でマスクを整える。
 *
 * close で文字や印影による内部の穴を埋め、open で背景の細かなノイズを落とす。
 * この順序が重要で、逆にすると先にカードの縁が痩せてしまう。
 */
function applyMorphology(
  cv: OpenCv,
  mask: InstanceType<OpenCv['Mat']>,
  track: <M extends { delete: () => void }>(mat: M) => M,
): void {
  const closeKernel = track(
    cv.getStructuringElement(cvConstant(cv.MORPH_RECT, 'MORPH_RECT'), new cv.Size(5, 5)),
  );
  const openKernel = track(
    cv.getStructuringElement(cvConstant(cv.MORPH_RECT, 'MORPH_RECT'), new cv.Size(3, 3)),
  );

  cv.morphologyEx(mask, mask, cv.MORPH_CLOSE, closeKernel);
  cv.morphologyEx(mask, mask, cv.MORPH_OPEN, openKernel);
}

/**
 * 輪郭から候補の計測値と四隅を作る。候補にならない輪郭は null。
 */
function describeContour(
  cv: OpenCv,
  contour: InstanceType<OpenCv['Mat']>,
  imageArea: number,
  width: number,
  height: number,
): { metrics: CandidateMetrics; corners: Point[] } | null {
  const contourArea = cv.contourArea(contour);
  if (contourArea <= 0) return null;

  const rotatedRect = cv.minAreaRect(contour);
  const rectWidth = rotatedRect.size.width;
  const rectHeight = rotatedRect.size.height;
  if (rectWidth <= 0 || rectHeight <= 0) return null;

  const longSide = Math.max(rectWidth, rectHeight);
  const shortSide = Math.min(rectWidth, rectHeight);

  const corners = resolveCorners(cv, contour, rotatedRect);
  const metrics: CandidateMetrics = {
    contourArea,
    minAreaRectArea: rectWidth * rectHeight,
    aspectRatio: longSide / shortSide,
    imageArea,
    edgeTouchCount: countEdgeTouches(corners, width, height),
  };

  return { metrics, corners };
}

/**
 * 四隅を決める。
 *
 * まず輪郭の多角形近似を試し、4 点に落ちればそれを使う（台形歪みを保持できる）。
 * 4 点にならなければ最小外接矩形の頂点へフォールバックする。
 */
function resolveCorners(
  cv: OpenCv,
  contour: InstanceType<OpenCv['Mat']>,
  rotatedRect: ReturnType<OpenCv['minAreaRect']>,
): Point[] {
  const approx = new cv.Mat();
  try {
    const perimeter = cv.arcLength(contour, true);
    cv.approxPolyDP(contour, approx, APPROX_EPSILON_RATIO * perimeter, true);

    if (approx.rows === 4) {
      const data = approx.data32S;
      const points: Point[] = [];
      for (let i = 0; i < 4; i += 1) {
        points.push({ x: data[i * 2]!, y: data[i * 2 + 1]! });
      }
      return points;
    }
  } finally {
    approx.delete();
  }

  return rotatedRectCorners(rotatedRect);
}

/**
 * 最小外接矩形の 4 頂点を求める。
 *
 * `cv.boxPoints` の有無が opencv.js のビルドに依存するため、
 * 中心・サイズ・角度から自前で計算して依存を避ける。
 */
export function rotatedRectCorners(rect: {
  center: { x: number; y: number };
  size: { width: number; height: number };
  angle: number;
}): Point[] {
  const radians = (rect.angle * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const halfWidth = rect.size.width / 2;
  const halfHeight = rect.size.height / 2;

  return (
    [
      [-halfWidth, -halfHeight],
      [halfWidth, -halfHeight],
      [halfWidth, halfHeight],
      [-halfWidth, halfHeight],
    ] as const
  ).map(([x, y]) => ({
    x: rect.center.x + x * cos - y * sin,
    y: rect.center.y + x * sin + y * cos,
  }));
}

/** 四隅のうち、画像の端に接している辺の数を数える（0..4）。 */
export function countEdgeTouches(corners: readonly Point[], width: number, height: number): number {
  const xs = corners.map((p) => p.x);
  const ys = corners.map((p) => p.y);

  let touches = 0;
  if (Math.min(...xs) <= EDGE_TOUCH_TOLERANCE_PX) touches += 1;
  if (Math.min(...ys) <= EDGE_TOUCH_TOLERANCE_PX) touches += 1;
  if (Math.max(...xs) >= width - 1 - EDGE_TOUCH_TOLERANCE_PX) touches += 1;
  if (Math.max(...ys) >= height - 1 - EDGE_TOUCH_TOLERANCE_PX) touches += 1;
  return touches;
}
