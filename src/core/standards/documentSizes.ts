/**
 * 身分証の公的な確定寸法（仕様書 §2 / §6）。
 *
 * 対象書類はいずれも**規格でサイズが一定**である。したがって、切り出しの寸法を
 * 画像の縁検出だけに委ねる必要はない。縁検出は「どこにあるか・どれだけ傾いているか」
 * の判定に使い、**大きさは規格値から与える**。
 *
 * これにより次の 2 点が構造的に保証される。
 *
 * 1. 同一カードの表裏で切り出しサイズが食い違わない
 *    （縁検出のみだと、券面のきわの陰影の出方で実測 87.1mm と 86.2mm のように
 *     0.9mm ずれる。表裏で寸法が異なることは物理的にありえない）
 * 2. 券面のきわの陰影が淡くて縁を取り逃しても、規格値まで外側へ広げるため見切れない
 *
 * ## 出典
 *
 * - **運転免許証**: 道路交通法施行規則 第19条・別記様式第14。
 *   1994年5月10日施行の改正で 8.56cm x 5.4cm へ小型化され、ISO/IEC 7810 ID-1 準拠となった。
 * - **マイナンバーカード（個人番号カード）**: ISO/IEC 7810 ID-1。
 *   公差込みで 縦 53.92〜54.03mm / 横 85.47〜85.72mm、中心値 85.60 x 53.98mm。
 * - **日本国旅券**: ICAO 勧告の ID-3（125mm x 88mm、公差 ±0.75mm）。
 *   見開きは短辺どうしが綴じられるため 176mm x 125mm となる。
 */

import type { DocumentKind, SizeMm } from '@shared/types';

/**
 * ISO/IEC 7810 ID-1 の寸法。
 *
 * 運転免許証・マイナンバーカードはいずれもこの規格である。
 * 高さは 54.0 ではなく **53.98** が規格値。
 */
export const ID1_CARD_SIZE_MM: SizeMm = { widthMm: 85.6, heightMm: 53.98 };

/** 日本国旅券 1 ページぶんの寸法（ICAO ID-3）。 */
export const PASSPORT_PAGE_SIZE_MM: SizeMm = { widthMm: 88, heightMm: 125 };

/** 日本国旅券の見開き（短辺どうしを綴じるため幅が 2 倍になる）。 */
export const PASSPORT_SPREAD_SIZE_MM: SizeMm = {
  widthMm: PASSPORT_PAGE_SIZE_MM.widthMm * 2,
  heightMm: PASSPORT_PAGE_SIZE_MM.heightMm,
};

/** 書類種別ごとの確定寸法。 */
export const OFFICIAL_SIZE_MM: Readonly<Record<DocumentKind, SizeMm>> = {
  idCard: ID1_CARD_SIZE_MM,
  passportSpread: PASSPORT_SPREAD_SIZE_MM,
};

/**
 * 実測が規格値と一致するとみなす許容差（比率）。
 *
 * ±12% とするのは、縁検出の誤差（実測で最大 +2.6%）や DPI メタデータの丸めを
 * 吸収しつつ、明らかに別物（名刺・診察券など規格外の書類）は弾ける水準だから。
 * 規格外と判定した場合は実測値をそのまま使い、確認画面に警告を出す。
 */
export const OFFICIAL_SIZE_TOLERANCE = 0.12;

/** 規格値との突き合わせ結果。 */
export interface OfficialSizeMatch {
  /** 採用する寸法（一致すれば規格値、しなければ実測値） */
  readonly size: SizeMm;
  /** 規格値へ合わせたか */
  readonly matched: boolean;
  /** 実測が規格値から何 % ずれていたか（幅・高さの大きいほう） */
  readonly deviation: number;
}

/**
 * 実測寸法を規格値と突き合わせる。
 *
 * 一致すれば規格値を採用する。**縦横が入れ替わっている場合も一致とみなす**
 * （カードを縦向きに置いてスキャンした場合、検出される長辺・短辺は同じでも
 * 幅と高さの割り当てが逆になるため）。
 *
 * @param measured 縁検出から得た実測寸法
 * @param kind 利用者が選択した書類種別
 */
export function matchOfficialSize(measured: SizeMm, kind: DocumentKind): OfficialSizeMatch {
  const official = OFFICIAL_SIZE_MM[kind];

  const upright = deviationFrom(measured, official);
  const rotated = deviationFrom(measured, {
    widthMm: official.heightMm,
    heightMm: official.widthMm,
  });

  if (upright <= OFFICIAL_SIZE_TOLERANCE) {
    return { size: official, matched: true, deviation: upright };
  }
  if (rotated <= OFFICIAL_SIZE_TOLERANCE) {
    return {
      size: { widthMm: official.heightMm, heightMm: official.widthMm },
      matched: true,
      deviation: rotated,
    };
  }

  return { size: measured, matched: false, deviation: Math.min(upright, rotated) };
}

/** 2 つの寸法の相対差（幅・高さの大きいほう）。 */
function deviationFrom(measured: SizeMm, reference: SizeMm): number {
  if (reference.widthMm <= 0 || reference.heightMm <= 0) return Number.POSITIVE_INFINITY;
  return Math.max(
    Math.abs(measured.widthMm - reference.widthMm) / reference.widthMm,
    Math.abs(measured.heightMm - reference.heightMm) / reference.heightMm,
  );
}
