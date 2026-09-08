/**
 * テスト用の合成画像を **コードから生成** する（仕様書 §10）。
 *
 * 実在する身分証・個人画像は一切使わない。生成物もリポジトリへコミットしない
 * （`.gitignore` で画像拡張子を既定除外している）。
 */

import sharp from 'sharp';
import type { OverlayOptions, WriteableMetadata } from 'sharp';

/** 合成スキャン画像の指定。 */
export interface SyntheticScanOptions {
  /** 出力画像の幅（画素） */
  readonly canvasWidth?: number;
  /** 出力画像の高さ（画素） */
  readonly canvasHeight?: number;
  /** 背景色（スキャナのフタや台紙を模す） */
  readonly backgroundColor?: string;
  /** カードの地色 */
  readonly cardColor?: string;
  /** カードの幅（画素） */
  readonly cardWidth?: number;
  /** カードの高さ（画素） */
  readonly cardHeight?: number;
  /** カードの傾き（度）。時計回り */
  readonly rotationDeg?: number;
  /** カード中心の位置（省略時は画像中心） */
  readonly centerX?: number;
  readonly centerY?: number;
  /** 埋め込む解像度（dpi）。null なら埋め込まない */
  readonly density?: number | null;
  /** 出力形式 */
  readonly format?: 'png' | 'jpeg' | 'tiff';
  /** Exif Orientation（JPEG のみ有効） */
  readonly orientation?: number;
  /** カード内部に模様（文字を模した帯）を描くか */
  readonly withInnerPattern?: boolean;
  /** ガウス風のノイズ量（0..1） */
  readonly noise?: number;
  /** 2 枚目のカードを置く（複数候補のテスト用） */
  readonly secondCard?: {
    readonly color: string;
    readonly centerX: number;
    readonly centerY: number;
  };
  /** 透過 PNG として出力する（背景を透明にする） */
  readonly transparent?: boolean;
  /**
   * 指定した辺のきわを、背景に近い淡い色で塗る。
   *
   * 実機の白い身分証（運転免許証・マイナンバーカード）を白いスキャナ背景で
   * 読んだときの再現。券面のきわの陰影が淡く、色差マスクから漏れる状況を作る。
   */
  readonly faintEdges?: readonly ('top' | 'bottom' | 'left' | 'right')[];
  /** 淡くする帯の幅（画素） */
  readonly faintBandPx?: number;
  /** 淡い帯の色（省略時は背景に近い色） */
  readonly faintColor?: string;
}

const DEFAULTS = {
  canvasWidth: 1200,
  canvasHeight: 900,
  backgroundColor: '#f2f2f0',
  cardColor: '#2f6fb2',
  cardWidth: 640,
  cardHeight: 404,
  rotationDeg: 0,
  format: 'png' as const,
  withInnerPattern: true,
};

/** 1 枚のカード画像（傾き適用済み）を作る。 */
async function renderCard(
  width: number,
  height: number,
  color: string,
  rotationDeg: number,
  backgroundColor: string,
  withInnerPattern: boolean,
  faintEdges: readonly ('top' | 'bottom' | 'left' | 'right')[] = [],
  faintBandPx = 6,
  faintColor = '#f4f4f2',
): Promise<{ buffer: Buffer; width: number; height: number }> {
  let card = sharp({
    create: { width, height, channels: 3, background: color },
  });

  if (withInnerPattern) {
    // 文字や顔写真を模した内部パターン。モルフォロジーの close で穴が
    // 埋まることを確認するために入れている。
    const stripe = await sharp({
      create: {
        width: Math.round(width * 0.5),
        height: Math.round(height * 0.12),
        channels: 3,
        background: '#ffffff',
      },
    })
      .png()
      .toBuffer();
    const photo = await sharp({
      create: {
        width: Math.round(width * 0.22),
        height: Math.round(height * 0.42),
        channels: 3,
        background: '#dedede',
      },
    })
      .png()
      .toBuffer();

    card = sharp(await card.png().toBuffer()).composite([
      { input: stripe, left: Math.round(width * 0.08), top: Math.round(height * 0.2) },
      { input: stripe, left: Math.round(width * 0.08), top: Math.round(height * 0.45) },
      { input: photo, left: Math.round(width * 0.7), top: Math.round(height * 0.25) },
    ]);
  }

  if (faintEdges.length > 0) {
    // きわを背景に近い色で塗り、色差マスクから漏れる淡い縁を再現する。
    const band = Math.max(1, faintBandPx);
    const strip = async (w: number, h: number): Promise<Buffer> =>
      sharp({ create: { width: w, height: h, channels: 3, background: faintColor } })
        .png()
        .toBuffer();

    const overlays: OverlayOptions[] = [];
    if (faintEdges.includes('top'))
      overlays.push({ input: await strip(width, band), left: 0, top: 0 });
    if (faintEdges.includes('bottom'))
      overlays.push({ input: await strip(width, band), left: 0, top: height - band });
    if (faintEdges.includes('left'))
      overlays.push({ input: await strip(band, height), left: 0, top: 0 });
    if (faintEdges.includes('right'))
      overlays.push({ input: await strip(band, height), left: width - band, top: 0 });

    card = sharp(await card.png().toBuffer()).composite(overlays);
  }

  const rotated =
    rotationDeg === 0
      ? card
      : sharp(await card.png().toBuffer()).rotate(rotationDeg, { background: backgroundColor });

  const { data, info } = await rotated.png().toBuffer({ resolveWithObject: true });
  return { buffer: data, width: info.width, height: info.height };
}

