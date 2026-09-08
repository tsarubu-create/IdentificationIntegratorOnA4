/**
 * sharp を使った画像入出力（README §3.1）。
 *
 * 不変条件:
 * - 入力ファイルは**読み取りのみ**。この module に入力を書き換える経路は無い。
 * - 原寸で扱うのは「カード外接矩形」だけ。ページ全体を原寸展開しない。
 */

import { stat } from 'node:fs/promises';
import sharp from 'sharp';
import type { Sharp } from 'sharp';
import { PROXY_LONG_EDGE_PX, THUMBNAIL_LONG_EDGE_PX } from '@shared/limits';
import type { SizePx } from '@shared/types';
import type { RectPx } from '@core/layout/a4';
import { PAGE_BACKGROUND } from '@core/layout/a4';

/** 復号せずに得られる画像情報。安全上限の判定に使う。 */
export interface HeaderInfo {
  readonly fileBytes: number;
  /** Exif 回転を適用した後の幅 */
  readonly width: number;
  /** Exif 回転を適用した後の高さ */
  readonly height: number;
  /** メタデータ上の解像度（未取得なら null） */
  readonly density: number | null;
  readonly format: string | null;
  readonly hasAlpha: boolean;
}

/** 生ピクセルデータ。 */
export interface RawImage {
  readonly data: Buffer;
  readonly width: number;
  readonly height: number;
  readonly channels: number;
}

/**
 * 復号せずにヘッダだけを読む。
 *
 * `metadata()` はヘッダのみを読むため、圧縮爆弾を展開せずに上限判定できる。
 * これが安全上限設計の第一の防壁（README §4.2）。
 *
 * **`autoOrient` を寸法の正とする。** `width` / `height` は Exif 回転を
 * 適用する前の値であり、これを使うと回転画像で座標が 90 度ずれる。
 */
export async function readHeader(filePath: string): Promise<HeaderInfo> {
  const [fileStat, metadata] = await Promise.all([
    stat(filePath),
    sharp(filePath, { failOn: 'none' }).metadata(),
  ]);

  const oriented = metadata.autoOrient;
  const width = oriented?.width ?? metadata.width ?? 0;
  const height = oriented?.height ?? metadata.height ?? 0;

  return {
    fileBytes: fileStat.size,
    width,
    height,
    density: typeof metadata.density === 'number' ? metadata.density : null,
    format: metadata.format ?? null,
    hasAlpha: metadata.hasAlpha === true,
  };
}

/**
 * 復号の共通前処理を適用したパイプラインを作る。
 *
 * - `rotate()`（引数なし）で Exif Orientation を適用する
 * - `flatten()` で透過部分を白背景へ合成する（仕様書 §5）
 * - `failOn: 'none'` で軽微な破損を許容し、処理できる範囲まで読む
 *
 * @param ignoreIcc 壊れた ICC プロファイルを無視して再試行する場合に true
 */
function openImage(filePath: string, ignoreIcc: boolean): Sharp {
  const pipeline = sharp(filePath, { failOn: 'none' })
    .rotate()
    .flatten({ background: PAGE_BACKGROUND });

  // ICC 変換に失敗する画像があるため、2 回目は sRGB へ直接倒して読む。
  return ignoreIcc ? pipeline.toColourspace('srgb') : pipeline;
}

/**
 * 検出用のプロキシ画像（長辺 1600px、RGB raw）を作る。
 *
 * 原寸を展開せずに検出できるようにするのが目的。JPEG では sharp の
 * shrink-on-load が効くため、このコストはほぼ無視できる。
 */
