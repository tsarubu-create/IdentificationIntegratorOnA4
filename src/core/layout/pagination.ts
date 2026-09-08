/**
 * A4 ページ分割と配置座標の決定（仕様書 §7.2 / §7.3 / §11-4）。
 *
 * 入力は「物理サイズ換算まで済み、枠に収まることが確認済み」の配置対象。
 * 収まらないものは呼び出し側で除外済みである前提とする（仕様書 §6: 縮小しない）。
 */

import type { DocumentKind, SizePx } from '@shared/types';
import {
  CARDS_PER_PAGE,
  PRINTABLE_AREA_PX,
  type RectPx,
  cellRect,
  centerWithin,
} from '@core/layout/a4';

/** ページへ載せる 1 件。 */
export interface PageItem {
  readonly id: string;
  readonly relativePath: string;
  readonly kind: DocumentKind;
  /** A4 上での配置画素サイズ（物理サイズを 300dpi 換算したもの） */
  readonly outputSize: SizePx;
}

/** ページ上の確定した配置。 */
export interface Placement {
  readonly id: string;
  readonly relativePath: string;
  readonly rect: RectPx;
}

/** 1 ページ分の内容。 */
export interface Page {
  /** カードページかパスポート単独ページか */
  readonly kind: 'cards' | 'passport';
  readonly placements: readonly Placement[];
}

/** 身分証カードを、ページ内 index に対応するセルへ中央揃えで配置する。 */
function placeCard(item: PageItem, indexInPage: number): Placement {
  const cell = cellRect(indexInPage);
  const origin = centerWithin(item.outputSize, cell);
  return {
    id: item.id,
    relativePath: item.relativePath,
    rect: {
      x: origin.x,
      y: origin.y,
      width: item.outputSize.width,
      height: item.outputSize.height,
    },
  };
}

/** パスポート見開きを印刷可能領域の中央へ配置する（1 画像 1 ページ）。 */
function placePassport(item: PageItem): Placement {
  const origin = centerWithin(item.outputSize, PRINTABLE_AREA_PX);
  return {
    id: item.id,
    relativePath: item.relativePath,
    rect: {
      x: origin.x,
      y: origin.y,
      width: item.outputSize.width,
      height: item.outputSize.height,
    },
  };
}

/**
 * 配置対象をページへ分割する。
 *
 * 入力順（＝相対パスの自然順）を維持したまま、次の規則で分割する（仕様書 §11-4 の推奨案）。
 *
 * - 身分証カードはバッファへ溜め、8 枚に達したらページを確定する。
 * - パスポート見開きに出会ったら、**8 枚未満でもその時点のカードページを確定**し、
 *   続けてパスポート単独ページを出力する。これによりカードとパスポートが混載されず
 *   （仕様書 §7.3）、出力の連番順が入力の自然順と一致する。
 * - 走査終了時に残ったカードを最終ページとして確定する。
 *
 * @param items 自然順に並べた配置対象
 * @returns ページの配列（出力順）
 */
export function paginate(items: readonly PageItem[]): Page[] {
  const pages: Page[] = [];
  let cardBuffer: PageItem[] = [];

  const flushCards = (): void => {
    if (cardBuffer.length === 0) return;
    pages.push({
      kind: 'cards',
      placements: cardBuffer.map((item, index) => placeCard(item, index)),
    });
    cardBuffer = [];
  };

  for (const item of items) {
    if (item.kind === 'passportSpread') {
      flushCards();
      pages.push({ kind: 'passport', placements: [placePassport(item)] });
      continue;
    }

    cardBuffer.push(item);
    if (cardBuffer.length === CARDS_PER_PAGE) flushCards();
  }

  flushCards();
  return pages;
}
