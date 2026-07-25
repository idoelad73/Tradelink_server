import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals:     false,
    include:     ['tests/**/*.test.js'],
    setupFiles:  ['./tests/setup.js'],
    // Each file gets its own process so the module-level mocks in setup.js and
    // the in-memory Mongo state can't leak between files.
    pool: 'forks',
    // Booting mongodb-memory-server on a cold cache is slow the first time.
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