export async function createDetectionProxy(
  filePath: string,
  ignoreIcc = false,
): Promise<RawImage & { readonly scaleToOriginal: number }> {
  const { data, info } = await openImage(filePath, ignoreIcc)
    .resize({
      width: PROXY_LONG_EDGE_PX,
      height: PROXY_LONG_EDGE_PX,
      fit: 'inside',
      // 元画像が 1600px 未満のときに拡大すると、輪郭が甘くなるだけで利得がない。
      withoutEnlargement: true,
    })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const header = await readHeader(filePath);
  const scaleToOriginal = info.width > 0 ? header.width / info.width : 1;

  return {
    data,
    width: info.width,
    height: info.height,
    channels: info.channels,
    scaleToOriginal,
  };
}

/**
 * 原寸から指定領域だけを切り出す（RGB raw）。
 *
 * **メモリ設計の要**。ページ全体ではなくカード外接矩形のみを取り出すため、
 * 入力が 160 Mpx でもここで得られるバッファはカードサイズに収まる。
 */
export async function extractRegion(
  filePath: string,
  region: RectPx,
  ignoreIcc = false,
): Promise<RawImage> {
  const { data, info } = await openImage(filePath, ignoreIcc)
    .extract({
      left: Math.max(0, Math.round(region.x)),
      top: Math.max(0, Math.round(region.y)),
      width: Math.max(1, Math.round(region.width)),
      height: Math.max(1, Math.round(region.height)),
    })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  return { data, width: info.width, height: info.height, channels: info.channels };
}

/** 生 RGB データを PNG バイト列へ変換する。 */
export function rawToPng(image: RawImage): Promise<Buffer> {
  return sharp(image.data, {
    raw: { width: image.width, height: image.height, channels: toChannels(image.channels) },
  })
    .png()
    .toBuffer();
}

/**
 * 確認画面用のサムネイルを WebP で作る。
 *
 * **ディスクへは書き出さない**（仕様書 §11-5）。呼び出し側が `ArrayBuffer` として
 * レンダラへ転送し、レンダラは Blob URL として表示する。
 */
export async function encodeThumbnail(image: RawImage): Promise<Buffer> {
  return sharp(image.data, {
    raw: { width: image.width, height: image.height, channels: toChannels(image.channels) },
  })
    .resize({
      width: THUMBNAIL_LONG_EDGE_PX,
      height: THUMBNAIL_LONG_EDGE_PX,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .webp({ quality: 72 })
    .toBuffer();
}

/** 入力ファイルから直接サムネイルを作る（検出失敗時の代替表示用）。 */
export function encodeThumbnailFromFile(filePath: string, ignoreIcc = false): Promise<Buffer> {
  return openImage(filePath, ignoreIcc)
    .resize({
      width: THUMBNAIL_LONG_EDGE_PX,
      height: THUMBNAIL_LONG_EDGE_PX,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .removeAlpha()
    .webp({ quality: 72 })
    .toBuffer();
}

/** 1 枚の A4 ページへ合成する 1 件ぶんの入力。 */
export interface CompositeItem {
  /** PNG または生 RGB のバイト列 */
  readonly png: Buffer;
  readonly left: number;
  readonly top: number;
}

/**
 * 白背景の A4 ページを合成し、300dpi の PNG バイト列を返す（仕様書 §6 / §7.1）。
 *
 * PNG の pHYs チャンクへ 300dpi を書き込むため、印刷時に物理サイズが保たれる。
 */
export function composeA4Page(pageSize: SizePx, items: readonly CompositeItem[]): Promise<Buffer> {
  return sharp({
    create: {
      width: pageSize.width,
      height: pageSize.height,
      channels: 3,
      background: PAGE_BACKGROUND,
    },
  })
    .composite(items.map((item) => ({ input: item.png, left: item.left, top: item.top })))
    .png({ compressionLevel: 9 })
    .withMetadata({ density: 300 })
    .toBuffer();
}

/** sharp が受け付けるチャンネル数へ絞り込む。 */
function toChannels(channels: number): 1 | 2 | 3 | 4 {
  if (channels === 1 || channels === 2 || channels === 3 || channels === 4) return channels;
  throw new RangeError(`対応していないチャンネル数です: ${channels}`);
}
