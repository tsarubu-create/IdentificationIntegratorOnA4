import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@core': resolve('src/core'),
      '@shared': resolve('src/shared'),
      '@worker': resolve('src/worker'),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // 画像合成を伴うテストがあるため、既定より長めに取る。
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: {
      provider: 'v8',
      include: ['src/core/**', 'src/shared/**'],
      reporter: ['text', 'lcov'],
    },
  },
});
