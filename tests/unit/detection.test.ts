/**
 * 検出・透視補正の結合テスト（仕様書 §10）。
 *
 * 合成画像のみを使い、実在の身分証は一切使わない。
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { detectCard, countEdgeTouches, rotatedRectCorners } from '@worker/detector';
import { createDetectionProxy, readHeader } from '@worker/imageIo';
import { warpQuad, rotate90 } from '@worker/warp';
import { boundingBox, quadCenter, translateQuad, warpTargetSize } from '@core/geometry/quad';
import { extractRegion } from '@worker/imageIo';
import { syntheticBlank, syntheticScan } from '../fixtures/synthetic';
import { faintScan } from '../fixtures/faintScan';

let workDir: string;

beforeAll(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), 'a4int-test-'));
});

afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
});

/** 合成画像を一時ファイルへ書き出し、そのパスを返す。 */
async function writeFixture(name: string, bytes: Buffer): Promise<string> {
  const filePath = path.join(workDir, name);
  await writeFile(filePath, bytes);
  return filePath;
}

/** 画像を検出し、原寸座標の四隅を得るまでの一連の流れ。 */
async function detect(filePath: string) {
  const proxy = await createDetectionProxy(filePath);
  return detectCard(proxy, proxy.scaleToOriginal);
}

