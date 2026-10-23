import { describe, expect, it } from 'vitest';
import { canEditImage, manualQuad, recommendsEditing } from '@core/geometry/manualAdjustment';
import { quadCenter, quadAngle, warpTargetSize } from '@core/geometry/quad';
import type { AnalyzedImage } from '@shared/types';

const image: AnalyzedImage = {
  id: 'test',
  relativePath: 'test.png',
  status: 'needsReview',
  embeddedDpi: 300,
  effectiveDpi: 300,
  physicalSize: null,
  cardSizeMm: null,
  confidence: 0.6,
  warnings: ['lowConfidence'],
  exclusion: 'detectionFailed',
  limitViolation: null,
  kind: 'idCard',
  thumbnail: new ArrayBuffer(1),
};

describe('手動の切り出し位置', () => {
  it.each([0, -25, 25, 90])('指定した位置・傾きで実寸の券面枠になる（%i度）', (angleDegrees) => {
    const quad = manualQuad({ centerX: 1200, centerY: 1800, angleDegrees }, 'idCard', 300, {
      width: 2550,
      height: 3506,
    });
    expect(quadCenter(quad)).toEqual({ x: 1200, y: 1800 });
    expect(warpTargetSize(quad)).toEqual({ width: 1011, height: 638 });
    expect((quadAngle(quad) * 180) / Math.PI).toBeCloseTo(angleDegrees);
  });
  it.each([NaN, Infinity, -1, 2600])('不正または画像外の中心座標を拒否する（%s）', (centerX) => {
    expect(() =>
      manualQuad({ centerX, centerY: 1800, angleDegrees: 0 }, 'idCard', 300, {
        width: 2550,
        height: 3506,
      }),
    ).toThrow();
  });
  it('中心が画像内でも券面が欠ける指定を拒否する', () => {
    expect(() =>
      manualQuad({ centerX: 100, centerY: 200, angleDegrees: 0 }, 'idCard', 300, {
        width: 2550,
        height: 3506,
      }),
    ).toThrow('券面の枠全体');
  });
  it('不正な角度・DPIを拒否する', () => {
    expect(() =>
      manualQuad({ centerX: 1200, centerY: 1800, angleDegrees: 91 }, 'idCard', 300, {
        width: 2550,
        height: 3506,
      }),
    ).toThrow();
    expect(() =>
      manualQuad({ centerX: 1200, centerY: 1800, angleDegrees: 0 }, 'idCard', 0, {
        width: 2550,
        height: 3506,
      }),
    ).toThrow();
  });
  it('検出失敗・規格外には編集を勧め、手動調整済みには重ねて勧めない', () => {
    expect(recommendsEditing(image)).toBe(true);
    expect(recommendsEditing({ ...image, status: 'detected', warnings: ['nonStandardSize'] })).toBe(
      true,
    );
    expect(
      recommendsEditing({ ...image, status: 'detected', warnings: ['manualAdjustment'] }),
    ).toBe(false);
    expect(recommendsEditing({ ...image, status: 'detected', warnings: [] })).toBe(false);
  });
  it.each(['decodeFailed', 'fileTooLarge', 'tooManyPixels'] as const)(
    '%sは編集で安全制限を回避できない',
    (exclusion) => {
      expect(canEditImage({ ...image, exclusion })).toBe(false);
    },
  );
});
