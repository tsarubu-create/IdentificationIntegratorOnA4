import { describe, expect, it } from 'vitest';
import { type PageItem, paginate } from '@core/layout/pagination';
import {
  CARDS_PER_PAGE,
  PRINTABLE_AREA_PX,
  cellRect,
  physicalSizeToOutputPx,
} from '@core/layout/a4';
import { compareNatural, sortNatural } from '@core/scan/naturalSort';

const CARD_SIZE = physicalSizeToOutputPx({ widthMm: 85.6, heightMm: 54 });
const PASSPORT_SIZE = physicalSizeToOutputPx({ widthMm: 125, heightMm: 176 });

function card(name: string): PageItem {
  return { id: name, relativePath: name, kind: 'idCard', outputSize: CARD_SIZE };
}

function passport(name: string): PageItem {
  return { id: name, relativePath: name, kind: 'passportSpread', outputSize: PASSPORT_SIZE };
}

function cards(count: number): PageItem[] {
  return Array.from({ length: count }, (_, i) =>
    card(`card_${String(i + 1).padStart(3, '0')}.jpg`),
  );
}

describe('身分証カードのページ分割（仕様書 §7.2）', () => {
  it('対象が無ければページを生成しない', () => {
    expect(paginate([])).toEqual([]);
  });

  it('8 枚までは 1 ページに収まる', () => {
    const pages = paginate(cards(CARDS_PER_PAGE));
    expect(pages).toHaveLength(1);
    expect(pages[0]!.kind).toBe('cards');
    expect(pages[0]!.placements).toHaveLength(8);
  });

  it('8 枚を超えたら次のページへ分割する（停止せず全件処理する）', () => {
    const pages = paginate(cards(17));
    expect(pages.map((p) => p.placements.length)).toEqual([8, 8, 1]);
    expect(pages.every((p) => p.kind === 'cards')).toBe(true);
  });

  it('入力順（自然順）が配置順として保たれる', () => {
    const pages = paginate(cards(10));
    const ordered = pages.flatMap((p) => p.placements.map((pl) => pl.relativePath));
    expect(ordered).toEqual(sortNatural(ordered));
    expect(ordered[0]).toBe('card_001.jpg');
    expect(ordered[9]).toBe('card_010.jpg');
  });

  it('各カードは対応するセル内に中央揃えで置かれ、はみ出さない', () => {
    const pages = paginate(cards(8));
    pages[0]!.placements.forEach((placement, index) => {
      const cell = cellRect(index);
      expect(placement.rect.x).toBeGreaterThanOrEqual(cell.x);
      expect(placement.rect.y).toBeGreaterThanOrEqual(cell.y);
      expect(placement.rect.x + placement.rect.width).toBeLessThanOrEqual(cell.x + cell.width);
      expect(placement.rect.y + placement.rect.height).toBeLessThanOrEqual(cell.y + cell.height);
      // 中央揃え: 左右・上下の余白差は 1px 以内
      const leftGap = placement.rect.x - cell.x;
      const rightGap = cell.x + cell.width - (placement.rect.x + placement.rect.width);
      expect(Math.abs(leftGap - rightGap)).toBeLessThanOrEqual(1);
    });
  });

  it('配置は互いに重ならない', () => {
    const placements = paginate(cards(8))[0]!.placements;
    for (let i = 0; i < placements.length; i += 1) {
      for (let j = i + 1; j < placements.length; j += 1) {
        const a = placements[i]!.rect;
        const b = placements[j]!.rect;
        const overlaps =
          a.x < b.x + b.width &&
          b.x < a.x + a.width &&
          a.y < b.y + b.height &&
          b.y < a.y + a.height;
        expect(overlaps).toBe(false);
      }
    }
  });

  it('物理サイズを変えない（配置サイズは入力サイズと一致する）', () => {
    const placement = paginate([card('a.jpg')])[0]!.placements[0]!;
    expect(placement.rect.width).toBe(CARD_SIZE.width);
    expect(placement.rect.height).toBe(CARD_SIZE.height);
  });
});