describe('カード検出（仕様書 §5）', () => {
  it('淡い券面が離れて2枚ある場合は一枚に決めつけず複数候補を警告する', async () => {
    const filePath = await writeFixture(
      'two-faint.png',
      await faintScan({
        centerX: 700,
        centerY: 1000,
        secondCard: { centerX: 1800, centerY: 2300 },
      }),
    );
    const proxy = await createDetectionProxy(filePath);
    const result = await detectCard(proxy, proxy.scaleToOriginal, 300);
    expect(result.status).toBe('needsReview');
    expect(result.hasMultipleCandidates).toBe(true);
    const size = warpTargetSize(result.quad!);
    expect(Math.abs(size.width - 1011)).toBeLessThan(25);
    expect(Math.abs(size.height - 638)).toBeLessThan(25);
  });
  it.each([
    [635, 485],
    [680, 520],
  ])('暗い外周帯に近い位置の淡い券面も検出する（中心%i,%i）', async (centerX, centerY) => {
    const filePath = await writeFixture(
      `corner-${centerX}.png`,
      await faintScan({ centerX, centerY, uneven: true }),
    );
    const proxy = await createDetectionProxy(filePath);
    const result = await detectCard(proxy, proxy.scaleToOriginal, 300);
    expect(result.quad).not.toBeNull();
    const size = warpTargetSize(result.quad!);
    expect(Math.abs(size.width - 1011)).toBeLessThan(25);
    expect(Math.abs(size.height - 638)).toBeLessThan(25);
    expect(Math.abs(quadCenter(result.quad!).x - centerX)).toBeLessThan(15);
    expect(Math.abs(quadCenter(result.quad!).y - centerY)).toBeLessThan(15);
    expect(result.status).toBe('detected');
  });
  it.each([-25, 0, 25])(
    '外周に暗い帯があっても背景に近い券面全体を検出する（%i度）',
    async (rotationDeg) => {
      const filePath = await writeFixture(
        `faint-border-${rotationDeg}.png`,
        await faintScan({ rotationDeg }),
      );
      const proxy = await createDetectionProxy(filePath);
      const result = await detectCard(proxy, proxy.scaleToOriginal, 300);
      expect(result.quad).not.toBeNull();
      const size = warpTargetSize(result.quad!);
      expect(Math.abs(size.width - 1011)).toBeLessThan(25);
      expect(Math.abs(size.height - 638)).toBeLessThan(25);
      expect(Math.abs(quadCenter(result.quad!).x - 1400)).toBeLessThan(15);
      expect(Math.abs(quadCenter(result.quad!).y - 1800)).toBeLessThan(15);
      expect(result.status).toBe('detected');
    },
  );

  it('暗い外周帯だけの画像に券面を作り出さない', async () => {
    const filePath = await writeFixture('border-blank.png', await faintScan({ blank: true }));
    const proxy = await createDetectionProxy(filePath);
    expect((await detectCard(proxy, proxy.scaleToOriginal, 300)).quad).toBeNull();
  });

  it.each([false, true])(
    '緩やかな背景の濃淡とノイズがあっても券面だけを検出する（券面なし=%s）',
    async (blank) => {
      const filePath = await writeFixture(
        `uneven-${blank}.png`,
        await faintScan({ blank, uneven: true, rotationDeg: 12 }),
      );
      const proxy = await createDetectionProxy(filePath);
      const result = await detectCard(proxy, proxy.scaleToOriginal, 300);
      if (blank) {
        expect(result.quad).toBeNull();
      } else {
        expect(result.quad).not.toBeNull();
        const size = warpTargetSize(result.quad!);
        expect(Math.abs(size.width - 1011)).toBeLessThan(25);
        expect(Math.abs(size.height - 638)).toBeLessThan(25);
        expect(Math.abs(quadCenter(result.quad!).x - 1400)).toBeLessThan(15);
        expect(Math.abs(quadCenter(result.quad!).y - 1800)).toBeLessThan(15);
        expect(result.status).toBe('detected');
      }
    },
  );
  it.each([150, 600])('%i dpi の実寸カードを傾けても規格寸法で検出する', async (dpi) => {
    const scale = dpi / 300;
    const filePath = await writeFixture(
      `size-${dpi}.png`,
      await syntheticScan({
        canvasWidth: Math.round(2400 * scale),
        canvasHeight: Math.round(1800 * scale),
        cardWidth: Math.round(1011 * scale),
        cardHeight: Math.round(638 * scale),
        rotationDeg: -25,
        density: dpi,
      }),
    );
    const proxy = await createDetectionProxy(filePath);
    const result = await detectCard(proxy, proxy.scaleToOriginal, dpi);
    expect(result.status).toBe('detected');
    const size = warpTargetSize(result.quad!);
    expect((size.width / dpi) * 25.4).toBeCloseTo(85.6, 0);
    expect((size.height / dpi) * 25.4).toBeCloseTo(53.98, 0);
  });
  it('淡い券面の濃い印刷部分より、規格寸法に一致する外周を選ぶ', async () => {
    const filePath = await writeFixture(
      'faint-size.png',
      await syntheticScan({
        canvasWidth: 2480,
        canvasHeight: 3508,
        cardWidth: 1011,
        cardHeight: 638,
        centerX: 1500,
        centerY: 1800,
        backgroundColor: '#ffffff',
        cardColor: '#f6f6f6',
        density: 300,
      }),
    );
    const proxy = await createDetectionProxy(filePath);
    const result = await detectCard(proxy, proxy.scaleToOriginal, 300);
    expect(result.status).toBe('detected');
    expect(result.hasMultipleCandidates).toBe(false);
    const size = warpTargetSize(result.quad!);
    expect(size.width).toBeCloseTo(1011, -1);
    expect(size.height).toBeCloseTo(638, -1);
    expect(quadCenter(result.quad!).x).toBeCloseTo(1500, -1);
    expect(quadCenter(result.quad!).y).toBeCloseTo(1800, -1);
  });

  it('形が似ている規格外の矩形より実寸が一致する券面を選ぶ', async () => {
    const base = await syntheticScan({
      canvasWidth: 2400,
      canvasHeight: 1600,
      cardWidth: 1011,
      cardHeight: 638,
      centerX: 1750,
      centerY: 500,
      density: 300,
    });
    const distractor = await sharp({
      create: { width: 856, height: 540, channels: 3, background: '#205090' },
    })
      .png()
      .toBuffer();
    const filePath = await writeFixture(
      'distractor.png',
      await sharp(base)
        .composite([{ input: distractor, left: 50, top: 950 }])
        .png()
        .toBuffer(),
    );
    const proxy = await createDetectionProxy(filePath);
    const result = await detectCard(proxy, proxy.scaleToOriginal, 300);
    expect(result.status).toBe('detected');
    expect(quadCenter(result.quad!).x).toBeCloseTo(1750, -1);
    expect(quadCenter(result.quad!).y).toBeCloseTo(500, -1);
  });

  it('閾値の違いで同じカードを複数と数えず、別のカードは複数と報告する', async () => {
    for (const twoCards of [false, true]) {
      const filePath = await writeFixture(
        `sized-${twoCards}.png`,
        await syntheticScan({
          canvasWidth: 2400,
          canvasHeight: 1600,
          cardWidth: 1011,
          cardHeight: 638,
          centerX: 600,
          centerY: 800,
          density: 300,
          ...(twoCards ? { secondCard: { color: '#2f6fb2', centerX: 1800, centerY: 800 } } : {}),
        }),
      );
      const proxy = await createDetectionProxy(filePath);
      const result = await detectCard(proxy, proxy.scaleToOriginal, 300);
      expect(result.hasMultipleCandidates).toBe(twoCards);
      expect(result.status).toBe(twoCards ? 'needsReview' : 'detected');
    }
  });

  it('淡色背景に置かれた濃色カードを検出する', async () => {
    const filePath = await writeFixture('plain.png', await syntheticScan());
    const result = await detect(filePath);

    expect(result.status).toBe('detected');
    expect(result.quad).not.toBeNull();
    expect(result.confidence).toBeGreaterThanOrEqual(0.75);
  });

  it('白背景でも検出できる（適応的閾値の確認）', async () => {
    const filePath = await writeFixture(
      'white-bg.png',
      await syntheticScan({ backgroundColor: '#ffffff', cardColor: '#3b7dd8' }),
    );
    const result = await detect(filePath);
    expect(result.status).not.toBe('failed');
  });

  it('灰色背景でも検出できる', async () => {
    const filePath = await writeFixture(
      'gray-bg.png',
      await syntheticScan({ backgroundColor: '#9a9a9a', cardColor: '#f5e6c8' }),
    );
    const result = await detect(filePath);
    expect(result.status).not.toBe('failed');
  });

  it('ノイズが乗っていても検出できる', async () => {
    const filePath = await writeFixture('noisy.png', await syntheticScan({ noise: 0.06 }));
    const result = await detect(filePath);
    expect(result.status).not.toBe('failed');
  });

  it('傾いたカードの四隅を捉える', async () => {
    const filePath = await writeFixture('tilted.png', await syntheticScan({ rotationDeg: 8 }));
    const result = await detect(filePath);

    expect(result.status).not.toBe('failed');
    const quad = result.quad!;
    // 傾いているので、上辺の 2 点は同じ y にならない。
    expect(Math.abs(quad.topLeft.y - quad.topRight.y)).toBeGreaterThan(10);
  });

  it('検出した四隅の寸法が元のカードとおおむね一致する', async () => {
    const filePath = await writeFixture(
      'measure.png',
      await syntheticScan({ cardWidth: 640, cardHeight: 404, rotationDeg: 0 }),
    );
    const result = await detect(filePath);
    const size = warpTargetSize(result.quad!);

    // プロキシ経由の量子化があるため 3% の許容を置く。
    expect(size.width).toBeGreaterThan(640 * 0.97);
    expect(size.width).toBeLessThan(640 * 1.03);
    expect(size.height).toBeGreaterThan(404 * 0.97);
    expect(size.height).toBeLessThan(404 * 1.03);
  });

  it('カードが画面の大半を占めていても検出できる（密着スキャン）', async () => {
    // 閾値の統計を画像全体から取ると、カードが多数派になった時点で中央値が
    // カード側へ移り、閾値が跳ね上がって何も検出できなくなる。
    // スキャナに密着させた実運用での撮り方なので、面積比の大きい側を必ず押さえる。
    const filePath = await writeFixture(
      'dominant.png',
      await syntheticScan({
        canvasWidth: 1200,
        canvasHeight: 900,
        cardWidth: 1100,
        cardHeight: 694,
      }),
    );
    const result = await detect(filePath);

    expect(result.status).not.toBe('failed');
    expect(result.quad).not.toBeNull();
  });

  it('面積比を変えても一貫して検出できる', async () => {
    // 面積比 0.2 から 0.8 まで、閾値の決め方が破綻しないことを確認する。
    for (const scale of [0.45, 0.6, 0.75, 0.9]) {
      const cardWidth = Math.round(1200 * scale);
      const cardHeight = Math.round(cardWidth / 1.585);
      const filePath = await writeFixture(
        `scale_${scale}.png`,
        await syntheticScan({ canvasWidth: 1200, canvasHeight: 900, cardWidth, cardHeight }),
      );
      const result = await detect(filePath);
      expect(result.status, `面積比 scale=${scale} で検出に失敗しました`).not.toBe('failed');
    }
  });

  it('左右 25 度までの傾きを検出できる（実運用の要件）', async () => {
    // スキャン時の身分証は完全な垂直状態ではなく、左右 25 度までの傾きが予期される。
    // 最小外接矩形は回転を厳密に表せるため、角度によらず実寸が復元できるはず。
    for (const angle of [-25, -18, -10, -5, 5, 10, 18, 25]) {
      const filePath = await writeFixture(
        `tilt_${angle}.png`,
        await syntheticScan({
          canvasWidth: 1600,
          canvasHeight: 1200,
          cardWidth: 700,
          cardHeight: 442,
          rotationDeg: angle,
        }),
      );
      const result = await detect(filePath);

      expect(result.status, `傾き ${angle} 度で検出に失敗しました`).not.toBe('failed');
      expect(result.quad, `傾き ${angle} 度で四隅が得られませんでした`).not.toBeNull();

      // 傾きがあっても実寸が復元される（見切れ・過剰包含がない）。
      const size = warpTargetSize(result.quad!);
      expect(size.width, `傾き ${angle} 度の幅`).toBeGreaterThan(700 * 0.95);
      expect(size.width, `傾き ${angle} 度の幅`).toBeLessThan(700 * 1.06);
      expect(size.height, `傾き ${angle} 度の高さ`).toBeGreaterThan(442 * 0.95);
      expect(size.height, `傾き ${angle} 度の高さ`).toBeLessThan(442 * 1.06);
    }
  });

  it('傾いたカードの四隅が実際に回転している（軸平行な矩形で代用していない）', async () => {
    const filePath = await writeFixture(
      'tilt_check.png',
      await syntheticScan({ canvasWidth: 1600, canvasHeight: 1200, rotationDeg: 20 }),
    );
    const quad = (await detect(filePath)).quad!;

    // 20 度傾いていれば、上辺の 2 点の y 差は無視できない大きさになる。
    const topRise = Math.abs(quad.topLeft.y - quad.topRight.y);
    const topRun = Math.abs(quad.topLeft.x - quad.topRight.x);
    const measuredDeg = (Math.atan2(topRise, topRun) * 180) / Math.PI;
    expect(measuredDeg).toBeGreaterThan(15);
    expect(measuredDeg).toBeLessThan(25);
  });

  it('カードが無い画像は検出失敗になる', async () => {
    const filePath = await writeFixture('blank.png', await syntheticBlank());
    const result = await detect(filePath);

    expect(result.status).toBe('failed');
    expect(result.quad).toBeNull();
  });

  it('同等のカードが 2 枚あれば「要確認」として複数候補を報告する', async () => {
    const filePath = await writeFixture(
      'two-cards.png',
      await syntheticScan({
        canvasWidth: 1600,
        canvasHeight: 700,
        cardWidth: 520,
        cardHeight: 328,
        centerX: 420,
        centerY: 350,
        secondCard: { color: '#2f6fb2', centerX: 1180, centerY: 350 },
      }),
    );
    const result = await detect(filePath);

    expect(result.hasMultipleCandidates).toBe(true);
    expect(result.status).toBe('needsReview');
  });

  it('透過 PNG は白背景へ合成してから検出する', async () => {
    const filePath = await writeFixture(
      'alpha.png',
      await syntheticScan({ transparent: true, cardColor: '#1f5fa2' }),
    );
    const result = await detect(filePath);
    expect(result.status).not.toBe('failed');
  });

  it('JPEG でも TIFF でも検出できる', async () => {
    for (const format of ['jpeg', 'tiff'] as const) {
      const filePath = await writeFixture(`fmt.${format}`, await syntheticScan({ format }));
      const result = await detect(filePath);
      expect(result.status, `format=${format}`).not.toBe('failed');
    }
  });
});

