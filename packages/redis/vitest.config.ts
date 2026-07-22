import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.spec.ts'],
    globalSetup: ['./test/global-setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // Every spec file in this package shares ONE live Redis server (test/global-setup
    // provides a single `redisUrl`), and the Lua script cache (`SCRIPT LOAD`/`SCRIPT
    // EXISTS`/`SCRIPT FLUSH`) is server-global state, not sale-scoped. Vitest's default
    // per-file parallelism runs spec files concurrently in separate workers, so
    // `scripts/run.spec.ts`'s `SCRIPT FLUSH` (T4) can race any other file's concurrent
    // purchase()/compensate()/seed() call, which reloads the same script SHA via the
    // EVALSHA->EVAL fallback milliseconds later — an observed, reproduced flake
    // (`SCRIPT EXISTS` returning `[1]` right after a synchronous `FLUSH`). Disabling
    // file parallelism serializes the whole suite against that one shared Redis
    // instance so no spec file can mutate the script cache out from under another's
    // assertion. This does not change, weaken, or skip any assertion.
    fileParallelism: false,
  },
});
