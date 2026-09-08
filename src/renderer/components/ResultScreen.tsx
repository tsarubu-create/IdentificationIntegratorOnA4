/** 出力結果の表示（仕様書 §8）。 */

import type { ComposeResult } from '@shared/types';
import { EXCLUSION_LABEL } from '@renderer/labels';

interface ResultScreenProps {
  readonly result: ComposeResult;
  readonly onOpenFolder: () => void;
  readonly onBack: () => void;
}

export function ResultScreen({
  result,
  onOpenFolder,
  onBack,
}: ResultScreenProps): React.JSX.Element {
  return (
    <section className="panel">
      <h2>出力が完了しました</h2>

      <dl className="result__stats">
        <div>
          <dt>生成ページ数</dt>
          <dd>
            <strong>{result.pageCount}</strong> ページ
          </dd>
        </div>
        <div>
          <dt>除外された画像</dt>
          <dd>
            <strong>{result.excluded.length}</strong> 件
          </dd>
        </div>
      </dl>

      {result.fileNames.length > 0 && (
        <>
          <h3>生成したファイル</h3>
          <ul className="result__files">
            {result.fileNames.map((name) => (
              <li key={name}>{name}</li>
            ))}
          </ul>
        </>
      )}

      {result.excluded.length > 0 && (
        <>
          <h3>除外された画像と理由</h3>
          <ul className="result__excluded">
            {result.excluded.map((entry) => (
              <li key={entry.relativePath}>
                <span className="result__path">{entry.relativePath}</span>
                <span className="reason reason--error">{EXCLUSION_LABEL[entry.reason]}</span>
              </li>
            ))}
          </ul>
        </>
      )}

      <div className="panel__actions">
        <button type="button" className="button button--primary" onClick={onOpenFolder}>
          出力フォルダを開く
        </button>
        <button type="button" className="button" onClick={onBack}>
          最初に戻る
        </button>
      </div>
    </section>
  );
}