describe('Exif 回転の反映（仕様書 §5）', () => {
  it('Orientation=6 の画像は回転後の寸法で扱われる', async () => {
    const bytes = await syntheticScan({
      canvasWidth: 1200,
      canvasHeight: 800,
      format: 'jpeg',
      orientation: 6,
    });
    const filePath = await writeFixture('exif6.jpg', bytes);
    const header = await readHeader(filePath);

    // Orientation 6 は 90 度回転。幅と高さが入れ替わって報告される必要がある。
    expect(header.width).toBe(800);
    expect(header.height).toBe(1200);
  });

  it('回転後の座標系で検出でき、四隅が画像内に収まる', async () => {
    const filePath = await writeFixture(
      'exif6-detect.jpg',
      await syntheticScan({ canvasWidth: 1200, canvasHeight: 800, format: 'jpeg', orientation: 6 }),
    );
    const header = await readHeader(filePath);
    const result = await detect(filePath);

    expect(result.status).not.toBe('failed');
    for (const point of Object.values(result.quad!)) {
      expect(point.x).toBeGreaterThanOrEqual(-2);
      expect(point.y).toBeGreaterThanOrEqual(-2);
      expect(point.x).toBeLessThanOrEqual(header.width + 2);
      expect(point.y).toBeLessThanOrEqual(header.height + 2);
    }
  });
});

