/**
 * 確認画面（仕様書 §8）。
 *
 * 生成前に必ずここを通す。利用者はここで書類種別を選び、中止もできる。
 * 中止した場合、出力は一切作られない。
 */

import { useMemo } from 'react';
import type { AnalyzedImage, DocumentKind } from '@shared/types';
import { resolvePlacement } from '@core/layout/placement';
import {
  DETECTION_STATUS_LABEL,
  EXCLUSION_LABEL,
  WARNING_LABEL,
  describeRemedy,
  formatDpi,
  formatSizeMm,
} from '@renderer/labels';
import { Thumbnail } from '@renderer/components/Thumbnail';
import { resolveExclusion } from '@renderer/includable';

interface ReviewScreenProps {
  readonly images: readonly AnalyzedImage[];
  readonly kinds: Readonly<Record<string, DocumentKind>>;
  readonly includableCount: number;
  readonly onChangeKind: (id: string, kind: DocumentKind) => void;
  readonly onCancel: () => void;
  readonly onStart: () => void;
}

export function ReviewScreen({
  images,
  kinds,
  includableCount,
  onChangeKind,
  onCancel,
  onStart,
}: ReviewScreenProps): React.JSX.Element {
  return (
    <section className="panel panel--wide">
      <div className="review__summary">
        <p>
          <strong>{images.length}</strong> 件を解析しました。 このうち{' '}
          <strong>{includableCount}</strong> 件が出力対象です。
        </p>
        <p className="review__note">
          出力は「出力開始」を押した後にのみ生成されます。中止した場合、ファイルは一切作成されません。
        </p>
      </div>

      <div className="review__table-wrap">
        <table className="review__table">
          <thead>
            <tr>
              <th scope="col">サムネイル</th>
              <th scope="col">相対パス</th>
              <th scope="col">検出状態</th>
              <th scope="col">DPI</th>
              <th scope="col">A4 上の配置サイズ</th>
              <th scope="col">種別</th>
              <th scope="col">警告・除外理由</th>
            </tr>
          </thead>
          <tbody>
            {images.map((image) => (
              <ReviewRow
                key={image.id}
                image={image}
                kind={kinds[image.id] ?? 'idCard'}
                onChangeKind={onChangeKind}
              />
            ))}
          </tbody>
        </table>
      </div>

      <div className="panel__actions">
        <button type="button" className="button" onClick={onCancel}>
          中止
        </button>
        <button
          type="button"
          className="button button--primary"
          disabled={includableCount === 0}
          onClick={onStart}
        >
          出力開始
        </button>
        {includableCount === 0 && <span className="panel__note">出力できる画像がありません。</span>}
      </div>
    </section>
  );
}

interface ReviewRowProps {
  readonly image: AnalyzedImage;
  readonly kind: DocumentKind;
  readonly onChangeKind: (id: string, kind: DocumentKind) => void;
}

function ReviewRow({ image, kind, onChangeKind }: ReviewRowProps): React.JSX.Element {
  // 種別を変えると配置サイズと収まり判定が変わるため、選択に追随して再計算する。
  const placement = useMemo(
    () => (image.physicalSize === null ? null : resolvePlacement(image.physicalSize, kind)),
    [image.physicalSize, kind],
  );
  const exclusion = useMemo(() => resolveExclusion(image, kind), [image, kind]);
  const isExcluded = exclusion !== null;

  return (
    <tr className={isExcluded ? 'review__row review__row--excluded' : 'review__row'}>
      <td>
        <Thumbnail data={image.thumbnail} alt={`${image.relativePath} の切り出し結果`} />
      </td>
      <td className="review__path">{image.relativePath}</td>
      <td>
        <span className={`badge badge--${image.status}`}>
          {DETECTION_STATUS_LABEL[image.status]}
        </span>
      </td>
      <td className="review__dpi">{formatDpi(image.embeddedDpi)}</td>
      <td>
        {placement === null
          ? '—'
          : formatSizeMm(placement.sizeMm.widthMm, placement.sizeMm.heightMm)}
      </td>
      <td>
        <select
          className="select"
          value={kind}
          disabled={image.physicalSize === null}
          onChange={(event) => onChangeKind(image.id, event.target.value as DocumentKind)}
          aria-label={`${image.relativePath} の書類種別`}
        >
          <option value="idCard">身分証カード</option>
          <option value="passportSpread">パスポート見開き</option>
        </select>
      </td>
      <td className="review__reasons">
        {image.warnings.map((warning) => (
          <div key={warning} className="reason reason--warn">
            {WARNING_LABEL[warning]}
          </div>
        ))}
        {exclusion !== null && (
          <div className="reason reason--error">{EXCLUSION_LABEL[exclusion]}</div>
        )}
        {image.limitViolation !== null && (
          <div className="reason reason--remedy">{describeRemedy(image.limitViolation)}</div>
        )}
      </td>
    </tr>
  );
}
