import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['_salvage/**', 'node_modules/**', 'dist/**'],
    // Playwright launch under full-suite load can exceed default 10s hooks.
    hookTimeout: 60_000,
    testTimeout: 30_000,
    // 2-core CI runners starve child-process E2E tests (tsx/chromium children)
    // when test files run in parallel. Serial on CI, parallel locally.
    fileParallelism: !process.env.CI,
  },
});
