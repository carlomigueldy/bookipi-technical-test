// apps/api/test/integration/concurrency-negative-control.integration.spec.ts  [SLICE E]
// THE NEGATIVE CONTROL — contract §11.4, Phase 1 T2 precedent. Runs the IDENTICAL
// 500-parallel / stock=10 scenario as concurrency.integration.spec.ts, but with the
// real PurchaseService swapped for the deliberately non-atomic UnsafePurchaseService.
// If this does NOT oversell, the money test has no discriminating power and its green
// is meaningless — so THIS spec fails loudly if the harness cannot detect a violation.
import { randomUUID } from 'node:crypto';

import { saleKeys } from '@flash/shared';
import Redis from 'ioredis';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import { type AppHarness, bootHarness } from '../support/app-harness.js';
import { closeHttpAgent, post } from '../support/http.js';
import { seedSale } from '../support/seed.js';
import { UnsafePurchaseService } from '../support/unsafe-purchase.service.js';

const N_REQUESTS = 500;
const STOCK = 10;

describe('NEGATIVE CONTROL — UnsafePurchaseService must oversell under the identical scenario', () => {
  let harness: AppHarness;

  beforeEach(async () => {
    harness = await bootHarness({
      env: { RATE_LIMIT_MAX: '100000', RATE_LIMIT_USER_MAX: '100000' },
      // MUST import `PurchaseService` from INSIDE this callback, not in an outer
      // closure — `bootHarness` calls this AFTER its own `vi.resetModules()`, and
      // `.overrideProvider(SomeClass)` matches by class-object identity. Importing
      // it earlier (before the reset) yields a stale class object that matches
      // nothing in the freshly-built module, so the override silently no-ops and
      // every request would silently run the REAL `PurchaseService` instead of
      // this negative control's whole point — see `app-harness.ts`'s
      // `overrideModule` doc comment for the full explanation of this footgun.
      overrideModule: async (builder) => {
        const { PurchaseService } =
          (await import('../../src/purchase/purchase.service.js')) as typeof import('../../src/purchase/purchase.service.js');
        return builder.overrideProvider(PurchaseService).useClass(UnsafePurchaseService);
      },
    });
  });

  afterEach(async () => {
    await harness.close();
  });

  afterAll(async () => {
    await closeHttpAgent();
  });

  it('oversells: confirmed > 10 and final stock < 0', async () => {
    await seedSale(harness.store, {
      saleId: harness.saleId,
      stock: STOCK,
      startsInMs: -60_000,
      endsInMs: 600_000,
    });

    const userIds = Array.from({ length: N_REQUESTS }, (_, i) => `unsafe-${i}-${randomUUID()}`);

    const responses = await Promise.all(
      userIds.map((userId) => post(`${harness.baseUrl}/api/purchase`, { body: { userId } })),
    );

    const confirmed = responses.filter((res) => res.status === 201).length;

    const raw = new Redis(harness.redisUrl, { connectionName: 'flash-api-negative-control' });
    try {
      const keys = saleKeys(harness.saleId);
      const finalStockRaw = await raw.get(keys.stock);
      const finalStock = finalStockRaw === null ? Number.NaN : Number(finalStockRaw);

      // THE POINT OF THIS SPEC: the harness must be able to catch this. If both of
      // these assertions fail (i.e. the unsafe implementation somehow did NOT
      // oversell), this spec fails — which is the correct outcome, because it would
      // mean the money test's green tells us nothing.
      expect(confirmed).toBeGreaterThan(STOCK);
      expect(finalStock).toBeLessThan(0);
    } finally {
      raw.disconnect();
    }
  });
});
