/** 進捗表示（仕様書 §8）。 */

import type { ProgressUpdate } from '@shared/types';

interface ProgressPanelProps {
  readonly title: string;
  readonly progress: ProgressUpdate | null;
  readonly onCancel?: () => void;
}

const PHASE_LABEL: Record<ProgressUpdate['phase'], string> = {
  scanning: 'フォルダを走査しています',
  analyzing: '画像を解析しています',
  composing: 'A4 ページを生成しています',
  done: '完了しました',
};

export function ProgressPanel({
  title,
  progress,
  onCancel,
}: ProgressPanelProps): React.JSX.Element {
  const total = progress?.total ?? 0;
  const completed = progress?.completed ?? 0;
  const ratio = total > 0 ? Math.min(1, completed / total) : 0;

  return (
    <section className="panel">
      <h2>{title}</h2>
      <p className="progress__phase">
        {progress === null ? '準備中…' : PHASE_LABEL[progress.phase]}
      </p>

      <div
        className="progress__bar"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={completed}
      >
        <div
          className={total > 0 ? 'progress__fill' : 'progress__fill progress__fill--indeterminate'}
          style={total > 0 ? { width: `${(ratio * 100).toFixed(1)}%` } : undefined}
        />
      </div>

      <p className="progress__count">
        {total > 0 ? `${completed} / ${total}` : '件数を数えています…'}
      </p>
      {progress?.currentRelativePath !== null && progress?.currentRelativePath !== undefined && (
        <p className="progress__current">{progress.currentRelativePath}</p>
      )}

      {onCancel !== undefined && (
        <div className="panel__actions">
          <button type="button" className="button" onClick={onCancel}>
            中止
          </button>
        </div>
      )}
    </section>
  );
}
