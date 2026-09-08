/**
 * 規格値に基づく切り出しのテスト（仕様書 §2 / §6）。
 *
 * 実機で見つかった不具合の再現を含む。券面のきわの陰影が淡いと色差マスクから漏れ、
 * 漏れた辺と反対側へ中心が偏る。その状態でも券面全体が切り出せることを確認する。
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { detectCard } from '@worker/detector';
import { createDetectionProxy } from '@worker/imageIo';
import { cropQuad, resolveCardSize } from '@core/standards/officialCrop';
import { resolvePlacement } from '@core/layout/placement';
import { CARDS_PER_PAGE, CELL_SIZE_MM, CELL_SIZE_PX, cellRect } from '@core/layout/a4';
import {
  ID1_CARD_SIZE_MM,
  PASSPORT_SPREAD_SIZE_MM,
  matchOfficialSize,
} from '@core/standards/documentSizes';
import { quadToArray } from '@core/geometry/quad';
import { syntheticScan } from '../fixtures/synthetic';

/** 300dpi における ID-1 カードの画素サイズ。 */
const CARD_W = 1011;
const CARD_H = 638;
const CANVAS_W = 2550;
const CANVAS_H = 3506;

let workDir: string;

beforeAll(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), 'a4int-official-'));
});
afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
});

/** 実機に近い「白い券面 x 白い背景」のスキャンを合成する。 */
async function whiteCardScan(
  name: string,
  options: Parameters<typeof syntheticScan>[0] = {},
): Promise<string> {
  const bytes = await syntheticScan({
    canvasWidth: CANVAS_W,
    canvasHeight: CANVAS_H,
    cardWidth: CARD_W,
    cardHeight: CARD_H,
    // 実機の白い券面を模す。券面そのものは背景と ΔE 8 程度の差があり検出できるが、
    // きわの陰影（faintColor）は ΔE 3 程度しかなく本検出の閾値 4 を下回る。
    // これが実機で中心が偏った原因の再現である。
    backgroundColor: '#f2f2f0',
    cardColor: '#dcdcd8',
    faintColor: '#e9e7e4',
    density: 300,
    ...options,
  });
  const filePath = path.join(workDir, name);
  await writeFile(filePath, bytes);
  return filePath;
}

/** 検出し、実際に切り出す領域の軸平行な範囲を返す。 */
async function cropBox(filePath: string) {
  const proxy = await createDetectionProxy(filePath);
  const result = await detectCard(proxy, proxy.scaleToOriginal);
  expect(result.quad, '検出に失敗しました').not.toBeNull();

  const card = resolveCardSize(result.quad!, 'idCard', 300);
  const placement = resolvePlacement(card.sizeMm, 'idCard');
  const quad = cropQuad(result.quad!, placement.cropSizeMm, 300);
  const pts = quadToArray(quad);
  return {
    card,
    placement,
    x0: Math.min(...pts.map((p) => p.x)),
    x1: Math.max(...pts.map((p) => p.x)),
    y0: Math.min(...pts.map((p) => p.y)),
    y1: Math.max(...pts.map((p) => p.y)),
  };
}

describe('公的な確定寸法（官公庁の規格値）', () => {
  it('運転免許証・マイナンバーカードは ISO/IEC 7810 ID-1 である', () => {
    // 道路交通法施行規則 別記様式第14 / ID-1 の中心値
    expect(ID1_CARD_SIZE_MM).toEqual({ widthMm: 85.6, heightMm: 53.98 });
  });

  it('日本国旅券の見開きは 176 x 125 mm である', () => {
    // ICAO ID-3（125mm x 88mm）を短辺どうしで綴じた見開き
    expect(PASSPORT_SPREAD_SIZE_MM).toEqual({ widthMm: 176, heightMm: 125 });
  });

  it('許容差の範囲内なら規格値へ合わせる', () => {
    const match = matchOfficialSize({ widthMm: 87.3, heightMm: 55.5 }, 'idCard');
    expect(match.matched).toBe(true);
    expect(match.size).toEqual(ID1_CARD_SIZE_MM);
  });

  it('縦向きに置かれていても規格値と一致する', () => {
    const match = matchOfficialSize({ widthMm: 54.2, heightMm: 85.9 }, 'idCard');
    expect(match.matched).toBe(true);
    expect(match.size).toEqual({ widthMm: 53.98, heightMm: 85.6 });
  });

  it('規格外の寸法は実測のまま扱う', () => {
    // 名刺（91 x 55mm）は幅が規格から 6% 外れるが高さは近い。
    const match = matchOfficialSize({ widthMm: 130, heightMm: 40 }, 'idCard');
    expect(match.matched).toBe(false);
    expect(match.size).toEqual({ widthMm: 130, heightMm: 40 });
  });
});

