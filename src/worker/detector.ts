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
import { orderCorners, polygonArea, scaleQuad } from '@core/geometry/quad';
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

/**
 * 色差の最小閾値。
 *
 * 実機のフラットベッドスキャン（300dpi）で背景の ΔE 分布を実測した結果、
 * p50=1.3 / p90=3.1 / p99=5.2 だった。閾値 2〜3 では被覆率が 60% に達して
 * 用紙全体を拾ってしまうため下限は必要だが、**4 で十分**である。
 *
 * 当初は 12 としていたが、これは実測の背景ノイズの 2 倍以上にあたる過大な値だった。
 * 日本の身分証（運転免許証・マイナンバーカード）は券面がほぼ白く、白い
 * スキャナ背景との色差が 12 に届かない。その結果、写真や文字など濃い部分だけが
 * マスクに残り、**券面ではなく印刷部分の外接矩形**が検出されて見切れていた
 * （実測: 矩形度 0.60、高さが実寸より 18.6% 不足）。
 */
const MIN_DELTA_E_THRESHOLD = 4;

/**
 * 色差の最大閾値。
 *
 * 外周に影やムラがあると MAD が大きくなり、閾値が実在のカードとの色差を
 * 上回ってしまう。淡色のカードでも ΔE 35 程度は背景と差が出るため、そこで頭打ちにする。
 */
const MAX_DELTA_E_THRESHOLD = 35;

/**
 * MAD から標準偏差相当へ換算する係数（正規分布を仮定した標準的な値）。
 *
 * MAD は外れ値に強い代わりに分布の裾を過小評価する。実測では
 * median + 3*MAD = 2.7 に対して背景の p99 は 5.2 であり、MAD をそのまま
 * 使うと閾値が背景ノイズの裾を下回ってしまう。
 */
const MAD_TO_SIGMA = 1.4826;

/**
 * 閾値に用いるシグマの倍数。
 *
 * `median + 6*sigma` は実測で 5.6 となり、矩形度 0.98・寸法誤差 +2.6% という
 * 最良の結果を与えた。パーセンタイルを直接使わないのは、カードが画像の端に
 * 接して外周リングへ写り込んだときに裾が汚染されるため。中央値と MAD は
 * 5 割までの混入に耐える。
 */
const SIGMA_MULTIPLIER = 6;

/** 閾値統計で使うヒストグラムの分解能（1 単位あたりのバケット数）。 */
const HISTOGRAM_RESOLUTION = 10;

/** ヒストグラムのバケット数（ΔE 0〜255 を 0.1 刻みで表現する）。 */
const HISTOGRAM_BUCKETS = 256 * HISTOGRAM_RESOLUTION;

/** 端に接していると判定する許容画素数。 */
const EDGE_TOUCH_TOLERANCE_PX = 2;

/**
 * 輪郭の近似精度（周長に対する比）。
 *
 * 0.02 では原寸換算で 5mm 以上ずれうる。丸角を潰すには十分な粗さが要るが、
 * 券面を削らない程度に抑える必要があるため 0.01 とした。
 */
const APPROX_EPSILON_RATIO = 0.01;

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

    const ringIndices = borderRingIndices(proxy.width, proxy.height);
    const background = estimateBackgroundLab(lab.data, proxy.width, proxy.height);
    const deltaE = computeDeltaE(lab.data, proxy.width * proxy.height, background);
    const threshold = adaptiveThreshold(deltaE, ringIndices);

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
 * 外周リングに含まれる画素インデックスを列挙する。
 *
 * 背景色の推定と閾値の決定で同じ領域を使うために共通化している。
 * 「外周は背景である」という前提を 1 か所に閉じ込めておきたい。
 */
