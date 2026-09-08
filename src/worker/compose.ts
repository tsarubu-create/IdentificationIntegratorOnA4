/**
 * A4 ページの生成と書き出し（仕様書 §6 / §7）。
 *
 * 確認画面で「出力開始」が押された後にだけ呼ばれる。ここで初めて原寸の切り出しを
 * 行い、1 ページぶんを合成しては即座に書き出す。全ページを溜めてから書かないのは、
 * ページ数に比例してメモリが増えるのを避けるため。
 */

import { PAGE_SIZE_PX } from '@core/layout/a4';
import { type PageItem, paginate } from '@core/layout/pagination';
import { boundingBox, translateQuad } from '@core/geometry/quad';
import { cropQuad } from '@core/standards/officialCrop';
import { resolvePlacement } from '@core/layout/placement';
import { sortByRelativePath } from '@core/scan/naturalSort';
import type { DocumentKind, ExclusionReason, Quad, SizeMm } from '@shared/types';
import {
  type CompositeItem,
  composeA4Page,
  encodePageThumbnail,
  extractRegion,
  rawToSizedPng,
} from '@worker/imageIo';
import { rotate90, warpQuad } from '@worker/warp';
import { resolveStartSequence, writePageExclusive } from '@worker/output';

/** 出力対象 1 件。解析フェーズの結果と、利用者が選んだ種別を合わせたもの。 */
export interface ComposeItem {
  readonly id: string;
  readonly relativePath: string;
  /** 読み取る画像の絶対パス */
  readonly filePath: string;
  /** 原寸座標系の四隅 */
  readonly quad: Quad;
  /** 切り出したカードの物理サイズ（回転前） */
  readonly cardSizeMm: SizeMm;
  /** 利用者が確認画面で選択した種別 */
  readonly kind: DocumentKind;
  readonly ignoreIcc: boolean;
  /** 画像に適用する解像度（規格値を画素へ換算するために使う） */
  readonly effectiveDpi: number;
  /** 元画像の寸法（外接矩形を画像内へ収めるために使う） */
  readonly sourceWidth: number;
  readonly sourceHeight: number;
}

/** 出力の設定。 */
export interface ComposeOptions {
  readonly outputDirectory: string;
  readonly signal?: AbortSignal;
  /** 1 ページ書き出すごとに呼ばれる */
  readonly onPageWritten?: (fileName: string, pageIndex: number, pageCount: number) => void;
}

/** 出力結果。 */
export interface ComposeOutcome {
  readonly fileNames: readonly string[];
  readonly excluded: readonly { relativePath: string; reason: ExclusionReason }[];
  /** 生成ページのサムネイル（WebP）。ファイル名と同じ順序 */
  readonly pageThumbnails: readonly ArrayBuffer[];
}

/** 透視変換で端が欠けないよう、外接矩形に付ける余白。 */
const CROP_PADDING_PX = 2;

/**
 * 出力対象からページを生成し、順に書き出す。
 *
 * 収まらない対象は**縮小せず除外**し、理由を返す（仕様書 §6）。
 */
export async function composePages(
  items: readonly ComposeItem[],
  options: ComposeOptions,
): Promise<ComposeOutcome> {
  const excluded: { relativePath: string; reason: ExclusionReason }[] = [];
  const pageItems: PageItem[] = [];
  const byId = new Map<string, ComposeItem>();

  // 相対パスの自然順を出力順の基礎とする（仕様書 §11-4）。
  for (const item of sortByRelativePath(items, (i) => i.relativePath)) {
    const placement = resolvePlacement(item.cardSizeMm, item.kind);
    if (!placement.fits) {
      excluded.push({ relativePath: item.relativePath, reason: placement.exclusion! });
      continue;
    }
    byId.set(item.id, item);
    pageItems.push({
      id: item.id,
      relativePath: item.relativePath,
      kind: item.kind,
      outputSize: placement.sizePx,
    });
  }

  const pages = paginate(pageItems);
  const fileNames: string[] = [];
  const pageThumbnails: ArrayBuffer[] = [];
  let sequence = await resolveStartSequence(options.outputDirectory);

  for (const [pageIndex, page] of pages.entries()) {
    options.signal?.throwIfAborted();

    const composites: CompositeItem[] = [];
    for (const placement of page.placements) {
      options.signal?.throwIfAborted();
      const item = byId.get(placement.id);
      if (item === undefined) continue;

      const png = await renderCard(item, {
        width: placement.rect.width,
        height: placement.rect.height,
      });
      composites.push({ png, left: placement.rect.x, top: placement.rect.y });
    }

    const pageBytes = await composeA4Page(PAGE_SIZE_PX, composites);
    const written = await writePageExclusive(options.outputDirectory, sequence, pageBytes);

    sequence = written.sequence + 1;
    fileNames.push(written.fileName);
    pageThumbnails.push(await toArrayBuffer(encodePageThumbnail(pageBytes)));
    options.onPageWritten?.(written.fileName, pageIndex + 1, pages.length);
  }

  return { fileNames, excluded, pageThumbnails };
}

/** Buffer を、共有プールから切り離した ArrayBuffer へ変換する。 */
async function toArrayBuffer(source: Promise<Buffer>): Promise<ArrayBuffer> {
  const buffer = await source;
  return buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength,
  ) as ArrayBuffer;
}

/**
 * 1 件ぶんのカード画像を、A4 上へ置く画素サイズの PNG として作る。
 *
 * 原寸を扱うのはこの関数の中だけであり、対象はカードの外接矩形に限られる。
 */
async function renderCard(
  item: ComposeItem,
  targetSize: { width: number; height: number },
): Promise<Buffer> {
  // 券面の縁ではなく**配置枠と同じ大きさ**を、検出した中心のまわりから切り出す。
  // 必要な精度が縁ではなく中心だけになるため、許容誤差が桁で広がる
  // （券面 85.6mm に対しセル 95.0mm なので中心が ±4.7mm ずれても収まる）。
  const placement = resolvePlacement(item.cardSizeMm, item.kind);
  const quad = cropQuad(item.quad, placement.cropSizeMm, item.effectiveDpi);

  const box = boundingBox(
    quad,
    { width: item.sourceWidth, height: item.sourceHeight },
    CROP_PADDING_PX,
  );

  const crop = await extractRegion(item.filePath, box, item.ignoreIcc);
  const warped = await warpQuad(crop, translateQuad(quad, box));
  const oriented = item.kind === 'passportSpread' ? await rotate90(warped) : warped;

  return rawToSizedPng(oriented, targetSize);
}