describe('券面のきわが淡くても見切れない（実機不具合の再現）', () => {
  it('左と下のきわが淡い場合でも券面全体を含む', async () => {
    // 実機では左と下のきわの陰影が淡く、マスクから漏れて中心が右上へ偏っていた。
    const filePath = await whiteCardScan('faint-left-bottom.png', {
      faintEdges: ['left', 'bottom'],
      faintBandPx: 10,
    });
    const box = await cropBox(filePath);

    // 合成時の券面の真の位置（中央に配置している）。
    const cardX0 = (CANVAS_W - CARD_W) / 2;
    const cardY0 = (CANVAS_H - CARD_H) / 2;
    const cardX1 = cardX0 + CARD_W;
    const cardY1 = cardY0 + CARD_H;

    const toMm = (px: number) => (px / 300) * 25.4;
    const left = toMm(cardX0 - box.x0);
    const right = toMm(box.x1 - cardX1);
    const top = toMm(cardY0 - box.y0);
    const bottom = toMm(box.y1 - cardY1);

    expect(left, `左が ${left.toFixed(2)}mm 見切れています`).toBeGreaterThanOrEqual(0);
    expect(right, `右が ${right.toFixed(2)}mm 見切れています`).toBeGreaterThanOrEqual(0);
    expect(top, `上が ${top.toFixed(2)}mm 見切れています`).toBeGreaterThanOrEqual(0);
    expect(bottom, `下が ${bottom.toFixed(2)}mm 見切れています`).toBeGreaterThanOrEqual(0);
  });

  it('四辺すべてが淡い場合でも券面全体を含む', async () => {
    const filePath = await whiteCardScan('faint-all.png', {
      faintEdges: ['top', 'bottom', 'left', 'right'],
      faintBandPx: 10,
    });
    const box = await cropBox(filePath);

    const cardX0 = (CANVAS_W - CARD_W) / 2;
    const cardY0 = (CANVAS_H - CARD_H) / 2;
    const toMm = (px: number) => (px / 300) * 25.4;

    expect(toMm(cardX0 - box.x0)).toBeGreaterThanOrEqual(0);
    expect(toMm(box.x1 - (cardX0 + CARD_W))).toBeGreaterThanOrEqual(0);
    expect(toMm(cardY0 - box.y0)).toBeGreaterThanOrEqual(0);
    expect(toMm(box.y1 - (cardY0 + CARD_H))).toBeGreaterThanOrEqual(0);
  });
});

describe('同一カードの表裏で寸法が一致する', () => {
  it('きわの淡さや位置が違っても切り出しサイズは同一になる', async () => {
    // 表裏は同じ 1 枚のカードなので、検出サイズが異なることはありえない。
    const front = await whiteCardScan('front.png', {
      faintEdges: ['left', 'bottom'],
      faintBandPx: 10,
      centerX: 1200,
      centerY: 1600,
    });
    const back = await whiteCardScan('back.png', {
      faintEdges: ['right'],
      faintBandPx: 4,
      centerX: 1350,
      centerY: 1800,
      rotationDeg: 3,
    });

    const a = await cropBox(front);
    const b = await cropBox(back);

    expect(a.card.matched).toBe(true);
    expect(b.card.matched).toBe(true);
    expect(a.card.sizeMm).toEqual(b.card.sizeMm);
    expect(a.placement.sizeMm).toEqual(b.placement.sizeMm);
    expect(a.card.sizeMm).toEqual(ID1_CARD_SIZE_MM);
  });
});

