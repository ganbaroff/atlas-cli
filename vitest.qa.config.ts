import { defineConfig } from 'vitest/config';

/** P1: QA runtime pack only. Not used by default `npm test` / CI. */
export default defineConfig({
  test: {
    include: ['qa/runtime/**/*.test.ts'],
    exclude: ['node_modules/**', 'dist/**', 'src/**'],
    passWithNoTests: true,
  },
});
