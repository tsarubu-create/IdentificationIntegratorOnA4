/**
 * OpenCV の型だけをここへ隔離する。
 *
 * `@techstark/opencv-js` は WASM を埋め込んだ 10.8MB の単一 CJS ファイルである。
 * `.ts` ファイル側でこのモジュールを型位置（`import type` や `typeof import()`）から
 * 参照すると、Vitest / Vite の変換パイプラインが実体を依存グラフへ引き込み、
 * 変換が返ってこなくなる（ランタイム初期化が永久に完了しない）。
 *
 * 宣言ファイル（`.d.ts`）は tsc だけが読み、バンドラの依存グラフには載らない。
 * そのため型解決だけをここで行えば、実体の読み込みは `require` の 1 経路に保たれる。
 */
export type OpenCv = typeof import('@techstark/opencv-js');
