import { describe, expect, it } from 'vitest';
import {
  CARDS_PER_PAGE,
  CELL_SIZE_MM,
  CELL_SIZE_PX,
  GRID_COLUMNS,
  GRID_ROWS,
  PAGE_SIZE_PX,
  PRINTABLE_AREA_MM,
  PRINTABLE_AREA_PX,
  SETBACK_PX,
  cellRect,
  centerWithin,
  fitsInCell,
  fitsInPrintableArea,
  mmToPx,
  physicalSizeToOutputPx,
  pxToMm,
} from '@core/layout/a4';

/** ISO/IEC 7810 ID-1（運転免許証・マイナンバーカード）の物理サイズ。 */
const ID1_CARD = { widthMm: 85.6, heightMm: 54.0 };

/** ICAO ID-3 パスポート見開き（88mm x 2 = 176mm 幅、125mm 高）。 */
const PASSPORT_SPREAD = { widthMm: 176, heightMm: 125 };

describe('A4 の基本寸法（仕様書 §6 / §7.1）', () => {
  it('300dpi の A4 は 2480 x 3508 px である', () => {
    expect(PAGE_SIZE_PX).toEqual({ width: 2480, height: 3508 });
  });

  it('全周 1cm のセットバックは 118 px である', () => {
    expect(SETBACK_PX).toBe(118);
  });

  it('印刷可能領域が仕様書の 190 x 277 mm と一致する', () => {
    expect(PRINTABLE_AREA_PX.width).toBe(2244);
    expect(PRINTABLE_AREA_PX.height).toBe(3272);
    expect(PRINTABLE_AREA_MM.widthMm).toBeCloseTo(190, 1);
    expect(PRINTABLE_AREA_MM.heightMm).toBeCloseTo(277, 1);
  });

  it('印刷可能領域はページ内に完全に収まる', () => {
    expect(PRINTABLE_AREA_PX.x + PRINTABLE_AREA_PX.width).toBeLessThanOrEqual(PAGE_SIZE_PX.width);
    expect(PRINTABLE_AREA_PX.y + PRINTABLE_AREA_PX.height).toBeLessThanOrEqual(PAGE_SIZE_PX.height);
  });
});

describe('mm と px の相互変換', () => {
  it('300dpi で 25.4mm は 300px である', () => {
    expect(mmToPx(25.4, 300)).toBeCloseTo(300, 6);
  });

  it('往復変換で元の値に戻る', () => {
    for (const mm of [1, 54, 85.6, 176, 297]) {
      expect(pxToMm(mmToPx(mm, 300), 300)).toBeCloseTo(mm, 9);
    }
  });
});

describe('2 列 x 4 行のセル（仕様書 §7.2）', () => {
  it('グリッドは 2 列 x 4 行・最大 8 枚である', () => {
    expect(GRID_COLUMNS).toBe(2);
    expect(GRID_ROWS).toBe(4);
    expect(CARDS_PER_PAGE).toBe(8);
  });

  it('セルは 1122 x 818 px（95.0 x 69.3 mm）である', () => {
    expect(CELL_SIZE_PX).toEqual({ width: 1122, height: 818 });
    expect(CELL_SIZE_MM.widthMm).toBeCloseTo(95.0, 1);
    expect(CELL_SIZE_MM.heightMm).toBeCloseTo(69.3, 1);
  });

  it('読み取り順は左上から右方向、次の行へ進む', () => {
    const first = cellRect(0);
    const second = cellRect(1);
    const third = cellRect(2);

    // 0 -> 1 は右方向
    expect(second.y).toBe(first.y);
    expect(second.x).toBeGreaterThan(first.x);
    // 1 -> 2 は次の行の左端へ折り返す
    expect(third.x).toBe(first.x);
    expect(third.y).toBeGreaterThan(first.y);
  });

  it('8 つのセルは重ならず、すべて印刷可能領域に収まる', () => {
    const rects = Array.from({ length: CARDS_PER_PAGE }, (_, i) => cellRect(i));

    for (const rect of rects) {
      expect(rect.x).toBeGreaterThanOrEqual(PRINTABLE_AREA_PX.x);
      expect(rect.y).toBeGreaterThanOrEqual(PRINTABLE_AREA_PX.y);
      expect(rect.x + rect.width).toBeLessThanOrEqual(
        PRINTABLE_AREA_PX.x + PRINTABLE_AREA_PX.width,
      );
      expect(rect.y + rect.height).toBeLessThanOrEqual(
        PRINTABLE_AREA_PX.y + PRINTABLE_AREA_PX.height,
      );
    }

    for (let i = 0; i < rects.length; i += 1) {
      for (let j = i + 1; j < rects.length; j += 1) {
        const a = rects[i]!;
        const b = rects[j]!;
        const overlaps =
          a.x < b.x + b.width &&
          b.x < a.x + a.width &&
          a.y < b.y + b.height &&
          b.y < a.y + a.height;
        expect(overlaps, `セル ${i} と ${j} が重なっています`).toBe(false);
      }
    }
  });

  it('範囲外の index は例外になる', () => {
    expect(() => cellRect(-1)).toThrow(RangeError);
    expect(() => cellRect(CARDS_PER_PAGE)).toThrow(RangeError);
    expect(() => cellRect(1.5)).toThrow(RangeError);
  });
});

describe('実寸カードの収まり判定（仕様書 §6: 縮小しない）', () => {
  it('ID-1 カードは 1011 x 638 px でセルに収まる', () => {
    const size = physicalSizeToOutputPx(ID1_CARD);
    expect(size).toEqual({ width: 1011, height: 638 });
    expect(fitsInCell(size)).toBe(true);
  });

  it('パスポート見開きは 90 度回転後に印刷可能領域へ収まる', () => {
    const rotated = { widthMm: PASSPORT_SPREAD.heightMm, heightMm: PASSPORT_SPREAD.widthMm };
    const size = physicalSizeToOutputPx(rotated);
    expect(size).toEqual({ width: 1476, height: 2079 });
    expect(fitsInPrintableArea(size)).toBe(true);
  });

  it('セルより大きいカードは収まらないと判定される', () => {
    const oversized = physicalSizeToOutputPx({ widthMm: 95.1, heightMm: 54 });
    expect(fitsInCell(oversized)).toBe(false);
  });

  it('パスポート見開きはセルには収まらない（混載しないことの裏付け）', () => {
    const rotated = physicalSizeToOutputPx({ widthMm: 125, heightMm: 176 });
    expect(fitsInCell(rotated)).toBe(false);
  });
});

describe('中央揃え配置', () => {
  it('枠の中央に置かれ、はみ出さない', () => {
    const frame = { x: 100, y: 200, width: 1000, height: 800 };
    const origin = centerWithin({ width: 400, height: 300 }, frame);

    expect(origin).toEqual({ x: 400, y: 450 });
    expect(origin.x + 400).toBeLessThanOrEqual(frame.x + frame.width);
    expect(origin.y + 300).toBeLessThanOrEqual(frame.y + frame.height);
  });

  it('端数があっても枠からはみ出さない（切り捨て）', () => {
    const frame = { x: 0, y: 0, width: 101, height: 101 };
    const origin = centerWithin({ width: 100, height: 100 }, frame);
    expect(origin).toEqual({ x: 0, y: 0 });
  });
});
