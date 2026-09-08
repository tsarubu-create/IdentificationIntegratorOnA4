import { describe, expect, it } from 'vitest';
import {
  type CandidateMetrics,
  DOMINANCE_MARGIN,
  SCORE_DETECTED,
  SCORE_NEEDS_REVIEW,
  areaScore,
  aspectScore,
  edgeScore,
  evaluateCandidates,
  rectangularity,
  scoreCandidate,
} from '@core/detect/scoring';

const IMAGE_AREA = 1600 * 1200;

/** 理想に近い ID-1 カード候補（面積比 0.3、矩形度 0.98、端に接しない）。 */
function idealCandidate(overrides: Partial<CandidateMetrics> = {}): CandidateMetrics {
  const contourArea = IMAGE_AREA * 0.3;
  return {
    contourArea,
    minAreaRectArea: contourArea / 0.98,
    aspectRatio: 85.6 / 54.0,
    imageArea: IMAGE_AREA,
    edgeTouchCount: 0,
    ...overrides,
  };
}

describe('個別指標', () => {
  it('矩形度は輪郭面積と外接矩形面積の比になる', () => {
    expect(rectangularity(idealCandidate())).toBeCloseTo(0.98, 6);
  });

  it('外接矩形面積が 0 なら矩形度は 0', () => {
    expect(rectangularity(idealCandidate({ minAreaRectArea: 0 }))).toBe(0);
  });

  it('理想アスペクト比で 1.0、許容範囲外で 0 になる', () => {
    expect(aspectScore(85.6 / 54.0)).toBeCloseTo(1, 6);
    expect(aspectScore(1.0)).toBe(0);
    expect(aspectScore(3.0)).toBe(0);
    expect(aspectScore(0)).toBe(0);
    expect(aspectScore(Number.NaN)).toBe(0);
  });

  it('パスポート見開きのアスペクト比も許容範囲に入る（種別を自動判定しない）', () => {
    // 176 / 125 = 1.408。カードと近接するため、比だけでは種別を決められない。
    expect(aspectScore(176 / 125)).toBeGreaterThan(0);
  });

  it('面積比が最良帯なら 1、範囲外なら 0 になる', () => {
    expect(areaScore(idealCandidate())).toBe(1);
    expect(areaScore(idealCandidate({ contourArea: IMAGE_AREA * 0.001 }))).toBe(0);
    expect(areaScore(idealCandidate({ contourArea: IMAGE_AREA * 0.95 }))).toBe(0);
  });

  it('端に接するほどスコアが下がる', () => {
    expect(edgeScore(idealCandidate({ edgeTouchCount: 0 }))).toBe(1);
    expect(edgeScore(idealCandidate({ edgeTouchCount: 2 }))).toBe(0.5);
    expect(edgeScore(idealCandidate({ edgeTouchCount: 4 }))).toBe(0);
  });
});

describe('総合スコア', () => {
  it('理想的な候補は検出成功ラインを超える', () => {
    expect(scoreCandidate(idealCandidate())).toBeGreaterThanOrEqual(SCORE_DETECTED);
  });

  it('アスペクト比が範囲外なら、矩形度が高くても 0 になる', () => {
    // 細長い帯（スキャナの端の影など）を矩形度の高さだけで拾わせない。
    const strip = idealCandidate({ aspectRatio: 8, minAreaRectArea: IMAGE_AREA * 0.3 });
    expect(scoreCandidate(strip)).toBe(0);
  });

  it('面積が小さすぎる候補は 0 になる', () => {
    expect(scoreCandidate(idealCandidate({ contourArea: IMAGE_AREA * 0.001 }))).toBe(0);
  });

  it('矩形度が低いほどスコアが下がる', () => {
    const contourArea = IMAGE_AREA * 0.3;
    const high = scoreCandidate(idealCandidate({ minAreaRectArea: contourArea / 0.95 }));
    const low = scoreCandidate(idealCandidate({ minAreaRectArea: contourArea / 0.6 }));
    expect(high).toBeGreaterThan(low);
  });

  it('スコアは常に 0..1 に収まる', () => {
    const cases = [
      idealCandidate(),
      idealCandidate({ edgeTouchCount: 4 }),
      idealCandidate({ minAreaRectArea: Number.POSITIVE_INFINITY }),
      idealCandidate({ contourArea: 0 }),
    ];
    for (const candidate of cases) {
      const score = scoreCandidate(candidate);
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(1);
    }
  });
});

