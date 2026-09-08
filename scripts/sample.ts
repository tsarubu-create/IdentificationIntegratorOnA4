/**
 * 現時点のパイプラインで実際の A4 出力を作り、目視確認できるようにする。
 * 合成画像のみを使用する。
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { analyzeImage } from '@worker/analyze';
import { type ComposeItem, composePages } from '@worker/compose';
import { readHeader } from '@worker/imageIo';
import { ensureOutputDirectory } from '@worker/output';
import { syntheticScan } from '../tests/fixtures/synthetic';

const OUT = process.env.SAMPLE_OUT ?? path.resolve('sample-out');

const CARD_COLORS = [
  '#2f6fb2',
  '#b25f2f',
  '#3f8f5f',
  '#8f3f7f',
  '#2f8f8f',
  '#7f6f2f',
  '#5f4fa2',
  '#a2404f',
  '#4f7f2f',
];

async function main(): Promise<void> {
  await rm(OUT, { recursive: true, force: true });
  const input = path.join(OUT, 'input');
  await mkdir(input, { recursive: true });

  const items: ComposeItem[] = [];

  // カード 9 枚（傾き・背景色・DPI をばらけさせる）
  for (let i = 0; i < 9; i += 1) {
    const name = `card_${String(i + 1).padStart(2, '0')}.png`;
    const bytes = await syntheticScan({
      canvasWidth: 1600,
      canvasHeight: 1200,
      cardWidth: 1011,
      cardHeight: 638,
      cardColor: CARD_COLORS[i] ?? '#2f6fb2',
      backgroundColor: i % 3 === 0 ? '#ffffff' : i % 3 === 1 ? '#efeee9' : '#9a9a9a',
      rotationDeg: i % 4 === 0 ? 0 : (i % 4) * 3,
      density: 300,
      noise: i % 2 === 0 ? 0.03 : 0,
    });
    const filePath = path.join(input, name);
    await writeFile(filePath, bytes);
    items.push(await toItem(filePath, name, 'idCard'));
  }

  // パスポート見開き 1 枚（176x125mm @300dpi）
  const passportName = 'passport_01.png';
  const passportPath = path.join(input, passportName);
  await writeFile(
    passportPath,
    await syntheticScan({
      canvasWidth: 2400,
      canvasHeight: 1800,
      cardWidth: 2079,
      cardHeight: 1476,
      cardColor: '#1f4f7f',
      backgroundColor: '#e8e6e0',
      density: 300,
      rotationDeg: 2,
    }),
  );
  items.push(await toItem(passportPath, passportName, 'passportSpread'));

  const directory = await ensureOutputDirectory(OUT);
  const outcome = await composePages(items, { outputDirectory: directory });

  console.log('生成ページ:', outcome.fileNames.join(', '));
  console.log('除外:', outcome.excluded.length === 0 ? 'なし' : JSON.stringify(outcome.excluded));

  // 目視用に縮小版も作る（A4 原寸は 2480x3508 で大きいため）
  for (const name of outcome.fileNames) {
    const full = path.join(directory, name);
    const meta = await sharp(full).metadata();
    console.log(`  ${name}: ${meta.width}x${meta.height}px, ${meta.density}dpi`);
    await sharp(full)
      .resize({ width: 800 })
      .png()
      .toFile(path.join(OUT, `preview_${name}`));
  }
}

async function toItem(
  filePath: string,
  relativePath: string,
  kind: 'idCard' | 'passportSpread',
): Promise<ComposeItem> {
  const analysis = await analyzeImage({ id: relativePath, filePath, relativePath });
  const header = await readHeader(filePath);
  if (analysis.quad === null) throw new Error(`検出失敗: ${relativePath}`);

  console.log(
    `${relativePath}: ${analysis.image.status} ` +
      `conf=${analysis.image.confidence?.toFixed(3)} ` +
      `${analysis.image.physicalSize!.widthMm.toFixed(1)}x` +
      `${analysis.image.physicalSize!.heightMm.toFixed(1)}mm ` +
      `dpi=${analysis.image.effectiveDpi}` +
      (analysis.image.warnings.length > 0 ? ` warn=${analysis.image.warnings.join(',')}` : ''),
  );

  return {
    id: relativePath,
    relativePath,
    filePath,
    quad: analysis.quad,
    cardSizeMm: analysis.image.cardSizeMm!,
    kind,
    ignoreIcc: analysis.ignoreIcc,
    effectiveDpi: analysis.image.effectiveDpi,
    sourceWidth: header.width,
    sourceHeight: header.height,
  };
}

await main();
