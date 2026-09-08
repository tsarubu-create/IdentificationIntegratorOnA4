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
import { officialCrop, CROP_BLEED_MM } from '@core/standards/officialCrop';
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

/** 検出して規格値へ合わせた切り出し枠の、軸平行な範囲を返す。 */
async function cropBox(filePath: string) {
  const proxy = await createDetectionProxy(filePath);
  const result = await detectCard(proxy, proxy.scaleToOriginal);
  expect(result.quad, '検出に失敗しました').not.toBeNull();

  const crop = officialCrop(result.quad!, 'idCard', 300);
  const pts = quadToArray(crop.quad);
  return {
    crop,
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

    expect(a.crop.matched).toBe(true);
    expect(b.crop.matched).toBe(true);
    expect(a.crop.cardSizeMm).toEqual(b.crop.cardSizeMm);
    expect(a.crop.sizeMm).toEqual(b.crop.sizeMm);
    expect(a.crop.cardSizeMm).toEqual(ID1_CARD_SIZE_MM);
  });
});

describe('余白（ブリード）', () => {
  it('配置サイズは規格値に余白を加えたものになる', async () => {
    const filePath = await whiteCardScan('bleed.png');
    const { crop } = await cropBox(filePath);

    expect(crop.cardSizeMm).toEqual(ID1_CARD_SIZE_MM);
    expect(crop.sizeMm.widthMm).toBeCloseTo(ID1_CARD_SIZE_MM.widthMm + CROP_BLEED_MM * 2, 6);
    expect(crop.sizeMm.heightMm).toBeCloseTo(ID1_CARD_SIZE_MM.heightMm + CROP_BLEED_MM * 2, 6);
  });
});
