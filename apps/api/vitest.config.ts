// apps/api/vitest.config.ts  [SLICE A — frozen contract §11.1]
//
// UNIT only: `src/**/*.spec.ts`. No containers, no network — every unit spec in this
// app mocks or structurally fakes its Redis/Postgres/BullMQ dependency (see e.g.
// `common/per-user-rate-limit.guard.spec.ts`'s in-memory `FakeRedisLimiterClient`,
// `infra/clock.service.spec.ts`'s fake `SaleRedisStore`). Real-container coverage
// lives in the sibling `vitest.integration.config.ts` [SLICE E], run by
// `pnpm test:integration`, never by this config.
import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    globals: true,
    environment: 'node',
    root: './',
    include: ['src/**/*.spec.ts'],
  },
});
