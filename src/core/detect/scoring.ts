/**
 * カード候補の評価と信頼度判定（仕様書 §5 / §8）。
 *
 * OpenCV から得た輪郭の統計値だけを受け取り、スコアと検出状態を決める純粋ロジック。
 * こうしておくと閾値のチューニングを、画像処理を動かさずに単体テストできる。
 */

import type { DetectionStatus } from '@shared/types';

/** OpenCV の輪郭解析から得られる、1 候補ぶんの計測値。 */
export interface CandidateMetrics {
  /** 輪郭そのものの面積（画素） */
  readonly contourArea: number;
  /** 最小外接矩形の面積（画素） */
  readonly minAreaRectArea: number;
  /** 最小外接矩形の長辺 / 短辺 */
  readonly aspectRatio: number;
  /** 解析対象画像の総画素数 */
  readonly imageArea: number;
  /** 外接矩形が画像の端に接している辺の数（0..4） */
  readonly edgeTouchCount: number;
}

/** 候補として採用する面積の下限（画像面積比）。これ未満はノイズとみなす。 */
export const MIN_AREA_RATIO = 0.005;

/** 候補として採用する面積の上限（画像面積比）。これ超は背景を拾ったとみなす。 */
export const MAX_AREA_RATIO = 0.9;

/**
 * アスペクト比の許容範囲。
 *
 * ID-1 カード 1.585、パスポート見開き 1.408 の双方を包含する広めの範囲にする。
 * **種別の自動判定は行わない**（仕様書 §2: 種別は利用者が確認画面で選択する）。
 */
export const MIN_ASPECT_RATIO = 1.1;
export const MAX_ASPECT_RATIO = 2.6;

/** 理想アスペクト比（ID-1 カード）。適合度の中心に使う。 */
const IDEAL_ASPECT_RATIO = 85.6 / 54.0;

/**
 * 候補として認める矩形度の下限。
 *
 * 身分証は矩形なので、矩形度は最も判別力の高い指標である。これを下回る輪郭は
 * そもそも四角形ではないため、面積やアスペクト比が良好でも候補から外す。
 */
export const MIN_RECTANGULARITY = 0.5;

/** スコアの重み（合計 1.0）。 */
const WEIGHT_RECTANGULARITY = 0.4;
const WEIGHT_ASPECT = 0.25;
const WEIGHT_AREA = 0.25;
const WEIGHT_EDGE = 0.1;

/** 検出成功とみなすスコアの下限。 */
export const SCORE_DETECTED = 0.75;

/** 要確認とみなすスコアの下限。これ未満は検出失敗。 */
export const SCORE_NEEDS_REVIEW = 0.55;

/** 「候補が 1 つに絞れた」とみなす、次点とのスコア差。 */
export const DOMINANCE_MARGIN = 0.15;

/** 矩形度（輪郭面積 / 最小外接矩形面積）。1 に近いほど矩形らしい。 */
export function rectangularity(metrics: CandidateMetrics): number {
  if (metrics.minAreaRectArea <= 0) return 0;
  return clamp01(metrics.contourArea / metrics.minAreaRectArea);
}

/**
 * アスペクト比の適合度。
 *
 * 許容範囲の外は 0、理想比で 1 になるように、対数距離で線形に減衰させる。
 * 比の距離は対数で測る（2.0 と 1.0 の隔たりは、1.0 と 0.5 の隔たりと等価）。
 */
export function aspectScore(aspectRatio: number): number {
  if (!Number.isFinite(aspectRatio) || aspectRatio <= 0) return 0;
  if (aspectRatio < MIN_ASPECT_RATIO || aspectRatio > MAX_ASPECT_RATIO) return 0;

  const distance = Math.abs(Math.log(aspectRatio) - Math.log(IDEAL_ASPECT_RATIO));
  const maxDistance = Math.max(
    Math.abs(Math.log(MIN_ASPECT_RATIO) - Math.log(IDEAL_ASPECT_RATIO)),
    Math.abs(Math.log(MAX_ASPECT_RATIO) - Math.log(IDEAL_ASPECT_RATIO)),
  );
  return clamp01(1 - distance / maxDistance);
}