describe('タイルは配置枠いっぱいになる', () => {
  it('券面は規格値、タイルはセルの大きさになる', async () => {
    const filePath = await whiteCardScan('tile.png');
    const { card, placement } = await cropBox(filePath);

    // 券面の大きさは規格値から与える。
    expect(card.sizeMm).toEqual(ID1_CARD_SIZE_MM);
    // タイルはセルいっぱい。隣接タイルと接しても重ならない。
    expect(placement.sizeMm).toEqual(CELL_SIZE_MM);
  });

  it('切り出し領域は券面より十分大きく、中心のずれを吸収できる', async () => {
    const filePath = await whiteCardScan('slack.png');
    const box = await cropBox(filePath);

    const toMm = (px: number) => (px / 300) * 25.4;
    const slackX = (toMm(box.x1 - box.x0) - ID1_CARD_SIZE_MM.widthMm) / 2;
    const slackY = (toMm(box.y1 - box.y0) - ID1_CARD_SIZE_MM.heightMm) / 2;

    // セル 95.0 x 69.3mm、券面 85.6 x 53.98mm -> 片側 4.7mm / 7.6mm の余裕
    expect(slackX).toBeGreaterThan(4);
    expect(slackY).toBeGreaterThan(7);
  });
});

describe('中心がずれても券面が欠けない（タイル方式の要点）', () => {
  it('中心の推定が 4mm ずれても券面は切り出し領域に完全に収まる', () => {
    // 券面の縁ではなく配置枠いっぱいを切り出すため、必要な精度は中心だけになる。
    // セル 95.0 x 69.3mm に対し券面 85.6 x 53.98mm なので、
    // 片側 4.7mm / 7.6mm の余裕がある。
    const dpi = 300;
    const trueCenter = { x: 1275, y: 1753 };
    const placement = resolvePlacement(ID1_CARD_SIZE_MM, 'idCard');

    for (const shiftMm of [-4, -2, 0, 2, 4]) {
      const shiftPx = (shiftMm / 25.4) * dpi;
      // 中心がずれて検出された四隅を作る（大きさは券面相当）。
      const half = { w: (85.6 / 25.4) * dpi * 0.5, h: (53.98 / 25.4) * dpi * 0.5 };
      const cx = trueCenter.x + shiftPx;
      const detected = {
        topLeft: { x: cx - half.w, y: trueCenter.y - half.h },
        topRight: { x: cx + half.w, y: trueCenter.y - half.h },
        bottomRight: { x: cx + half.w, y: trueCenter.y + half.h },
        bottomLeft: { x: cx - half.w, y: trueCenter.y + half.h },
      };

      const quad = cropQuad(detected, placement.cropSizeMm, dpi);
      const pts = quadToArray(quad);
      const x0 = Math.min(...pts.map((p) => p.x));
      const x1 = Math.max(...pts.map((p) => p.x));

      // 券面の真の範囲（ずれていない中心を基準）
      const cardX0 = trueCenter.x - half.w;
      const cardX1 = trueCenter.x + half.w;

      expect(x0, `中心が ${shiftMm}mm ずれたとき左が欠けています`).toBeLessThanOrEqual(cardX0);
      expect(x1, `中心が ${shiftMm}mm ずれたとき右が欠けています`).toBeGreaterThanOrEqual(cardX1);
    }
  });
});

describe('タイルは重ならない（仕様書 §7.1）', () => {
  it('セル寸法のタイルは隣接しても重ならず、隙間なく並ぶ', () => {
    const placement = resolvePlacement(ID1_CARD_SIZE_MM, 'idCard');
    const rects = Array.from({ length: CARDS_PER_PAGE }, (_, index) => {
      const cell = cellRect(index);
      return { x: cell.x, y: cell.y, w: placement.sizePx.width, h: placement.sizePx.height };
    });

    for (let i = 0; i < rects.length; i += 1) {
      for (let j = i + 1; j < rects.length; j += 1) {
        const a = rects[i]!;
        const b = rects[j]!;
        const overlaps = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
        expect(overlaps, `タイル ${i} と ${j} が重なっています`).toBe(false);
      }
    }

    // 隙間なく並ぶ（タイル幅がセル幅と一致する）
    expect(placement.sizePx.width).toBe(CELL_SIZE_PX.width);
    expect(placement.sizePx.height).toBe(CELL_SIZE_PX.height);
  });
});
