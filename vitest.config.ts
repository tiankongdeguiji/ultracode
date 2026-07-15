import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 20_000,
    // The semantics suite must stay fast and offline; live smoke tests are
    // opt-in via UC_LIVE_TESTS=1 and live in test/live/.
    exclude: ['**/node_modules/**', 'test/live/**'],
  },
});
