import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['_salvage/**', 'node_modules/**', 'dist/**'],
    // Playwright launch under full-suite load can exceed default 10s hooks.
    hookTimeout: 60_000,
    testTimeout: 30_000,
  },
});