/** ノイズを加えた背景を作る。 */
async function renderBackground(
  width: number,
  height: number,
  color: string,
  noise: number,
  transparent: boolean,
): Promise<Buffer> {
  const base = transparent
    ? sharp({
        create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
      })
    : sharp({ create: { width, height, channels: 3, background: color } });

  if (noise <= 0) return base.png().toBuffer();

  const raw = await base.removeAlpha().raw().toBuffer();
  const amplitude = Math.round(noise * 255);
  for (let i = 0; i < raw.length; i += 1) {
    const delta = Math.round((Math.random() - 0.5) * 2 * amplitude);
    raw[i] = Math.min(255, Math.max(0, raw[i]! + delta));
  }

  return sharp(raw, { raw: { width, height, channels: 3 } })
    .png()
    .toBuffer();
}

/**
 * 合成スキャン画像を生成する。
 *
 * @returns 画像のバイト列
 */
export async function syntheticScan(options: SyntheticScanOptions = {}): Promise<Buffer> {
  const canvasWidth = options.canvasWidth ?? DEFAULTS.canvasWidth;
  const canvasHeight = options.canvasHeight ?? DEFAULTS.canvasHeight;
  const backgroundColor = options.backgroundColor ?? DEFAULTS.backgroundColor;
  const cardColor = options.cardColor ?? DEFAULTS.cardColor;
  const cardWidth = options.cardWidth ?? DEFAULTS.cardWidth;
  const cardHeight = options.cardHeight ?? DEFAULTS.cardHeight;
  const rotationDeg = options.rotationDeg ?? DEFAULTS.rotationDeg;
  const format = options.format ?? DEFAULTS.format;
  const withInnerPattern = options.withInnerPattern ?? DEFAULTS.withInnerPattern;
  const transparent = options.transparent ?? false;

  const backgroundBuffer = await renderBackground(
    canvasWidth,
    canvasHeight,
    backgroundColor,
    options.noise ?? 0,
    transparent,
  );

  const card = await renderCard(
    cardWidth,
    cardHeight,
    cardColor,
    rotationDeg,
    backgroundColor,
    withInnerPattern,
    options.faintEdges ?? [],
    options.faintBandPx ?? 6,
    options.faintColor ?? '#f4f4f2',
  );

  const centerX = options.centerX ?? Math.round(canvasWidth / 2);
  const centerY = options.centerY ?? Math.round(canvasHeight / 2);

  const composites: OverlayOptions[] = [
    {
      input: card.buffer,
      left: Math.round(centerX - card.width / 2),
      top: Math.round(centerY - card.height / 2),
    },
  ];

  if (options.secondCard !== undefined) {
    const second = await renderCard(
      cardWidth,
      cardHeight,
      options.secondCard.color,
      0,
      backgroundColor,
      withInnerPattern,
    );
    composites.push({
      input: second.buffer,
      left: Math.round(options.secondCard.centerX - second.width / 2),
      top: Math.round(options.secondCard.centerY - second.height / 2),
    });
  }

  let pipeline = sharp(backgroundBuffer).composite(composites);

  if (format === 'png') {
    pipeline = pipeline.png();
  } else if (format === 'jpeg') {
    pipeline = pipeline.flatten({ background: backgroundColor }).jpeg({ quality: 95 });
  } else {
    pipeline = pipeline.flatten({ background: backgroundColor }).tiff();
  }

  const metadata: WriteableMetadata = {};
  if (options.density !== null && options.density !== undefined) {
    metadata.density = options.density;
  }
  if (options.orientation !== undefined) {
    metadata.orientation = options.orientation;
  }
  if (Object.keys(metadata).length > 0) {
    pipeline = pipeline.withMetadata(metadata);
  }

  return pipeline.toBuffer();
}

/** カードが写っていない（検出不能な）画像を作る。 */
export function syntheticBlank(width = 800, height = 600, color = '#f4f4f2'): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: color } })
    .png()
    .toBuffer();
}

/** 破損した画像ファイルのバイト列を作る（ヘッダだけ本物、以降はゴミ）。 */
export function corruptImageBytes(): Buffer {
  const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([pngSignature, Buffer.from('this is not a valid PNG body', 'utf8')]);
}
