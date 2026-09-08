/**
 * 確認画面のサムネイル（仕様書 §11-5）。
 *
 * サムネイルは `ArrayBuffer` としてメモリ上にだけ存在する。Blob URL を作って表示し、
 * **行が消えるときに必ず `revokeObjectURL` する**。解放し忘れると、画像枚数に比例して
 * レンダラのメモリが増え続ける（ディスクには一切書き出さない）。
 */

import { useEffect, useState } from 'react';

interface ThumbnailProps {
  readonly data: ArrayBuffer | null;
  readonly alt: string;
  /**
   * 表示の大きさ。
   * - `review`: 確認画面の入力プレビュー
   * - `result`: 出力結果画面。入力プレビューの縦横 3 倍で表示する
   */
  readonly variant?: 'review' | 'result';
}

export function Thumbnail({ data, alt, variant = 'review' }: ThumbnailProps): React.JSX.Element {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (data === null) {
      setUrl(null);
      return;
    }

    const objectUrl = URL.createObjectURL(new Blob([data], { type: 'image/webp' }));
    setUrl(objectUrl);

    return () => {
      URL.revokeObjectURL(objectUrl);
    };
  }, [data]);

  const className = variant === 'result' ? 'thumbnail thumbnail--result' : 'thumbnail';

  if (url === null) {
    return <div className={`${className} thumbnail--empty`}>画像なし</div>;
  }

  return <img className={className} src={url} alt={alt} />;
}
