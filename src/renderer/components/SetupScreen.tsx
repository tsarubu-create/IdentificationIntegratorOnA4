/**
 * 設定画面（仕様書 §4 / §8）。
 *
 * 出力ルートは必須。未設定のまま解析を始めると、出力先を走査除外できないため。
 */

interface SetupScreenProps {
  readonly outputRoot: string | null;
  readonly inputFolder: string | null;
  readonly onChooseOutputRoot: () => void;
  readonly onChooseInputFolder: () => void;
  readonly onStart: () => void;
}

export function SetupScreen({
  outputRoot,
  inputFolder,
  onChooseOutputRoot,
  onChooseInputFolder,
  onStart,
}: SetupScreenProps): React.JSX.Element {
  const canStart = outputRoot !== null && inputFolder !== null;

  return (
    <section className="panel">
      <ol className="setup">
        <li className="setup__step">
          <div className="setup__label">
            <span className="setup__number">1</span>
            <div>
              <h2>出力ルート</h2>
              <p className="setup__hint">
                選択したフォルダの直下に <code>A4Integrate</code> を作成し、そこへ出力します。
                出力先は次回以降の走査から必ず除外されます。
              </p>
            </div>
          </div>
          <div className="setup__control">
            <button type="button" className="button" onClick={onChooseOutputRoot}>
              フォルダを選択
            </button>
            <p className={outputRoot === null ? 'path path--empty' : 'path'}>
              {outputRoot ?? '未設定'}
            </p>
          </div>
        </li>

        <li className="setup__step">
          <div className="setup__label">
            <span className="setup__number">2</span>
            <div>
              <h2>入力フォルダ</h2>
              <p className="setup__hint">
                サブフォルダを含めて再帰的に読み取ります。対象は .jpg / .jpeg / .png / .tif / .tiff
                です。入力ファイルは読み取りのみで、削除・移動・変更は行いません。
              </p>
            </div>
          </div>
          <div className="setup__control">
            <button type="button" className="button" onClick={onChooseInputFolder}>
              フォルダを選択
            </button>
            <p className={inputFolder === null ? 'path path--empty' : 'path'}>
              {inputFolder ?? '未設定'}
            </p>
          </div>
        </li>
      </ol>

      <div className="panel__actions">
        <button
          type="button"
          className="button button--primary"
          disabled={!canStart}
          onClick={onStart}
        >
          解析を開始
        </button>
        {!canStart && (
          <span className="panel__note">出力ルートと入力フォルダの両方を選択してください。</span>
        )}
      </div>
    </section>
  );
}
