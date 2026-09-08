/**
 * 出力対象判定のテスト（仕様書 §6 / §8）。
 *
 * 「種別を選び直すと除外が解消される」ことと、
 * 「種別に依らない除外は解消されない」ことの両方を押さえる。
 */

import { describe, expect, it } from 'vitest';
import type { AnalyzedImage } from '@shared/types';
import { countIncludable, resolveExclusion } from '@renderer/includable';
import { resolvePlacement } from '@core/layout/placement';

function image(overrides: Partial<AnalyzedImage> = {}): AnalyzedImage {
  return {
    id: 'a',
    relativePath: 'a.png',
    status: 'detected',
    embeddedDpi: 300,
    effectiveDpi: 300,
    physicalSize: { widthMm: 85.6, heightMm: 54 },
    confidence: 0.9,
    warnings: [],
    exclusion: null,
    limitViolation: null,
    kind: 'idCard',
    thumbnail: null,
    ...overrides,
  };
}

/** ICAO ID-3 のパスポート見開き（176 x 125 mm）。 */
const PASSPORT_SIZE = { widthMm: 176, heightMm: 125 };

describe('種別に応じた除外判定', () => {
  it('ID-1 カードは身分証カードとして出力対象になる', () => {
    expect(resolveExclusion(image(), 'idCard')).toBeNull();
  });

  it('パスポート見開きは既定の身分証カードではセルに収まらない', () => {
    const passport = image({ physicalSize: PASSPORT_SIZE, exclusion: 'doesNotFitCell' });
    expect(resolveExclusion(passport, 'idCard')).toBe('doesNotFitCell');
  });

  it('種別をパスポート見開きへ変えると除外が解消される', () => {
    // 解析時は身分証カードとして判定され doesNotFitCell が付いているが、
    // 利用者が種別を選び直したら 90 度回転して印刷可能領域に収まる。
    const passport = image({ physicalSize: PASSPORT_SIZE, exclusion: 'doesNotFitCell' });
    expect(resolveExclusion(passport, 'passportSpread')).toBeNull();
    expect(resolvePlacement(PASSPORT_SIZE, 'passportSpread').fits).toBe(true);
  });

  it.each([
    ['検出失敗', 'detectionFailed'],
    ['復号失敗', 'decodeFailed'],
    ['総画素数超過', 'tooManyPixels'],
    ['ファイルサイズ超過', 'fileTooLarge'],
  ] as const)('%s は種別を変えても解消されない', (_label, reason) => {
    const broken = image({ exclusion: reason, physicalSize: null });
    expect(resolveExclusion(broken, 'idCard')).toBe(reason);
    expect(resolveExclusion(broken, 'passportSpread')).toBe(reason);
  });

  it('大きすぎるカードはどちらの種別でも収まらない', () => {
    const huge = image({ physicalSize: { widthMm: 300, heightMm: 400 } });
    expect(resolveExclusion(huge, 'idCard')).toBe('doesNotFitCell');
    expect(resolveExclusion(huge, 'passportSpread')).toBe('doesNotFitPrintableArea');
  });
});

describe('出力対象の件数（確認画面のヘッダ表示）', () => {
  it('種別の選択に追随して数え直される', () => {
    const images = [
      image({ id: 'card', relativePath: 'card.png' }),
      image({
        id: 'passport',
        relativePath: 'passport.png',
        physicalSize: PASSPORT_SIZE,
        exclusion: 'doesNotFitCell',
      }),
      image({
        id: 'broken',
        relativePath: 'broken.png',
        exclusion: 'decodeFailed',
        physicalSize: null,
      }),
    ];

    // 既定（すべて身分証カード）ではパスポートが収まらない。
    expect(countIncludable(images, {})).toBe(1);

    // 種別を選び直すと件数が増える。この追随が無いと、行の表示と
    // ヘッダの件数・出力ボタンの活性が食い違う。
    expect(countIncludable(images, { passport: 'passportSpread' })).toBe(2);
  });

  it('空の一覧では 0 になる', () => {
    expect(countIncludable([], {})).toBe(0);
  });
});
