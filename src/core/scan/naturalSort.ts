/**
 * 相対パスの自然順ソート（仕様書 §7.2 / §11-4）。
 *
 * `img2.jpg` が `img10.jpg` より前に来ることを保証する。
 */

/**
 * 照合器はロケールを明示的に固定する。
 *
 * ロケール未指定にすると実行環境の既定ロケールに依存し、開発機と利用者環境で
 * 並び順が変わりうる。日本語ファイル名を主対象とするため 'ja' を指定する。
 */
const collator = new Intl.Collator('ja', {
  numeric: true,
  sensitivity: 'variant',
  caseFirst: 'upper',
});

/** パス区切りを '/' に正規化する（Windows の '\\' を吸収）。 */
export function normalizeSeparators(relativePath: string): string {
  return relativePath.replace(/\\/g, '/');
}

/**
 * 相対パス 2 つを自然順で比較する。
 *
 * パス全体を 1 つの文字列として比較せず、**セグメント単位**で比較する。
 * 文字列全体で比較すると `a/b.jpg` と `a-1/c.jpg` の順序が区切り文字の
 * コードポイントに左右され、フォルダ単位のまとまりが崩れるため。
 */
export function compareNatural(a: string, b: string): number {
  const segmentsA = normalizeSeparators(a).split('/');
  const segmentsB = normalizeSeparators(b).split('/');
  const shared = Math.min(segmentsA.length, segmentsB.length);

  for (let i = 0; i < shared; i += 1) {
    const isLastA = i === segmentsA.length - 1;
    const isLastB = i === segmentsB.length - 1;

    // この階層で一方がファイル、他方がフォルダなら、**浅い方（ファイル）を先**にする。
    // 名前で比較すると `a.jpg` と `a/2.jpg` の順序が拡張子の綴りに左右され、
    // 「ルート直下のスキャンが先、サブフォルダは後」という直感から外れるため。
    if (isLastA !== isLastB) return isLastA ? -1 : 1;

    const result = collator.compare(segmentsA[i] ?? '', segmentsB[i] ?? '');
    if (result !== 0) return result;
  }

  // 全セグメントが一致（正規化後の同一パス）。
  return segmentsA.length - segmentsB.length;
}

/** 相対パスの配列を自然順に並べた新しい配列を返す（入力は変更しない）。 */
export function sortNatural(paths: readonly string[]): string[] {
  return [...paths].sort(compareNatural);
}

/** 任意のオブジェクト配列を、相対パスの自然順で並べた新しい配列を返す。 */
export function sortByRelativePath<T>(items: readonly T[], key: (item: T) => string): T[] {
  return [...items].sort((a, b) => compareNatural(key(a), key(b)));
}
