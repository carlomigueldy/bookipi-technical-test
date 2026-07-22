// apps/api/vitest.integration.config.ts  [SLICE E — frozen contract §2.2, §11.1]
//
// INTEGRATION only. Unit specs (`src/**/*.spec.ts`) run under the sibling
// `vitest.config.ts` [SLICE A] and never touch a container. This config exists so
// `pnpm test:integration` can never accidentally pick up a unit spec (or vice versa).
//
// `fileParallelism: false` + `pool: 'forks'` + `poolOptions.forks.singleFork: true`:
// every integration spec file shares ONE Redis and ONE Postgres container for the
// whole run (`global-setup.ts`), and each spec claims its own unique `saleId` — but
// Fastify listeners, ioredis connections, and pg Pools are still process-wide OS
// resources (sockets, fds). Running spec files concurrently in separate workers would
// multiply those far past anything a laptop or CI runner should be asked to hold open
// at once, and Phase 1's `packages/redis` config hit exactly this class of flake
// (see that package's `vitest.config.ts` header) for a subtler reason: shared
// server-global Lua script cache. Single-forking removes both problems by construction
// rather than by chasing individual flakes.
import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    globals: true,
    environment: 'node',
    root: './',
    include: ['test/integration/**/*.integration.spec.ts'],
    globalSetup: './test/global-setup.ts',
    testTimeout: 120_000,
    hookTimeout: 180_000,
    fileParallelism: false,
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
  },
});
