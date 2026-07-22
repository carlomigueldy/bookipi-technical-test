// apps/api/test/integration/clock-skew.integration.spec.ts  [SLICE E]
// Proves the §5 clock resolution (Phase 1 open issue 2) — contract §11.8.
import { SaleRedisStore } from '@flash/redis';
import { purchaseResponseSchema } from '@flash/shared/schemas';
import Redis from 'ioredis';
import { afterAll, describe, expect, inject, it, vi } from 'vitest';

import { type AppHarness, bootHarness } from '../support/app-harness.js';
import { closeHttpAgent, get, post } from '../support/http.js';
import { redisNowMs, seedSale, uniqueSaleId } from '../support/seed.js';

interface ReadinessBody {
  status: string;
  checks: { clock: { ok: boolean } };
}

/**
 * A stub `Clock` matching the frozen `Clock` interface (contract §5.1):
 * `nowMs(): number; offsetMs(): number; rttMs(): number; ageMs(): number; isFresh(): boolean;`
 */
function stubClock(
  overrides: Partial<{ nowMs: number; isFresh: boolean; rttMs: number; ageMs: number }>,
) {
  return {
    nowMs: () => overrides.nowMs ?? Date.now(),
    offsetMs: () => 0,
    rttMs: () => overrides.rttMs ?? 1,
    ageMs: () => overrides.ageMs ?? 0,
    isFresh: () => overrides.isFresh ?? true,
  };
}

async function bootWithClockStub(
  saleId: string,
  overrides: Parameters<typeof stubClock>[0],
): Promise<AppHarness> {
  const { CLOCK } =
    (await import('../../src/common/tokens.js')) as typeof import('../../src/common/tokens.js');
  return bootHarness({
    env: { SALE_ID: saleId },
    overrideModule: (builder) => builder.overrideProvider(CLOCK).useValue(stubClock(overrides)),
  });
}