export function borderRingIndices(width: number, height: number): Uint32Array {
  const ring = Math.max(1, Math.round(Math.min(width, height) * BORDER_RING_RATIO));
  const indices: number[] = [];

  for (let y = 0; y < height; y += 1) {
    const isHorizontalBand = y < ring || y >= height - ring;
    if (isHorizontalBand) {
      for (let x = 0; x < width; x += 1) indices.push(y * width + x);
      continue;
    }
    // 中段は左右の帯だけを拾う。
    for (let x = 0; x < ring; x += 1) indices.push(y * width + x);
    for (let x = Math.max(ring, width - ring); x < width; x += 1) indices.push(y * width + x);
  }

  return Uint32Array.from(indices);
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
  const indices = borderRingIndices(width, height);
  const histograms = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];

  for (const index of indices) {
    const offset = index * 3;
    histograms[0]![labData[offset]!]! += 1;
    histograms[1]![labData[offset + 1]!]! += 1;
    histograms[2]![labData[offset + 2]!]! += 1;
  }

  if (indices.length === 0) return { l: 255, a: 128, b: 128 };

  return {
    l: medianFromHistogram(histograms[0]!, indices.length),
    a: medianFromHistogram(histograms[1]!, indices.length),
    b: medianFromHistogram(histograms[2]!, indices.length),
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
 * 適応的な閾値を決める。
 *
 * **統計は画像全体ではなく外周リングだけから取る。** 全体で中央値を採ると、
 * カードが画面の大半を占める（＝密着スキャン）ときに中央値がカード側へ移り、
 * 閾値が跳ね上がって何も検出できなくなる。外周は背景であるという前提のもとでは、
 * リングの中央値と MAD は「背景のばらつき」そのものであり、閾値が超えるべき量に等しい。
 *
 * MAD をそのまま使わずシグマ換算するのは、MAD が分布の裾を過小評価するため
 * （実測: median + 3*MAD = 2.7 に対し背景の p99 = 5.2）。
 *
 * 上限を設けるのは、片側に影が落ちているなどでリングのばらつきが大きいとき、
 * 閾値が実在のカードとの色差を超えてしまうのを防ぐため。
 */
export function adaptiveThreshold(deltaE: Float32Array, ringIndices: Uint32Array): number {
  if (ringIndices.length === 0) return MIN_DELTA_E_THRESHOLD;

  const median = medianOf(deltaE, ringIndices, (value) => value);
  const mad = medianOf(deltaE, ringIndices, (value) => Math.abs(value - median));

  const threshold = median + SIGMA_MULTIPLIER * MAD_TO_SIGMA * mad;
  return Math.min(MAX_DELTA_E_THRESHOLD, Math.max(MIN_DELTA_E_THRESHOLD, threshold));
}

/**
 * ヒストグラム法で中央値を求める（0.1 刻み）。
 *
 * **整数バケットでは分解能が足りない。** 実測の背景 ΔE は median 1.27 / MAD 0.49 で、
 * 整数へ丸めると MAD が 0 か 1 に潰れ、閾値が 4 倍以上ぶれてしまう。
 * 0.1 刻みなら実用上の誤差は無視できる。全画素をソートするより速く、メモリも一定。
 */
function medianOf(
  values: Float32Array,
  indices: Uint32Array,
  transform: (value: number) => number,
): number {
  const histogram = new Uint32Array(HISTOGRAM_BUCKETS);
  for (const index of indices) {
    const bucket = Math.min(
      HISTOGRAM_BUCKETS - 1,
      Math.max(0, Math.round(transform(values[index]!) * HISTOGRAM_RESOLUTION)),
    );
    histogram[bucket]! += 1;
  }

  const target = indices.length / 2;
  let cumulative = 0;
  for (let bucket = 0; bucket < HISTOGRAM_BUCKETS; bucket += 1) {
    cumulative += histogram[bucket]!;
    if (cumulative >= target) return bucket / HISTOGRAM_RESOLUTION;
  }
  return (HISTOGRAM_BUCKETS - 1) / HISTOGRAM_RESOLUTION;
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
 * 候補は 2 つある。
 *
 * - **最小外接矩形**: 回転した長方形を厳密に表す。傾きには正確だが、
 *   遠近による台形歪みは表現できない。
 * - **多角形近似 (approxPolyDP)**: 台形歪みを保持できるが、
 *   **実在の身分証は必ず角が丸い**ため、丸角を内側に切り込んで券面を削りやすい。
 *
 * どちらが正しいかは形状によって変わるので、**輪郭の面積をより忠実に説明できるほう**を
 * 選ぶ。台形歪みがあれば近似四角形のほうが面積差が小さくなり、単に傾いただけの
 * 長方形なら外接矩形のほうが小さくなる。
 *
 * 実測（フラットベッドの実スキャン）では、近似四角形が高さを 2.7mm 削っていたのに対し
 * 外接矩形は誤差 0.2mm に収まり、この規則で正しく外接矩形が選ばれる。
 */
function resolveCorners(
  cv: OpenCv,
  contour: InstanceType<OpenCv['Mat']>,
  rotatedRect: ReturnType<OpenCv['minAreaRect']>,
): Point[] {
  const contourArea = cv.contourArea(contour);
  const rectCorners = rotatedRectCorners(rotatedRect);
  const rectError = Math.abs(polygonArea(rectCorners) - contourArea);

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
      if (Math.abs(polygonArea(points) - contourArea) < rectError) return points;
    }
  } finally {
    approx.delete();
  }

  return rectCorners;
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