describe('パスポート見開きの単独ページ（仕様書 §7.3）', () => {
  it('1 画像につき A4 1 枚を占有する', () => {
    const pages = paginate([passport('p.jpg')]);
    expect(pages).toHaveLength(1);
    expect(pages[0]!.kind).toBe('passport');
    expect(pages[0]!.placements).toHaveLength(1);
  });

  it('印刷可能領域の中央に配置される', () => {
    const rect = paginate([passport('p.jpg')])[0]!.placements[0]!.rect;
    const leftGap = rect.x - PRINTABLE_AREA_PX.x;
    const rightGap = PRINTABLE_AREA_PX.x + PRINTABLE_AREA_PX.width - (rect.x + rect.width);
    const topGap = rect.y - PRINTABLE_AREA_PX.y;
    const bottomGap = PRINTABLE_AREA_PX.y + PRINTABLE_AREA_PX.height - (rect.y + rect.height);

    expect(Math.abs(leftGap - rightGap)).toBeLessThanOrEqual(1);
    expect(Math.abs(topGap - bottomGap)).toBeLessThanOrEqual(1);
    expect(leftGap).toBeGreaterThanOrEqual(0);
    expect(topGap).toBeGreaterThanOrEqual(0);
  });

  it('カードと混載されない', () => {
    const pages = paginate([card('a.jpg'), passport('b.jpg'), card('c.jpg')]);
    expect(pages.map((p) => p.kind)).toEqual(['cards', 'passport', 'cards']);

    // パスポートページには必ず 1 件だけ、かつそれはパスポートである。
    const passportPages = pages.filter((p) => p.kind === 'passport');
    expect(passportPages).toHaveLength(1);
    expect(passportPages[0]!.placements.map((pl) => pl.id)).toEqual(['b.jpg']);

    // カードページ側にパスポートは含まれない。
    const cardIds = pages
      .filter((p) => p.kind === 'cards')
      .flatMap((p) => p.placements.map((pl) => pl.id));
    expect(cardIds).toEqual(['a.jpg', 'c.jpg']);
  });

  it('複数のパスポートは互いに同じページへまとめられない', () => {
    const pages = paginate([passport('a.jpg'), passport('b.jpg')]);
    expect(pages).toHaveLength(2);
    expect(pages.every((p) => p.kind === 'passport' && p.placements.length === 1)).toBe(true);
  });
});

describe('種別が混在するときの出力順（仕様書 §11-4）', () => {
  it('パスポートの前でカードページを確定し、8 枚未満でも打ち切る', () => {
    const items = [...cards(3), passport('p.jpg'), ...cards(2).map((c) => card(`z_${c.id}`))];
    const pages = paginate(items);

    expect(pages.map((p) => p.kind)).toEqual(['cards', 'passport', 'cards']);
    expect(pages[0]!.placements).toHaveLength(3);
    expect(pages[2]!.placements).toHaveLength(2);
  });

  it('全件が漏れなくいずれかのページへ載る', () => {
    const items: PageItem[] = [
      ...cards(9),
      passport('p1.jpg'),
      card('later_1.jpg'),
      card('later_2.jpg'),
      passport('p2.jpg'),
    ];
    const placed = paginate(items).flatMap((p) => p.placements.map((pl) => pl.id));
    expect(placed).toHaveLength(items.length);
    expect(new Set(placed).size).toBe(items.length);
  });

  it('先頭がパスポートでも空のカードページを作らない', () => {
    const pages = paginate([passport('p.jpg'), card('a.jpg')]);
    expect(pages.map((p) => p.kind)).toEqual(['passport', 'cards']);
    expect(pages.every((p) => p.placements.length > 0)).toBe(true);
  });
});

describe('自然順ソート（仕様書 §7.2）', () => {
  it('数値部分を数値として比較する', () => {
    expect(sortNatural(['img10.jpg', 'img2.jpg', 'img1.jpg'])).toEqual([
      'img1.jpg',
      'img2.jpg',
      'img10.jpg',
    ]);
  });

  it('サブフォルダはセグメント単位で比較される', () => {
    const sorted = sortNatural(['b/1.jpg', 'a/10.jpg', 'a/2.jpg', 'a.jpg']);
    expect(sorted).toEqual(['a.jpg', 'a/2.jpg', 'a/10.jpg', 'b/1.jpg']);
  });

  it('Windows の区切り文字を POSIX と同一視する', () => {
    expect(compareNatural('sub\\a.jpg', 'sub/a.jpg')).toBe(0);
  });

  it('浅い階層が先に来る', () => {
    expect(compareNatural('a/b.jpg', 'a/b/c.jpg')).toBeLessThan(0);
  });

  it('入力配列を破壊しない', () => {
    const input = ['b.jpg', 'a.jpg'];
    sortNatural(input);
    expect(input).toEqual(['b.jpg', 'a.jpg']);
  });
});
