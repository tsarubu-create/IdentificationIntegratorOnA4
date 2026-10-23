/** 色と矩形だけで作る合成スキャン。実画像の画素・内容を利用しない。 */
import sharp from 'sharp';
import { syntheticScan } from './synthetic';

export async function faintScan(
  options: {
    readonly rotationDeg?: number;
    readonly blank?: boolean;
    readonly cardColor?: string;
    readonly uneven?: boolean;
    readonly centerX?: number;
    readonly centerY?: number;
    readonly secondCard?: { readonly centerX: number; readonly centerY: number };
  } = {},
): Promise<Buffer> {
  const width = 2550;
  const height = 3506;
  const background = '#e5eae7';
  const base = options.blank
    ? await sharp({ create: { width, height, channels: 3, background } })
        .png()
        .toBuffer()
    : await syntheticScan({
        canvasWidth: width,
        canvasHeight: height,
        cardWidth: 1011,
        cardHeight: 638,
        centerX: options.centerX ?? 1400,
        centerY: options.centerY ?? 1800,
        density: 300,
        backgroundColor: background,
        cardColor: options.cardColor ?? '#e8ece9',
        rotationDeg: options.rotationDeg ?? 0,
        ...(options.secondCard
          ? { secondCard: { ...options.secondCard, color: options.cardColor ?? '#e8ece9' } }
          : {}),
      });
  // 外周リングの半分近くを占める暗い帯。券面とは離して配置する。
  const bands = Buffer.from(`<svg width="${width}" height="${height}">
    <rect width="${width}" height="130" fill="#bcbaba"/>
    <rect width="110" height="${height}" fill="#b6b3b1"/>
  </svg>`);
  const composed = await sharp(base)
    .composite([{ input: bands }])
    .removeAlpha()
    .raw()
    .toBuffer();
  if (options.uneven) {
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const shade = Math.round((x / width - 0.5) * 10 + (y / height - 0.5) * 8);
        for (let c = 0; c < 3; c += 1) {
          const index = (y * width + x) * 3 + c;
          // 座標から決まる微小ノイズ。実行ごとの乱数は使わない。
          const noise = (((Math.imul(index + 1, 1103515245) ^ (index >>> 8)) >>> 0) % 5) - 2;
          composed[index] = Math.max(0, Math.min(255, composed[index]! + shade + noise));
        }
      }
    }
  }
  return sharp(composed, { raw: { width, height, channels: 3 } })
    .withMetadata({ density: 300 })
    .png()
    .toBuffer();
}