describe('透視補正（仕様書 §5）', () => {
  it('傾いたカードを正面向きの矩形へ補正する', async () => {
    const filePath = await writeFixture('warp.png', await syntheticScan({ rotationDeg: 10 }));
    const header = await readHeader(filePath);
    const result = await detect(filePath);

    const quad = result.quad!;
    const box = boundingBox(quad, { width: header.width, height: header.height }, 2);
    const crop = await extractRegion(filePath, box);
    const warped = await warpQuad(crop, translateQuad(quad, box));

    const expected = warpTargetSize(quad);
    expect(warped.width).toBe(expected.width);
    expect(warped.height).toBe(expected.height);
    expect(warped.channels).toBe(3);
    // 補正後はカードのアスペクト比（640:404 ≒ 1.584）へ戻る。
    expect(warped.width / warped.height).toBeCloseTo(640 / 404, 1);
  });

  it('原寸で扱うのはカード外接矩形だけである', async () => {
    const filePath = await writeFixture('bounded.png', await syntheticScan());
    const header = await readHeader(filePath);
    const result = await detect(filePath);

    const box = boundingBox(result.quad!, { width: header.width, height: header.height });
    const fullArea = header.width * header.height;
    const cropArea = box.width * box.height;

    // ページ全体を切り出していたら、この比は 1 に近づく。
    expect(cropArea / fullArea).toBeLessThan(0.7);
  });
});