describe('検出状態の判定（仕様書 §5 / §8）', () => {
  it('候補が無ければ検出失敗', () => {
    const result = evaluateCandidates([]);
    expect(result.status).toBe('failed');
    expect(result.bestIndex).toBeNull();
  });

  it('単独の良好な候補は検出成功になる', () => {
    const result = evaluateCandidates([idealCandidate()]);
    expect(result.status).toBe('detected');
    expect(result.bestIndex).toBe(0);
    expect(result.hasMultipleCandidates).toBe(false);
  });

  it('最良候補を正しく選ぶ', () => {
    const weak = idealCandidate({ edgeTouchCount: 3, minAreaRectArea: IMAGE_AREA * 0.6 });
    const result = evaluateCandidates([weak, idealCandidate()]);
    expect(result.bestIndex).toBe(1);
  });

  it('スコアが低すぎる候補しかなければ検出失敗になる', () => {
    const poor = idealCandidate({ aspectRatio: 5 });
    const result = evaluateCandidates([poor]);
    expect(result.status).toBe('failed');
    expect(result.bestScore).toBeLessThan(SCORE_NEEDS_REVIEW);
  });

  it('僅差の有力候補が 2 つあれば「要確認」になる', () => {
    const a = idealCandidate();
    const b = idealCandidate({ edgeTouchCount: 1 });
    const result = evaluateCandidates([a, b]);

    expect(result.hasMultipleCandidates).toBe(true);
    expect(result.status).toBe('needsReview');
    expect(result.bestScore - Math.min(scoreCandidate(a), scoreCandidate(b))).toBeLessThan(
      DOMINANCE_MARGIN,
    );
  });

  it('差が十分に開いていれば複数候補でも検出成功になる', () => {
    const dominant = idealCandidate();
    const weak = idealCandidate({
      contourArea: IMAGE_AREA * 0.02,
      minAreaRectArea: IMAGE_AREA * 0.05,
    });
    const result = evaluateCandidates([dominant, weak]);

    expect(result.status).toBe('detected');
    expect(result.hasMultipleCandidates).toBe(false);
  });

  it('中程度のスコアは「要確認」になる', () => {
    // 矩形度 0.62、面積比 0.05、アスペクト比 2.0、端に 1 辺接触。
    // どの指標も足切りは通るが理想からは離れており、採用ラインには届かない。
    const contourArea = IMAGE_AREA * 0.05;
    const mediocre = idealCandidate({
      contourArea,
      minAreaRectArea: contourArea / 0.62,
      aspectRatio: 2.0,
      edgeTouchCount: 1,
    });
    const result = evaluateCandidates([mediocre]);

    expect(result.bestScore).toBeGreaterThanOrEqual(SCORE_NEEDS_REVIEW);
    expect(result.bestScore).toBeLessThan(SCORE_DETECTED);
    expect(result.status).toBe('needsReview');
  });
});

describe('矩形度の足切り', () => {
  it('四角形とはいえない輪郭は、面積とアスペクト比が理想的でも 0 になる', () => {
    // 星形や手指の写り込みなど、外接矩形に対して面積が小さい輪郭を想定。
    const contourArea = IMAGE_AREA * 0.3;
    const blob = idealCandidate({ contourArea, minAreaRectArea: contourArea / 0.35 });

    expect(rectangularity(blob)).toBeLessThan(0.5);
    expect(scoreCandidate(blob)).toBe(0);
  });
});
