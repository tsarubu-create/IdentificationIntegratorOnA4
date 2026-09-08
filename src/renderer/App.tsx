/**
 * 画面全体の状態遷移（仕様書 §8）。
 *
 * 設定 -> 解析 -> 確認 -> 出力 -> 結果。
 * **出力は確認画面で「出力開始」が押された後にだけ実行する。**
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  AnalyzedImage,
  AppSettings,
  ComposeResult,
  DocumentKind,
  ProgressUpdate,
} from '@shared/types';
import { ProgressPanel } from '@renderer/components/ProgressPanel';
import { ResultScreen } from '@renderer/components/ResultScreen';
import { ReviewScreen } from '@renderer/components/ReviewScreen';
import { SetupScreen } from '@renderer/components/SetupScreen';
import { Modal } from '@renderer/components/Modal';
import { countIncludable } from '@renderer/includable';

type Phase = 'setup' | 'analyzing' | 'review' | 'composing' | 'result';

export function App(): React.JSX.Element {
  const [settings, setSettings] = useState<AppSettings>({
    outputRoot: null,
    lastInputFolder: null,
  });
  const [inputFolder, setInputFolder] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>('setup');
  const [images, setImages] = useState<readonly AnalyzedImage[]>([]);
  const [kinds, setKinds] = useState<Record<string, DocumentKind>>({});
  const [progress, setProgress] = useState<ProgressUpdate | null>(null);
  const [result, setResult] = useState<ComposeResult | null>(null);
  const [modal, setModal] = useState<{ title: string; body: string } | null>(null);

  useEffect(() => {
    void window.api.getSettings().then((loaded) => {
      setSettings(loaded);
      setInputFolder(loaded.lastInputFolder);
    });
  }, []);

  useEffect(() => window.api.onProgress(setProgress), []);

  const chooseOutputRoot = useCallback(async () => {
    const chosen = await window.api.chooseOutputRoot();
    if (chosen !== null) setSettings((current) => ({ ...current, outputRoot: chosen }));
  }, []);

  const chooseInputFolder = useCallback(async () => {
    const chosen = await window.api.chooseInputFolder();
    if (chosen !== null) setInputFolder(chosen);
  }, []);

  const startAnalysis = useCallback(async () => {
    if (inputFolder === null) return;

    setPhase('analyzing');
    setProgress(null);
    const response = await window.api.analyze({ inputFolder });

    if (!response.ok) {
      setPhase('setup');
      setModal({
        title: '処理を開始できません',
        body:
          response.reason === 'noImages'
            ? '選択したフォルダとそのサブフォルダに、対象となる画像（.jpg / .jpeg / .png / .tif / .tiff）が 1 枚も見つかりませんでした。別のフォルダを選択してください。'
            : response.reason === 'noOutputRoot'
              ? '出力ルートが未設定です。先に出力先フォルダを選択してください。'
              : '入力フォルダを読み取れませんでした。フォルダへのアクセス権を確認してください。',
      });
      return;
    }

    setImages(response.images);
    setKinds(Object.fromEntries(response.images.map((image) => [image.id, image.kind])));
    setPhase('review');
  }, [inputFolder]);

  const cancel = useCallback(async () => {
    await window.api.cancel();
    setImages([]);
    setKinds({});
    setProgress(null);
    setPhase('setup');
  }, []);

  const startCompose = useCallback(async () => {
    setPhase('composing');
    setProgress(null);
    const response = await window.api.compose({ kinds });

    if (!response.ok) {
      setPhase('review');
      setModal({
        title: '出力に失敗しました',
        body:
          response.reason === 'noOutputRoot'
            ? '出力ルートが未設定です。'
            : (response.message ?? '不明なエラーが発生しました。'),
      });
      return;
    }

    setResult(response.result);
    setPhase('result');
  }, [kinds]);

  // 種別を変えると収まり判定が変わるため、選択に追随して数え直す。
  const includableCount = useMemo(() => countIncludable(images, kinds), [images, kinds]);

  return (
    <div className="app">
      <header className="app__header">
        <h1>スキャン身分証 A4 統合</h1>
        <p className="app__subtitle">
          すべてローカルで処理します。画像やログを外部へ送信することはありません。
        </p>
      </header>

      <main className="app__main">
        {phase === 'setup' && (
          <SetupScreen
            outputRoot={settings.outputRoot}
            inputFolder={inputFolder}
            onChooseOutputRoot={() => void chooseOutputRoot()}
            onChooseInputFolder={() => void chooseInputFolder()}
            onStart={() => void startAnalysis()}
          />
        )}

        {phase === 'analyzing' && (
          <ProgressPanel title="画像を解析しています" progress={progress} onCancel={() => void cancel()} />
        )}

        {phase === 'review' && (
          <ReviewScreen
            images={images}
            kinds={kinds}
            includableCount={includableCount}
            onChangeKind={(id, kind) => setKinds((current) => ({ ...current, [id]: kind }))}
            onCancel={() => void cancel()}
            onStart={() => void startCompose()}
          />
        )}

        {phase === 'composing' && (
          <ProgressPanel title="A4 ページを生成しています" progress={progress} />
        )}

        {phase === 'result' && result !== null && (
          <ResultScreen
            result={result}
            onOpenFolder={() => void window.api.openOutputFolder()}
            onBack={() => {
              setPhase('setup');
              setImages([]);
              setResult(null);
            }}
          />
        )}
      </main>

      {modal !== null && (
        <Modal title={modal.title} onClose={() => setModal(null)}>
          {modal.body}
        </Modal>
      )}
    </div>
  );
}