describe('90 度回転（仕様書 §7.3）', () => {
  it('幅と高さが入れ替わる', async () => {
    const source = {
      data: Buffer.alloc(30 * 20 * 3, 128),
      width: 30,
      height: 20,
      channels: 3,
    };
    const rotated = await rotate90(source);

    expect(rotated.width).toBe(20);
    expect(rotated.height).toBe(30);
    expect(rotated.data.length).toBe(20 * 30 * 3);
  });

  it('画素の内容が保たれる（左下の画素が左上へ移る）', async () => {
    const width = 4;
    const height = 3;
    const data = Buffer.alloc(width * height * 3, 0);
    // 左下 (0, 2) を赤にする。
    const bottomLeft = (2 * width + 0) * 3;
    data[bottomLeft] = 255;

    const rotated = await rotate90({ data, width, height, channels: 3 });

    // 時計回り 90 度で、左下は左上へ移動する。
    expect(rotated.data[0]).toBe(255);
    expect(rotated.data[1]).toBe(0);
  });
});

describe('補助関数', () => {
  it('端に接する辺の数を数える', () => {
    const corners = [
      { x: 0, y: 0 },
      { x: 99, y: 0 },
      { x: 99, y: 99 },
      { x: 0, y: 99 },
    ];
    expect(countEdgeTouches(corners, 100, 100)).toBe(4);

    const inner = [
      { x: 10, y: 10 },
      { x: 80, y: 10 },
      { x: 80, y: 80 },
      { x: 10, y: 80 },
    ];
    expect(countEdgeTouches(inner, 100, 100)).toBe(0);
  });

  it('回転矩形の 4 頂点を求める（boxPoints に依存しない）', () => {
    const corners = rotatedRectCorners({
      center: { x: 100, y: 100 },
      size: { width: 40, height: 20 },
      angle: 0,
    });

    expect(corners).toEqual([
      { x: 80, y: 90 },
      { x: 120, y: 90 },
      { x: 120, y: 110 },
      { x: 80, y: 110 },
    ]);
  });

  it('90 度回転した矩形の頂点は幅と高さを入れ替えたものになる', () => {
    const corners = rotatedRectCorners({
      center: { x: 0, y: 0 },
      size: { width: 40, height: 20 },
      angle: 90,
    });
    const xs = corners.map((p) => p.x);
    const ys = corners.map((p) => p.y);

    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(20, 6);
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(40, 6);
  });
});
