/**
 * 解析から出力までの結合テスト（仕様書 §3 / §4 / §6 / §7 / §9 / §10）。
 */

import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { analyzeImage } from '@worker/analyze';
import { type ComposeItem, composePages } from '@worker/compose';
import { readHeader } from '@worker/imageIo';
import { ensureOutputDirectory, resolveStartSequence, writePageExclusive } from '@worker/output';
import { scanImages } from '@core/scan/scanner';
import { PAGE_SIZE_PX } from '@core/layout/a4';
import { corruptImageBytes, syntheticBlank, syntheticScan } from '../fixtures/synthetic';

let root: string;
let inputDir: string;
let outputRoot: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'a4int-pipe-'));
  inputDir = path.join(root, 'input');
  outputRoot = path.join(root, 'output');
  await mkdir(inputDir, { recursive: true });
  await mkdir(outputRoot, { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function putImage(relativePath: string, bytes: Buffer): Promise<string> {
  const filePath = path.join(inputDir, relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, bytes);
  return filePath;
}

/** 300dpi で ID-1 カード相当（1011x638px）になる合成画像。 */
function cardScanBytes(overrides = {}): Promise<Buffer> {
  return syntheticScan({
    canvasWidth: 1600,
    canvasHeight: 1200,
    cardWidth: 1011,
    cardHeight: 638,
    density: 300,
    ...overrides,
  });
}

/** 解析結果を出力対象へ変換する。 */
async function toComposeItem(
  filePath: string,
  relativePath: string,
  kind: 'idCard' | 'passportSpread' = 'idCard',
): Promise<ComposeItem> {
  const analysis = await analyzeImage({ id: relativePath, filePath, relativePath });
  const header = await readHeader(filePath);

  expect(analysis.quad, `${relativePath} の検出に失敗しました`).not.toBeNull();
  return {
    id: relativePath,
    relativePath,
    filePath,
    quad: analysis.quad!,
    cardSizeMm: analysis.image.physicalSize!,
    kind,
    ignoreIcc: analysis.ignoreIcc,
    sourceWidth: header.width,
    sourceHeight: header.height,
  };
}

describe('解析フェーズ（仕様書 §5 / §6 / §8）', () => {
  it('DPI つきカード画像から物理サイズを算出する', async () => {
    const filePath = await putImage('card.png', await cardScanBytes());
    const analysis = await analyzeImage({ id: '1', filePath, relativePath: 'card.png' });

    expect(analysis.image.status).not.toBe('failed');
    expect(analysis.image.embeddedDpi).toBe(300);
    expect(analysis.image.effectiveDpi).toBe(300);
    expect(analysis.image.physicalSize!.widthMm).toBeCloseTo(85.6, 0);
    expect(analysis.image.physicalSize!.heightMm).toBeCloseTo(54.0, 0);
    expect(analysis.image.exclusion).toBeNull();
  });

  it('DPI が無ければ 300dpi として扱い警告を出す', async () => {
    const filePath = await putImage('nodpi.png', await cardScanBytes({ density: null }));
    const analysis = await analyzeImage({ id: '1', filePath, relativePath: 'nodpi.png' });

    expect(analysis.image.embeddedDpi).toBeNull();
    expect(analysis.image.effectiveDpi).toBe(300);
    expect(analysis.image.warnings).toContain('dpiMissing');
  });

  it('600dpi の画像は物理サイズが半分として算出される', async () => {
    const filePath = await putImage('dpi600.png', await cardScanBytes({ density: 600 }));
    const analysis = await analyzeImage({ id: '1', filePath, relativePath: 'dpi600.png' });

    expect(analysis.image.effectiveDpi).toBe(600);
    expect(analysis.image.physicalSize!.widthMm).toBeCloseTo(42.8, 0);
  });

  it('サムネイルをメモリ上に持ち、ディスクへは書き出さない', async () => {
    const filePath = await putImage('thumb.png', await cardScanBytes());
    const before = await readdir(inputDir);
    const analysis = await analyzeImage({ id: '1', filePath, relativePath: 'thumb.png' });

    expect(analysis.image.thumbnail).toBeInstanceOf(ArrayBuffer);
    expect(analysis.image.thumbnail!.byteLength).toBeGreaterThan(0);
    // 解析でファイルが増えていないこと（一時ファイルを作っていない）。
    expect(await readdir(inputDir)).toEqual(before);
  });

  it('検出できない画像は理由付きで除外される（停止しない）', async () => {
    const filePath = await putImage('blank.png', await syntheticBlank());
    const analysis = await analyzeImage({ id: '1', filePath, relativePath: 'blank.png' });

    expect(analysis.image.status).toBe('failed');
    expect(analysis.image.exclusion).toBe('detectionFailed');
    expect(analysis.quad).toBeNull();
  });

  it('破損ファイルは例外を投げずに除外される（仕様書 §3）', async () => {
    const filePath = await putImage('broken.png', corruptImageBytes());
    const analysis = await analyzeImage({ id: '1', filePath, relativePath: 'broken.png' });

    expect(analysis.image.exclusion).toBe('decodeFailed');
    expect(analysis.image.status).toBe('failed');
  });

  it('低 DPI で物理サイズが大きくなりすぎる画像はセル超過で除外される', async () => {
    // 150dpi で 1011px 幅 -> 171mm。セル幅 95mm に収まらない。
    const filePath = await putImage('big.png', await cardScanBytes({ density: 150 }));
    const analysis = await analyzeImage({ id: '1', filePath, relativePath: 'big.png' });

    expect(analysis.image.physicalSize!.widthMm).toBeGreaterThan(95);
    expect(analysis.image.exclusion).toBe('doesNotFitCell');
  });
});

describe('入力の不変性（仕様書 §3）', () => {
  it('解析と出力の前後で入力ファイルが一切変化しない', async () => {
    const bytes = await cardScanBytes();
    const filePath = await putImage('sub/card.png', bytes);

    const before = await stat(filePath);
    const hashBefore = createHash('sha256')
      .update(await readFile(filePath))
      .digest('hex');

    const item = await toComposeItem(filePath, 'sub/card.png');
    const directory = await ensureOutputDirectory(outputRoot);
    await composePages([item], { outputDirectory: directory });

    const after = await stat(filePath);
    const hashAfter = createHash('sha256')
      .update(await readFile(filePath))
      .digest('hex');

    expect(hashAfter).toBe(hashBefore);
    expect(after.size).toBe(before.size);
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });

  it('入力フォルダにファイルが増減しない', async () => {
    await putImage('a.png', await cardScanBytes());
    await putImage('b.png', await cardScanBytes());
    const before = (await readdir(inputDir)).sort();

    for (const name of ['a.png', 'b.png']) {
      await analyzeImage({
        id: name,
        filePath: path.join(inputDir, name),
        relativePath: name,
      });
    }

    expect((await readdir(inputDir)).sort()).toEqual(before);
  });
});

describe('出力フォルダの走査除外（仕様書 §3 / §4）', () => {
  it('出力先が入力フォルダ内にあっても走査対象にならない', async () => {
    await putImage('scan1.png', await cardScanBytes());

    // 出力先を入力フォルダの中に作る。
    const nestedOutputRoot = inputDir;
    const directory = await ensureOutputDirectory(nestedOutputRoot);
    await writeFile(path.join(directory, 'integrated_A4_001.png'), await syntheticBlank());

    const result = await scanImages({
      inputRoot: inputDir,
      excludedDirectories: [directory],
    });

    expect(result.files).toEqual(['scan1.png']);
    expect(result.files.some((f) => f.includes('A4Integrate'))).toBe(false);
  });

  it('存在しない出力先を指定しても走査は成功する', async () => {
    await putImage('scan1.png', await cardScanBytes());
    const result = await scanImages({
      inputRoot: inputDir,
      excludedDirectories: [path.join(outputRoot, 'A4Integrate')],
    });
    expect(result.files).toEqual(['scan1.png']);
  });

  it('対象拡張子だけを大文字小文字を区別せず拾う', async () => {
    await putImage('a.JPG', await cardScanBytes({ format: 'jpeg' }));
    await putImage('b.TIFF', await cardScanBytes({ format: 'tiff' }));
    await putImage('notes.txt', Buffer.from('not an image'));
    await putImage('deep/nested/c.png', await cardScanBytes());

    const result = await scanImages({ inputRoot: inputDir });

    expect([...result.files].sort()).toEqual(['a.JPG', 'b.TIFF', 'deep/nested/c.png']);
    expect(result.skippedCount).toBe(1);
  });
});

describe('出力ファイルの生成（仕様書 §4 / §6 / §7）', () => {
  it('A4 300dpi の PNG が生成される', async () => {
    const filePath = await putImage('card.png', await cardScanBytes());
    const item = await toComposeItem(filePath, 'card.png');
    const directory = await ensureOutputDirectory(outputRoot);

    const outcome = await composePages([item], { outputDirectory: directory });

    expect(outcome.fileNames).toEqual(['integrated_A4_001.png']);
    const meta = await sharp(path.join(directory, 'integrated_A4_001.png')).metadata();
    expect(meta.width).toBe(PAGE_SIZE_PX.width);
    expect(meta.height).toBe(PAGE_SIZE_PX.height);
    expect(meta.density).toBe(300);
    expect(meta.format).toBe('png');
  });

  it('9 枚のカードは 2 ページに分割される', async () => {
    const items: ComposeItem[] = [];
    for (let i = 1; i <= 9; i += 1) {
      const name = `card_${String(i).padStart(2, '0')}.png`;
      const filePath = await putImage(name, await cardScanBytes());
      items.push(await toComposeItem(filePath, name));
    }

    const directory = await ensureOutputDirectory(outputRoot);
    const outcome = await composePages(items, { outputDirectory: directory });

    expect(outcome.fileNames).toEqual(['integrated_A4_001.png', 'integrated_A4_002.png']);
  });

  it('パスポート見開きは単独ページになり、カードと混載されない', async () => {
    const cardPath = await putImage('a_card.png', await cardScanBytes());
    // 見開き相当（176x125mm @300dpi = 2079x1476px）。回転後 125x176mm。
    const passportPath = await putImage(
      'b_passport.png',
      await syntheticScan({
        canvasWidth: 2400,
        canvasHeight: 1800,
        cardWidth: 2079,
        cardHeight: 1476,
        density: 300,
      }),
    );
    const cardPath2 = await putImage('c_card.png', await cardScanBytes());

    const items = [
      await toComposeItem(cardPath, 'a_card.png'),
      await toComposeItem(passportPath, 'b_passport.png', 'passportSpread'),
      await toComposeItem(cardPath2, 'c_card.png'),
    ];

    const directory = await ensureOutputDirectory(outputRoot);
    const outcome = await composePages(items, { outputDirectory: directory });

    // カードページ -> パスポート単独ページ -> カードページ の 3 枚。
    expect(outcome.fileNames).toHaveLength(3);
    expect(outcome.excluded).toEqual([]);
  });

  it('既存の連番を上書きせず、続きから採番する', async () => {
    const directory = await ensureOutputDirectory(outputRoot);
    const existing = path.join(directory, 'integrated_A4_001.png');
    await writeFile(existing, await syntheticBlank());
    const existingHash = createHash('sha256')
      .update(await readFile(existing))
      .digest('hex');

    const filePath = await putImage('card.png', await cardScanBytes());
    const item = await toComposeItem(filePath, 'card.png');
    const outcome = await composePages([item], { outputDirectory: directory });

    expect(outcome.fileNames).toEqual(['integrated_A4_002.png']);
    // 既存ファイルが変化していないこと。
    expect(
      createHash('sha256')
        .update(await readFile(existing))
        .digest('hex'),
    ).toBe(existingHash);
  });

  it('排他作成により、採番後に割り込まれても上書きしない', async () => {
    const directory = await ensureOutputDirectory(outputRoot);
    const sequence = await resolveStartSequence(directory);

    // 採番した直後に、他プロセスが同じ名前で書いた状況を作る。
    const intruder = path.join(directory, 'integrated_A4_001.png');
    await writeFile(intruder, Buffer.from('intruder'));

    const written = await writePageExclusive(directory, sequence, Buffer.from('ours'));

    expect(written.fileName).toBe('integrated_A4_002.png');
    expect(await readFile(intruder, 'utf8')).toBe('intruder');
  });

  it('収まらない対象は縮小せず除外し、理由を返す', async () => {
    const filePath = await putImage('big.png', await cardScanBytes({ density: 150 }));
    const analysis = await analyzeImage({ id: '1', filePath, relativePath: 'big.png' });
    const header = await readHeader(filePath);

    const item: ComposeItem = {
      id: '1',
      relativePath: 'big.png',
      filePath,
      quad: analysis.quad!,
      cardSizeMm: analysis.image.physicalSize!,
      kind: 'idCard',
      ignoreIcc: false,
      sourceWidth: header.width,
      sourceHeight: header.height,
    };

    const directory = await ensureOutputDirectory(outputRoot);
    const outcome = await composePages([item], { outputDirectory: directory });

    expect(outcome.fileNames).toEqual([]);
    expect(outcome.excluded).toEqual([{ relativePath: 'big.png', reason: 'doesNotFitCell' }]);
  });

  it('出力対象が無ければページを作らない', async () => {
    const directory = await ensureOutputDirectory(outputRoot);
    const outcome = await composePages([], { outputDirectory: directory });

    expect(outcome.fileNames).toEqual([]);
    expect(await readdir(directory)).toEqual([]);
  });
});
