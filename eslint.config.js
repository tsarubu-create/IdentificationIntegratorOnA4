import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

/**
 * 仕様書 §9 の「ローカル完結」を lint で機械的に担保する。
 * - どのレイヤーからもネットワーク系 API / SDK を参照させない
 * - renderer から Node の I/O を参照させない（sandbox の二重化）
 * - core を Electron / ネイティブ依存から独立させ、テスト可能性を維持する
 */

/** ネットワーク送信につながるモジュールは全レイヤーで禁止する。 */
const forbiddenNetworkModules = [
  { name: 'http', message: 'ネットワーク通信は仕様書 §9 により禁止です。' },
  { name: 'https', message: 'ネットワーク通信は仕様書 §9 により禁止です。' },
  { name: 'node:http', message: 'ネットワーク通信は仕様書 §9 により禁止です。' },
  { name: 'node:https', message: 'ネットワーク通信は仕様書 §9 により禁止です。' },
  { name: 'node:net', message: 'ネットワーク通信は仕様書 §9 により禁止です。' },
  { name: 'node:dgram', message: 'ネットワーク通信は仕様書 §9 により禁止です。' },
  { name: 'node:tls', message: 'ネットワーク通信は仕様書 §9 により禁止です。' },
  { name: 'undici', message: 'ネットワーク通信は仕様書 §9 により禁止です。' },
  { name: 'axios', message: 'ネットワーク通信は仕様書 §9 により禁止です。' },
  { name: 'node-fetch', message: 'ネットワーク通信は仕様書 §9 により禁止です。' },
];

export default tseslint.config(
  {
    ignores: ['dist/**', 'dist-electron/**', 'release/**', 'node_modules/**', 'coverage/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      'no-restricted-imports': ['error', { paths: forbiddenNetworkModules }],
      'no-restricted-globals': [
        'error',
        { name: 'fetch', message: 'ネットワーク通信は仕様書 §9 により禁止です。' },
        { name: 'XMLHttpRequest', message: 'ネットワーク通信は仕様書 §9 により禁止です。' },
        { name: 'WebSocket', message: 'ネットワーク通信は仕様書 §9 により禁止です。' },
      ],
      eqeqeq: ['error', 'always'],
    },
  },
  {
    // core は Electron / ネイティブ依存を持たない純粋ロジック層に保つ。
    files: ['src/core/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            ...forbiddenNetworkModules,
            {
              name: 'electron',
              message: 'core は Electron 非依存に保ってください（テスト可能性のため）。',
            },
            {
              name: 'sharp',
              message: 'core は画像ライブラリ非依存に保ってください。I/O は worker 層で行います。',
            },
            {
              name: '@techstark/opencv-js',
              message: 'core は OpenCV 非依存に保ってください。検出実行は worker 層で行います。',
            },
          ],
        },
      ],
    },
  },
  {
    // renderer は fs / net を一切参照しない（sandbox に加えた静的な担保）。
    files: ['src/renderer/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'no-restricted-imports': [
        'error',
        {
          paths: [
            ...forbiddenNetworkModules,
            { name: 'fs', message: 'renderer から I/O は行いません。preload 経由にしてください。' },
            {
              name: 'node:fs',
              message: 'renderer から I/O は行いません。preload 経由にしてください。',
            },
            {
              name: 'node:fs/promises',
              message: 'renderer から I/O は行いません。preload 経由にしてください。',
            },
            {
              name: 'electron',
              message: 'renderer は window.api のみを使用します。',
            },
          ],
        },
      ],
    },
  },
  {
    // 設定ファイル自身（JS）は tsconfig の対象外なので、型情報つきルールを外す。
    files: ['**/*.js'],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    files: ['tests/**/*.ts', '*.config.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
    },
  },
);