/**
 * 面積の適合度。
 *
 * 小さすぎる候補（ノイズ）と大きすぎる候補（背景全体）の双方を下げる。
 * 面積比 0.1〜0.6 を最良帯とする。実スキャンではカードが画面の 1〜6 割を占めることが多い。
 */
export function areaScore(metrics: CandidateMetrics): number {
  if (metrics.imageArea <= 0) return 0;
  const ratio = metrics.contourArea / metrics.imageArea;
  if (ratio < MIN_AREA_RATIO || ratio > MAX_AREA_RATIO) return 0;
  if (ratio >= 0.1 && ratio <= 0.6) return 1;
  if (ratio < 0.1) return clamp01((ratio - MIN_AREA_RATIO) / (0.1 - MIN_AREA_RATIO));
  return clamp01((MAX_AREA_RATIO - ratio) / (MAX_AREA_RATIO - 0.6));
}

/**
 * 画像端への接触ペナルティ。
 *
 * 端に接する候補は、カードが見切れているか背景を拾っている可能性が高い。
 */
export function edgeScore(metrics: CandidateMetrics): number {
  const touches = Math.min(4, Math.max(0, metrics.edgeTouchCount));
  return 1 - touches / 4;
}

/**
 * 候補の総合スコア（0..1）。
 *
 * 面積・アスペクト比・矩形度のいずれかが許容範囲外の候補は、他の指標がよくても 0 とする。
 * 重み付き和だけで判定すると、たとえば「面積とアスペクト比は理想的だが、形が
 * 四角形ですらない」輪郭が高得点を得てしまうため、まず足切りを行う。
 */
export function scoreCandidate(metrics: CandidateMetrics): number {
  const area = areaScore(metrics);
  const aspect = aspectScore(metrics.aspectRatio);
  const rect = rectangularity(metrics);
  if (area === 0 || aspect === 0 || rect < MIN_RECTANGULARITY) return 0;

  return clamp01(
    WEIGHT_RECTANGULARITY * rect +
      WEIGHT_ASPECT * aspect +
      WEIGHT_AREA * area +
      WEIGHT_EDGE * edgeScore(metrics),
  );
}

/** 候補評価の結果。 */
export interface CandidateEvaluation {
  readonly status: DetectionStatus;
  /** 最良候補の index。候補が無ければ null */
  readonly bestIndex: number | null;
  /** 最良候補のスコア。候補が無ければ 0 */
  readonly bestScore: number;
  /** 有力候補が複数あるか（確認画面で警告を出す） */
  readonly hasMultipleCandidates: boolean;
}

/**
 * 候補群から最良のものを選び、検出状態を決める（仕様書 §5 / §8）。
 *
 * - 最良スコア >= 0.75 かつ次点との差 >= 0.15 なら「検出成功」
 * - 0.55 以上なら「要確認」（複数候補・低信頼度を含む）
 * - それ未満は「検出失敗」
 */
export function evaluateCandidates(candidates: readonly CandidateMetrics[]): CandidateEvaluation {
  if (candidates.length === 0) {
    return { status: 'failed', bestIndex: null, bestScore: 0, hasMultipleCandidates: false };
  }

  const scores = candidates.map(scoreCandidate);
  let bestIndex = 0;
  for (let i = 1; i < scores.length; i += 1) {
    if (scores[i]! > scores[bestIndex]!) bestIndex = i;
  }
  const bestScore = scores[bestIndex]!;

  if (bestScore < SCORE_NEEDS_REVIEW) {
    return { status: 'failed', bestIndex: null, bestScore, hasMultipleCandidates: false };
  }

  const runnerUp = scores.reduce(
    (max, score, index) => (index === bestIndex ? max : Math.max(max, score)),
    0,
  );
  // 次点も採用ラインに乗っており、かつ差が小さい場合を「複数候補」とみなす。
  const hasMultipleCandidates =
    runnerUp >= SCORE_NEEDS_REVIEW && bestScore - runnerUp < DOMINANCE_MARGIN;

  const status: DetectionStatus =
    bestScore >= SCORE_DETECTED && !hasMultipleCandidates ? 'detected' : 'needsReview';

  return { status, bestIndex, bestScore, hasMultipleCandidates };
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}
