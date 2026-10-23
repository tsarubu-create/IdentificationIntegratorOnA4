import { mkdtemp, rm, writeFile, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { analyzeImage } from '@worker/analyze';
import { editImage } from '@worker/editor';
import { composePages } from '@worker/compose';
import { ensureOutputDirectory } from '@worker/output';
import { quadCenter } from '@core/geometry/quad';
import { buildComposeItems } from '../../src/main/job';
import type { AnalyzeTaskResult } from '@shared/workerProtocol';
import { countIncludable } from '@renderer/includable';
import { syntheticBlank, syntheticScan } from '../fixtures/synthetic';

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'a4int-edit-'));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

async function fixture(bytes: Buffer): Promise<{ filePath: string; analysis: AnalyzeTaskResult }> {
  const filePath = path.join(directory, 'scan.png');
  await writeFile(filePath, bytes);
  const analysis = await analyzeImage({ id: 'scan.png', relativePath: 'scan.png', filePath });
  return { filePath, analysis: { ...analysis, sourceWidth: 2400, sourceHeight: 1800 } };
}

describe('編集画面から出力まで', () => {
  it('旅券見開きの手動調整も規格寸法と90度回転のサムネイルに反映する', async () => {
    const item = await fixture(await syntheticBlank(2400, 1800));
    const { updated } = await editImage({
      ...item,
      kind: 'passportSpread',
      adjustment: { centerX: 1200, centerY: 900, angleDegrees: 0 },
    });
    expect(updated!.image.kind).toBe('passportSpread');
    expect(updated!.image.cardSizeMm).toEqual({ widthMm: 176, heightMm: 125 });
    expect(updated!.image.exclusion).toBeNull();
    const thumbnail = await sharp(Buffer.from(updated!.image.thumbnail!)).metadata();
    expect(thumbnail.width / thumbnail.height).toBeCloseTo(190 / 277, 1);
  });
  it('開いて破棄しただけなら解析結果・入力・出力フォルダに変更を加えない', async () => {
    const item = await fixture(await syntheticBlank(2400, 1800));
    const original = structuredClone(item.analysis);
    const input = await readFile(item.filePath);
    const loaded = await editImage({ ...item, kind: 'idCard', adjustment: null });
    expect(loaded.updated).toBeNull();
    expect(loaded.preview.sourceWidth).toBe(2400);
    expect(loaded.preview.bytes.byteLength).toBeGreaterThan(0);
    expect(item.analysis).toEqual(original);
    expect(await readFile(item.filePath)).toEqual(input);
    expect(await readdir(directory)).toEqual(['scan.png']);
  });

  it('検出失敗を手動修正すると、サムネイルと出力対象が更新される', async () => {
    const item = await fixture(await syntheticBlank(2400, 1800));
    expect(item.analysis.image.exclusion).toBe('detectionFailed');
    const { updated } = await editImage({
      ...item,
      kind: 'idCard',
      adjustment: { centerX: 700, centerY: 500, angleDegrees: 10 },
    });
    expect(updated!.image.exclusion).toBeNull();
    expect(updated!.image.warnings).toEqual(['dpiMissing', 'manualAdjustment']);
    expect(updated!.image.cardSizeMm).toEqual({ widthMm: 85.6, heightMm: 53.98 });
    expect(updated!.image.thumbnail!.byteLength).toBeGreaterThan(0);
    expect(quadCenter(updated!.quad!)).toEqual({ x: 700, y: 500 });
    expect(countIncludable([updated!.image], {})).toBe(1);
  });

  it('自動検出位置と異なる手動位置を、確認用画像とA4出力の両方に使う', async () => {
    const bytes = await syntheticScan({
      canvasWidth: 2400,
      canvasHeight: 1800,
      cardWidth: 1011,
      cardHeight: 638,
      centerX: 700,
      centerY: 500,
      cardColor: '#205090',
      withInnerPattern: false,
      density: 300,
    });
    const item = await fixture(bytes);
    const before = await readFile(item.filePath);
    const wrong = {
      ...item.analysis,
      quad: {
        topLeft: { x: 1450, y: 1150 },
        topRight: { x: 1850, y: 1150 },
        bottomRight: { x: 1850, y: 1450 },
        bottomLeft: { x: 1450, y: 1450 },
      },
    };
    const { updated } = await editImage({
      filePath: item.filePath,
      analysis: wrong,
      kind: 'idCard',
      adjustment: { centerX: 700, centerY: 500, angleDegrees: 0 },
    });
    const items = buildComposeItems(
      {
        inputFolder: directory,
        outputDirectory: directory,
        order: ['scan.png'],
        results: new Map([['scan.png', updated!]]),
      },
      {},
    );
    const output = await ensureOutputDirectory(directory);
    const pages = await composePages(items, { outputDirectory: output });
    expect(pages.fileNames).toHaveLength(1);
    const page = await sharp(path.join(output, pages.fileNames[0]!))
      .extract({ left: 118, top: 118, width: 1122, height: 818 })
      .resize(240, 175)
      .removeAlpha()
      .raw()
      .toBuffer();
    const thumb = await sharp(Buffer.from(updated!.image.thumbnail!))
      .resize(240, 175)
      .removeAlpha()
      .raw()
      .toBuffer();
    expect(
      thumb.reduce((sum, value, index) => sum + Math.abs(value - page[index]!), 0) / thumb.length,
    ).toBeLessThan(5);
    const center = (87 * 240 + 120) * 3;
    expect(page[center]).toBeLessThan(80);
    expect(page[center + 2]).toBeGreaterThan(110);
    expect(await readFile(item.filePath)).toEqual(before);
  });

  it('画像外の指定や安全上限により除外された画像は復帰させない', async () => {
    const item = await fixture(await syntheticBlank(2400, 1800));
    await expect(
      editImage({
        ...item,
        kind: 'idCard',
        adjustment: { centerX: 1, centerY: 1, angleDegrees: 0 },
      }),
    ).rejects.toThrow();
    await expect(
      editImage({
        ...item,
        analysis: {
          ...item.analysis,
          image: { ...item.analysis.image, exclusion: 'tooManyPixels' },
        },
        kind: 'idCard',
        adjustment: null,
      }),
    ).rejects.toThrow('編集できません');
    expect(item.analysis.image.exclusion).toBe('detectionFailed');
  });
});
