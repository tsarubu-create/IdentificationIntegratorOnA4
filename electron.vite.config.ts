import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';

const alias = {
  '@core': resolve('src/core'),
  '@shared': resolve('src/shared'),
  '@worker': resolve('src/worker'),
  '@main': resolve('src/main'),
  '@renderer': resolve('src/renderer'),
};

export default defineConfig({
  main: {
    resolve: { alias },
    // sharp と opencv-js はネイティブ / WASM 資産を伴うため、バンドルせず
    // node_modules から解決させる（asarUnpack と対になる設定）。
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'dist-electron/main',
      rollupOptions: {
        input: {
          index: resolve('src/main/index.ts'),
          // ワーカーは main と同じ Node 環境で動くため、同じビルドに含める。
          worker: resolve('src/worker/imageWorker.ts'),
        },
        output: {
          // worker_threads は実ファイルパスを要求するため、チャンク名を固定する。
          entryFileNames: '[name].js',
        },
      },
    },
  },
  preload: {
    resolve: { alias },
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'dist-electron/preload',
      rollupOptions: {
        input: { index: resolve('src/preload/index.ts') },
        output: {
          entryFileNames: '[name].cjs',
          format: 'cjs',
        },
      },
    },
  },
  renderer: {
    root: 'src/renderer',
    resolve: { alias },
    plugins: [react()],
    build: {
      outDir: resolve('dist'),
      rollupOptions: {
        input: { index: resolve('src/renderer/index.html') },
      },
    },
  },
});