describe('Clock-skew (contract §5 resolution)', () => {
  afterAll(async () => {
    await closeHttpAgent();
  });

  it('nowMs 5 minutes FAST, isFresh true, window open -> 201 CONFIRMED (fast pod must not reject)', async () => {
    const saleId = uniqueSaleId();
    // Boot once with the real clock just to learn Redis's now, then re-boot with the
    // stub — the stub's nowMs is relative to Redis's clock, not the test process's.
    const probe = await bootHarness({ env: { SALE_ID: `${saleId}-probe` } });
    const redisNow = await redisNowMs(probe.store, `${saleId}-probe`);
    await probe.close();

    const harness = await bootWithClockStub(saleId, { nowMs: redisNow + 300_000, isFresh: true });
    try {
      await seedSale(harness.store, { saleId, stock: 5, startsInMs: -60_000, endsInMs: 600_000 });
      const res = await post(`${harness.baseUrl}/api/purchase`, {
        body: { userId: 'skew-fast-2026' },
      });
      expect(res.status).toBe(201);
      expect(purchaseResponseSchema.parse(res.body).status).toBe('CONFIRMED');
    } finally {
      await harness.close();
    }
  });

  it('nowMs 5 minutes SLOW, isFresh true, window open -> 201 CONFIRMED', async () => {
    const saleId = uniqueSaleId();
    const probe = await bootHarness({ env: { SALE_ID: `${saleId}-probe` } });
    const redisNow = await redisNowMs(probe.store, `${saleId}-probe`);
    await probe.close();

    const harness = await bootWithClockStub(saleId, { nowMs: redisNow - 300_000, isFresh: true });
    try {
      await seedSale(harness.store, { saleId, stock: 5, startsInMs: -60_000, endsInMs: 600_000 });
      const res = await post(`${harness.baseUrl}/api/purchase`, {
        body: { userId: 'skew-slow-2026' },
      });
      expect(res.status).toBe(201);
      expect(purchaseResponseSchema.parse(res.body).status).toBe('CONFIRMED');
    } finally {
      await harness.close();
    }
  });

  it('nowMs +200ms (inside the 250ms margin), window closes in 100ms -> 201 (guard must not speak)', async () => {
    const saleId = uniqueSaleId();
    const probe = await bootHarness({ env: { SALE_ID: `${saleId}-probe` } });
    const redisNow = await redisNowMs(probe.store, `${saleId}-probe`);
    await probe.close();

    const harness = await bootWithClockStub(saleId, { nowMs: redisNow + 200, isFresh: true });
    try {
      await seedSale(harness.store, { saleId, stock: 5, startsInMs: -600_000, endsInMs: 100 });
      const res = await post(`${harness.baseUrl}/api/purchase`, {
        body: { userId: 'skew-margin-2026' },
      });
      expect(res.status).toBe(201);
    } finally {
      await harness.close();
    }
  });

  it('isFresh false, window open -> 201, guard is proven disabled', async () => {
    const saleId = uniqueSaleId();
    const harness = await bootWithClockStub(saleId, { isFresh: false });
    try {
      await seedSale(harness.store, { saleId, stock: 5, startsInMs: -60_000, endsInMs: 600_000 });
      const res = await post(`${harness.baseUrl}/api/purchase`, {
        body: { userId: 'skew-stale-2026' },
      });
      expect(res.status).toBe(201);
    } finally {
      await harness.close();
    }
  });

  it('isFresh false -> GET /api/health/ready is 503 degraded, checks.clock.ok === false', async () => {
    const saleId = uniqueSaleId();
    const harness = await bootWithClockStub(saleId, { isFresh: false });
    try {
      await seedSale(harness.store, { saleId, stock: 5 });
      const res = await get<ReadinessBody>(`${harness.baseUrl}/api/health/ready`);
      expect(res.status).toBe(503);
      expect(res.body.checks.clock.ok).toBe(false);
    } finally {
      await harness.close();
    }
  });

  it('real clock, window closed by 10 minutes -> 403 SALE_ENDED with ZERO purchase.lua invocations', async () => {
    const saleId = uniqueSaleId();

    // Seed BEFORE booting the harness, via an independent connection to the SAME
    // shared test Redis (`inject('redisUrl')` — the same mechanism `app-harness.ts`
    // itself uses). `SaleSnapshotCache` is only refreshed by `RedisAnchoredClock`'s
    // periodic sync tick (§5.2/§5.4 — every `CLOCK_SYNC_INTERVAL_MS`, 5s in this
    // harness's defaults), and the ONLY sync guaranteed to have landed by the time a
    // request arrives is the ONE Nest awaits during `onModuleInit`, before
    // `app.listen()` ever returns. Seeding AFTER boot (the original, buggy form of
    // this test) means that initial sync observes an UNSEEDED sale, so the cache
    // stays `initialized: false` and the fast-path guard correctly stays silent
    // instead of short-circuiting — which then hits the deliberately-disconnected
    // Redis client below and surfaces as 503, not the 403 this test is trying to
    // prove. Seeding first makes the harness's own initial sync the one that
    // observes the already-ended sale, so the guard has real data to short-circuit
    // on the moment the app starts listening.
    const seedRedis = new Redis(inject('redisUrl'), {
      connectionName: 'flash-api-clock-skew-preseed',
    });
    try {
      const seedStore = new SaleRedisStore(seedRedis);
      await seedSale(seedStore, { saleId, stock: 5, startsInMs: -1_200_000, endsInMs: -600_000 });
    } finally {
      seedRedis.disconnect();
    }

    const harness = await bootHarness({ env: { SALE_ID: saleId } });
    try {
      // Own the failure boundary instead of disconnecting the app's shared live
      // ioredis client. If the fast-path guard accidentally reaches purchase.lua,
      // this awaited spy rejection surfaces as UPSTREAM_UNAVAILABLE; the expected
      // 403 therefore still proves the store purchase call was skipped entirely.
      const { SALE_REDIS_STORE } =
        (await import('../../src/common/tokens.js')) as typeof import('../../src/common/tokens.js');
      const appStore = harness.get<import('@flash/redis').SaleRedisStore>(SALE_REDIS_STORE);
      const purchaseSpy = vi
        .spyOn(appStore, 'purchase')
        .mockRejectedValue(new Error('purchase.lua must not run'));

      const res = await post(`${harness.baseUrl}/api/purchase`, {
        body: { userId: 'skew-ended-2026' },
      });
      expect(res.status).toBe(403);
      expect(purchaseResponseSchema.parse(res.body).status).toBe('SALE_ENDED');
      expect(purchaseSpy).not.toHaveBeenCalled();
    } finally {
      await harness.close();
    }
  });
});
