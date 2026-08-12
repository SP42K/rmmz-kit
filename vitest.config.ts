import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    // Nearly every test copies fixtures/minimal-project and `git init`s it,
    // which on Windows costs 1-2s per test on its own; run a dozen files in
    // parallel — one of them CPU-bound (battlesim) — and the default 5s
    // timeout starts firing on tests that are merely queued, not stuck.
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
