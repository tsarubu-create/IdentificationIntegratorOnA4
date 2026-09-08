import { describe, expect, it } from 'vitest';
import {
  boundingBox,
  distance,
  orderCorners,
  polygonArea,
  quadToArray,
  scaleQuad,
  translateQuad,
  warpTargetSize,
} from '@core/geometry/quad';
import type { Point } from '@shared/types';

/** 中心 (cx, cy)、幅 w・高さ h の矩形を angle ラジアン回転した 4 点を返す。 */
function rotatedRect(cx: number, cy: number, w: number, h: number, angle: number): Point[] {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return [
    [-w / 2, -h / 2],
    [w / 2, -h / 2],
    [w / 2, h / 2],
    [-w / 2, h / 2],
  ].map(([x, y]) => ({
    x: cx + x! * cos - y! * sin,
    y: cy + x! * sin + y! * cos,
  }));
}

describe('四隅の整列（仕様書 §5）', () => {
  it('軸に平行な矩形を左上・右上・右下・左下の順に並べる', () => {
    const quad = orderCorners([
      { x: 100, y: 200 },
      { x: 10, y: 20 },
      { x: 100, y: 20 },
      { x: 10, y: 200 },
    ]);

    expect(quad.topLeft).toEqual({ x: 10, y: 20 });
    expect(quad.topRight).toEqual({ x: 100, y: 20 });
    expect(quad.bottomRight).toEqual({ x: 100, y: 200 });
    expect(quad.bottomLeft).toEqual({ x: 10, y: 200 });
  });

  it('入力順を変えても同じ整列結果になる', () => {
    const points = rotatedRect(500, 400, 300, 200, 0.2);
    const reference = orderCorners(points);

    for (let shift = 1; shift < 4; shift += 1) {
      const rotatedInput = [...points.slice(shift), ...points.slice(0, shift)];
      expect(orderCorners(rotatedInput)).toEqual(reference);
    }
  });

  it('傾いた矩形でも正しい四隅を選ぶ', () => {
    // 15 度傾けても、左上は最も上かつ左寄りの点になる。
    const quad = orderCorners(rotatedRect(500, 500, 400, 250, (15 * Math.PI) / 180));
    const points = quadToArray(quad);

    expect(quad.topLeft.y).toBeLessThan(quad.bottomLeft.y);
    expect(quad.topLeft.x).toBeLessThan(quad.topRight.x);
    expect(quad.bottomRight.y).toBeGreaterThan(quad.topRight.y);
    // 4 点すべてが異なる
    expect(new Set(points.map((p) => `${p.x},${p.y}`)).size).toBe(4);
  });

  it('45 度傾けた正方形でも 4 点が重複しない', () => {
    const quad = orderCorners(rotatedRect(0, 0, 200, 200, Math.PI / 4));
    const keys = quadToArray(quad).map((p) => `${p.x.toFixed(3)},${p.y.toFixed(3)}`);
    expect(new Set(keys).size).toBe(4);
  });

  it('4 点でなければ例外になる', () => {
    expect(() => orderCorners([{ x: 0, y: 0 }])).toThrow(RangeError);
    expect(() => orderCorners(rotatedRect(0, 0, 10, 10, 0).slice(0, 3))).toThrow(RangeError);
  });
});

describe('透視変換の出力サイズ', () => {
  it('軸平行な矩形では元の寸法になる', () => {
    const quad = orderCorners([
      { x: 0, y: 0 },
      { x: 400, y: 0 },
      { x: 400, y: 250 },
      { x: 0, y: 250 },
    ]);
    expect(warpTargetSize(quad)).toEqual({ width: 400, height: 250 });
  });

  it('台形では対辺の平均を採り、解像度を捨てない', () => {
    // 上辺 400、下辺 300 の台形 -> 幅は 350 になる（狭い方の 300 ではない）
    const quad = orderCorners([
      { x: 0, y: 0 },
      { x: 400, y: 0 },
      { x: 350, y: 200 },
      { x: 50, y: 200 },
    ]);
    expect(warpTargetSize(quad).width).toBe(350);
  });

  it('回転しても辺の長さは保たれる', () => {
    const quad = orderCorners(rotatedRect(1000, 1000, 600, 400, 0.35));
    const size = warpTargetSize(quad);
    expect(size.width).toBeCloseTo(600, 0);
    expect(size.height).toBeCloseTo(400, 0);
  });
});

describe('外接矩形（原寸で扱う範囲の限定）', () => {
  const bounds = { width: 2000, height: 1500 };

  it('四隅を囲む最小の矩形を返す', () => {
    const quad = orderCorners([
      { x: 100, y: 200 },
      { x: 700, y: 250 },
      { x: 680, y: 600 },
      { x: 120, y: 550 },
    ]);
    const box = boundingBox(quad, bounds);

    expect(box.x).toBe(100);
    expect(box.y).toBe(200);
    expect(box.x + box.width).toBe(700);
    expect(box.y + box.height).toBe(600);
  });

  it('余白を付けても画像の外へはみ出さない', () => {
    const quad = orderCorners([
      { x: 0, y: 0 },
      { x: 1999, y: 5 },
      { x: 1999, y: 1499 },
      { x: 2, y: 1495 },
    ]);
    const box = boundingBox(quad, bounds, 50);

    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(bounds.width);
    expect(box.y + box.height).toBeLessThanOrEqual(bounds.height);
  });

  it('幅・高さは 1px 以上になる', () => {
    const degenerate = orderCorners([
      { x: 10, y: 10 },
      { x: 10, y: 10 },
      { x: 10, y: 10 },
      { x: 10, y: 10 },
    ]);
    const box = boundingBox(degenerate, bounds);
    expect(box.width).toBeGreaterThanOrEqual(1);
    expect(box.height).toBeGreaterThanOrEqual(1);
  });
});

describe('座標の写像', () => {
  it('プロキシ座標を原寸へ拡大できる', () => {
    const quad = orderCorners([
      { x: 10, y: 20 },
      { x: 110, y: 20 },
      { x: 110, y: 80 },
      { x: 10, y: 80 },
    ]);
    const scaled = scaleQuad(quad, 4);

    expect(scaled.topLeft).toEqual({ x: 40, y: 80 });
    expect(scaled.bottomRight).toEqual({ x: 440, y: 320 });
    // 形状は相似（辺の比が保たれる）
    expect(warpTargetSize(scaled).width / warpTargetSize(quad).width).toBeCloseTo(4, 6);
  });

  it('切り出し矩形の原点へ平行移動できる', () => {
    const quad = orderCorners([
      { x: 110, y: 220 },
      { x: 310, y: 220 },
      { x: 310, y: 360 },
      { x: 110, y: 360 },
    ]);
    const moved = translateQuad(quad, { x: 100, y: 200 });

    expect(moved.topLeft).toEqual({ x: 10, y: 20 });
    expect(moved.bottomRight).toEqual({ x: 210, y: 160 });
  });
});

describe('補助関数', () => {
  it('距離を正しく求める', () => {
    expect(distance({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5);
  });

  it('多角形面積を求める（頂点の巡回方向によらない）', () => {
    const square = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
    ];
    expect(polygonArea(square)).toBe(100);
    expect(polygonArea([...square].reverse())).toBe(100);
  });
});
