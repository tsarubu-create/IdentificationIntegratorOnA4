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
}

export function Thumbnail({ data, alt }: ThumbnailProps): React.JSX.Element {
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

  if (url === null) {
    return <div className="thumbnail thumbnail--empty">画像なし</div>;
  }

  return <img className="thumbnail" src={url} alt={alt} />;
}
