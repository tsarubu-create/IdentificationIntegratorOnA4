/**
 * コードから表示文言への変換（仕様書 §8 / §9）。
 *
 * ログには常にコードだけを残し、日本語の文言はここだけで組み立てる。
 * こうしておくと「ログに何が書かれるか」を文言と切り離して保証できる。
 */

import type { DetectionStatus, ExclusionReason, LimitViolation, WarningCode } from '@shared/types';

const MEGA_PIXEL = 1_000_000;
const MEGA_BYTE = 1024 * 1024;

/** 検出状態の表示名。 */
export const DETECTION_STATUS_LABEL: Record<DetectionStatus, string> = {
  detected: '検出成功',
  needsReview: '要確認',
  failed: '検出失敗',
};

/** 除外理由の表示名。 */
export const EXCLUSION_LABEL: Record<ExclusionReason, string> = {
  fileTooLarge: 'ファイルサイズが上限を超過',
  sideTooLarge: '画像の辺が上限を超過',
  tooManyPixels: '総画素数が上限を超過',
  decodeFailed: '画像を読み込めません（破損の可能性）',
  unsupportedFormat: '対応していない形式です',
  iccUnreadable: 'カラープロファイルを読み取れません',
  detectionFailed: '身分証を検出できませんでした',
  doesNotFitCell: '実寸がセルに収まりません（縮小しない設定のため除外）',
  doesNotFitPrintableArea: '実寸が印刷可能領域に収まりません（縮小しない設定のため除外）',
};

/** 警告の表示名。 */
export const WARNING_LABEL: Record<WarningCode, string> = {
  dpiMissing: 'DPI情報なし・300dpiとして配置',
  multipleCandidates: '候補が複数あります',
  lowConfidence: '検出の確からしさが低めです',
  iccIgnored: 'カラープロファイルを無視して読み込みました',
  nonStandardSize: '規格の寸法と一致しません（実測値で配置します）',
};

/**
 * 上限超過に対して、利用者がとれる対応を文章にする（仕様書 §9）。
 */
export function describeRemedy(violation: LimitViolation): string {
  switch (violation.reason) {
    case 'fileTooLarge':
      return (
        `ファイルサイズ ${formatMegabytes(violation.actual)} が上限 ` +
        `${formatMegabytes(violation.limit)} を超えています。` +
        'スキャン解像度を下げるか、可逆圧縮の形式で保存し直してください。'
      );
    case 'sideTooLarge':
      return (
        `画像の辺 ${violation.actual.toLocaleString('ja-JP')}px が上限 ` +
        `${violation.limit.toLocaleString('ja-JP')}px を超えています。` +
        'スキャン範囲を身分証の周辺だけに絞って再スキャンしてください。'
      );
    case 'tooManyPixels':
      return (
        `総画素数 ${formatMegapixels(violation.actual)} が上限 ` +
        `${formatMegapixels(violation.limit)} を超えています。` +
        'スキャン解像度を 600dpi 以下にして再スキャンしてください。'
      );
  }
}

/**
 * DPI の表示文字列。
 *
 * 埋め込み値が無い場合の文言は仕様書 §6 が指定するものをそのまま使う。
 */
export function formatDpi(embeddedDpi: number | null): string {
  if (embeddedDpi === null) return WARNING_LABEL.dpiMissing;
  return `${embeddedDpi}dpi`;
}

/** 配置サイズ（mm）の表示文字列。 */
export function formatSizeMm(widthMm: number, heightMm: number): string {
  return `${widthMm.toFixed(1)} x ${heightMm.toFixed(1)} mm`;
}

function formatMegabytes(bytes: number): string {
  return `${(bytes / MEGA_BYTE).toFixed(0)} MB`;
}

function formatMegapixels(pixels: number): string {
  return `${(pixels / MEGA_PIXEL).toFixed(0)} Mpx`;
}
