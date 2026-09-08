/**
 * 四隅の整列と、透視変換のための幾何計算（仕様書 §5）。
 *
 * OpenCV に依存しない純粋な計算だけを置く。実際の `warpPerspective` 呼び出しは
 * worker 層が担当し、この module はそこへ渡す座標を用意する。
 */

import type { Point, Quad, SizePx } from '@shared/types';
import type { RectPx } from '@core/layout/a4';

/** 2 点間のユークリッド距離。 */
export function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/**
 * 任意順の 4 点を、左上・右上・右下・左下の順へ整列する。
 *
 * 主たる手法は座標の和と差による判定である。
 * - 和 `x + y` が最小の点が左上、最大の点が右下
 * - 差 `x - y` が最大の点が右上、最小の点が左下
 *
 * ただしこの手法は、ちょうど 45 度傾いた正方形で破綻する。その場合は和も差も
 * 2 点ずつ同値になり、同じ点が左上と右上の双方に選ばれてしまう。
 * そこで結果が 4 点に分かれなかったときだけ、重心まわりの角度順へフォールバックする。
 *
 * @throws 点が 4 つでない場合
 */
export function orderCorners(points: readonly Point[]): Quad {
  if (points.length !== 4) {
    throw new RangeError(`四隅の整列には 4 点が必要です: ${points.length} 点`);
  }

  let topLeft = points[0]!;
  let bottomRight = points[0]!;
  let topRight = points[0]!;
  let bottomLeft = points[0]!;

  for (const point of points) {
    const sum = point.x + point.y;
    const diff = point.x - point.y;
    if (sum < topLeft.x + topLeft.y) topLeft = point;
    if (sum > bottomRight.x + bottomRight.y) bottomRight = point;
    if (diff > topRight.x - topRight.y) topRight = point;
    if (diff < bottomLeft.x - bottomLeft.y) bottomLeft = point;
  }

  const selected = [topLeft, topRight, bottomRight, bottomLeft];
  const isDistinct = new Set(selected.map((p) => `${p.x},${p.y}`)).size === 4;
  if (!isDistinct) return orderCornersByAngle(points);

  return { topLeft, topRight, bottomRight, bottomLeft };
}

/**
 * 重心まわりの角度で 4 点を巡回順に並べ、左上から時計回りに割り当てる。
 *
 * 画像座標系は y が下向きなので、`atan2` の昇順が画面上の時計回りに対応する。
 * したがって左上を起点に並べれば、そのまま 左上→右上→右下→左下 になる。
 */
function orderCornersByAngle(points: readonly Point[]): Quad {
  const centerX = points.reduce((sum, p) => sum + p.x, 0) / points.length;
  const centerY = points.reduce((sum, p) => sum + p.y, 0) / points.length;

  const clockwise = [...points].sort(
    (a, b) => Math.atan2(a.y - centerY, a.x - centerX) - Math.atan2(b.y - centerY, b.x - centerX),
  );

  // 起点は「和 x + y が最小」の点。同値が複数あっても最初の 1 つに定まるため、
  // ここでは重複が生じない。
  let startIndex = 0;
  for (let i = 1; i < clockwise.length; i += 1) {
    const candidate = clockwise[i]!;
    const current = clockwise[startIndex]!;
    if (candidate.x + candidate.y < current.x + current.y) startIndex = i;
  }

  const at = (offset: number): Point => clockwise[(startIndex + offset) % clockwise.length]!;
  return { topLeft: at(0), topRight: at(1), bottomRight: at(2), bottomLeft: at(3) };
}

/** 四隅を配列（左上→右上→右下→左下）として取り出す。 */
export function quadToArray(quad: Quad): readonly [Point, Point, Point, Point] {
  return [quad.topLeft, quad.topRight, quad.bottomRight, quad.bottomLeft];
}

/**
 * 透視変換後の出力サイズを決める。
 *
 * 対辺の長さの平均を採る。片側だけを使うと、台形歪みが強い画像で
 * 出力が不必要に縮む（＝解像度を捨てる）ことがある。
 */
export function warpTargetSize(quad: Quad): SizePx {
  const topWidth = distance(quad.topLeft, quad.topRight);
  const bottomWidth = distance(quad.bottomLeft, quad.bottomRight);
  const leftHeight = distance(quad.topLeft, quad.bottomLeft);
  const rightHeight = distance(quad.topRight, quad.bottomRight);

  return {
    width: Math.max(1, Math.round((topWidth + bottomWidth) / 2)),
    height: Math.max(1, Math.round((leftHeight + rightHeight) / 2)),
  };
}

/**
 * 四隅の外接矩形を求める。
 *
 * ここで求めた矩形だけを原寸で切り出すのが、メモリ設計の要（README §3.1）。
 *
 * @param quad 四隅
 * @param bounds 切り出し元画像の寸法（範囲外へはみ出させない）
 * @param padding 余白（画素）。透視変換で端が欠けるのを防ぐ
 */
export function boundingBox(quad: Quad, bounds: SizePx, padding = 0): RectPx {
  const points = quadToArray(quad);
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);

  const left = Math.max(0, Math.floor(Math.min(...xs)) - padding);
  const top = Math.max(0, Math.floor(Math.min(...ys)) - padding);
  const right = Math.min(bounds.width, Math.ceil(Math.max(...xs)) + padding);
  const bottom = Math.min(bounds.height, Math.ceil(Math.max(...ys)) + padding);

  return {
    x: left,
    y: top,
    width: Math.max(1, right - left),
    height: Math.max(1, bottom - top),
  };
}

/**
 * プロキシ画像の座標を原寸の座標へ写像する。
 *
 * @param quad プロキシ座標系の四隅
 * @param scale 原寸 / プロキシ の倍率
 */
export function scaleQuad(quad: Quad, scale: number): Quad {
  const scalePoint = (p: Point): Point => ({ x: p.x * scale, y: p.y * scale });
  return {
    topLeft: scalePoint(quad.topLeft),
    topRight: scalePoint(quad.topRight),
    bottomRight: scalePoint(quad.bottomRight),
    bottomLeft: scalePoint(quad.bottomLeft),
  };
}

/** 四隅を、指定した矩形の左上を原点とする座標系へ平行移動する。 */
export function translateQuad(quad: Quad, origin: { x: number; y: number }): Quad {
  const move = (p: Point): Point => ({ x: p.x - origin.x, y: p.y - origin.y });
  return {
    topLeft: move(quad.topLeft),
    topRight: move(quad.topRight),
    bottomRight: move(quad.bottomRight),
    bottomLeft: move(quad.bottomLeft),
  };
}

/** 多角形の符号なし面積（靴ひも公式）。 */
export function polygonArea(points: readonly Point[]): number {
  let sum = 0;
  for (let i = 0; i < points.length; i += 1) {
    const current = points[i]!;
    const next = points[(i + 1) % points.length]!;
    sum += current.x * next.y - next.x * current.y;
  }
  return Math.abs(sum) / 2;
}

/** 四隅の重心（中心）。 */
export function quadCenter(quad: Quad): Point {
  const points = quadToArray(quad);
  return {
    x: points.reduce((sum, p) => sum + p.x, 0) / points.length,
    y: points.reduce((sum, p) => sum + p.y, 0) / points.length,
  };
}

/**
 * 四隅の傾き（ラジアン）。上辺の向きで測る。
 *
 * 上辺と下辺の平均を採るのは、片方の辺だけが検出誤差でずれた場合に
 * 角度が振れるのを避けるため。
 */
export function quadAngle(quad: Quad): number {
  const top = Math.atan2(quad.topRight.y - quad.topLeft.y, quad.topRight.x - quad.topLeft.x);
  const bottom = Math.atan2(
    quad.bottomRight.y - quad.bottomLeft.y,
    quad.bottomRight.x - quad.bottomLeft.x,
  );
  return (top + bottom) / 2;
}

/**
 * 中心・傾き・寸法から四隅を組み立てる。
 *
 * **大きさを規格値から与える**ために使う（README §3.2）。位置と傾きは画像から、
 * 大きさは規格から取ることで、同一カードの表裏で寸法が食い違わなくなる。
 *
 * @param center 中心座標
 * @param angleRad 傾き（ラジアン）
 * @param size 画素単位の寸法
 */
export function quadFromCenter(center: Point, angleRad: number, size: SizePx): Quad {
  const cos = Math.cos(angleRad);
  const sin = Math.sin(angleRad);
  const halfWidth = size.width / 2;
  const halfHeight = size.height / 2;

  const corner = (dx: number, dy: number): Point => ({
    x: center.x + dx * cos - dy * sin,
    y: center.y + dx * sin + dy * cos,
  });

  return {
    topLeft: corner(-halfWidth, -halfHeight),
    topRight: corner(halfWidth, -halfHeight),
    bottomRight: corner(halfWidth, halfHeight),
    bottomLeft: corner(-halfWidth, halfHeight),
  };
}
