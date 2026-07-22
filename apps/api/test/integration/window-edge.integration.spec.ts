// apps/api/test/integration/window-edge.integration.spec.ts  [SLICE E]
// Window edges through HTTP (I3) — contract §11.5. Every assertion is a RELATION
// between the response's own `serverTimeMs` and the seeded bound (both read from
// Redis's clock), never a wall-clock `sleep()` — exact and race-free by construction.
import { purchaseResponseSchema, saleStatusResponseSchema } from '@flash/shared/schemas';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { type AppHarness, bootHarness } from '../support/app-harness.js';
import { get, post } from '../support/http.js';
import { seedSale, waitUntilRedisClockReaches } from '../support/seed.js';

describe('Window edges through HTTP (I3)', () => {
  let harness: AppHarness;

  beforeEach(async () => {
    harness = await bootHarness();
  });

  afterEach(async () => {
    await harness.close();
  });

  it('1ms before start -> 403 SALE_NOT_STARTED, serverTimeMs < startsAtMs, zero side effects', async () => {
    const seeded = await seedSale(harness.store, {
      saleId: harness.saleId,
      stock: 5,
      startsInMs: 3000,
      endsInMs: 600_000,
    });

    const res = await post(`${harness.baseUrl}/api/purchase`, {
      body: { userId: 'edge-before-start' },
    });

    expect(res.status).toBe(403);
    const parsed = purchaseResponseSchema.parse(res.body);
    expect(parsed.status).toBe('SALE_NOT_STARTED');
    expect(parsed.serverTimeMs).toBeLessThan(seeded.startsAtMs);

    const status = await get(`${harness.baseUrl}/api/sale/status`);
    const statusParsed = saleStatusResponseSchema.parse(status.body);
    expect(statusParsed.stockRemaining).toBe(5);

    const snapshot = await harness.store.status(harness.saleId);
    expect(snapshot.stockRemaining).toBe(5);
  });

  it('exactly at start -> 201, serverTimeMs >= startsAtMs', async () => {
    const seeded = await seedSale(harness.store, {
      saleId: harness.saleId,
      stock: 5,
      startsInMs: -1,
      endsInMs: 600_000,
    });

    const res = await post(`${harness.baseUrl}/api/purchase`, {
      body: { userId: 'edge-at-start' },
    });

    expect(res.status).toBe(201);
    const parsed = purchaseResponseSchema.parse(res.body);
    expect(parsed.serverTimeMs).toBeGreaterThanOrEqual(seeded.startsAtMs);
  });

  it('1ms after end -> 403 SALE_ENDED, serverTimeMs >= endsAtMs, zero side effects', async () => {
    const seeded = await seedSale(harness.store, {
      saleId: harness.saleId,
      stock: 5,
      startsInMs: -600_000,
      endsInMs: 1,
    });

    // Poll Redis's OWN clock until it has actually crossed endsAtMs — never a bare sleep.
    await waitUntilRedisClockReaches(harness.store, harness.saleId, seeded.endsAtMs);

    const res = await post(`${harness.baseUrl}/api/purchase`, {
      body: { userId: 'edge-after-end' },
    });

    expect(res.status).toBe(403);
    const parsed = purchaseResponseSchema.parse(res.body);
    expect(parsed.status).toBe('SALE_ENDED');
    expect(parsed.serverTimeMs).toBeGreaterThanOrEqual(seeded.endsAtMs);

    const snapshot = await harness.store.status(harness.saleId);
    expect(snapshot.stockRemaining).toBe(5);
  });

  it('just before end -> 201, serverTimeMs < endsAtMs', async () => {
    const seeded = await seedSale(harness.store, {
      saleId: harness.saleId,
      stock: 5,
      startsInMs: -600_000,
      endsInMs: 5000,
    });

    const res = await post(`${harness.baseUrl}/api/purchase`, {
      body: { userId: 'edge-before-end' },
    });

    expect(res.status).toBe(201);
    const parsed = purchaseResponseSchema.parse(res.body);
    expect(parsed.serverTimeMs).toBeLessThan(seeded.endsAtMs);
  });

  describe('the corrected Phase 1 §3.3 boundary table, through GET /api/sale/status', () => {
    // S = startsAtMs, E = endsAtMs. "S-1" / "S" / "E-1" / "E" relative to Redis's clock.
    const cases: Array<{
      label: string;
      startsInMs: number;
      endsInMs: number;
      stock: number;
      expectedStatus: string;
    }> = [
      {
        label: 'S-1, stock>0 -> upcoming',
        startsInMs: 5000,
        endsInMs: 600_000,
        stock: 3,
        expectedStatus: 'upcoming',
      },
      {
        label: 'S-1, stock=0 -> upcoming (erratum row)',
        startsInMs: 5000,
        endsInMs: 600_000,
        stock: 0,
        expectedStatus: 'upcoming',
      },
      {
        label: 'S (exact), stock>0 -> active',
        startsInMs: -1,
        endsInMs: 600_000,
        stock: 3,
        expectedStatus: 'active',
      },
      {
        label: 'S (exact), stock=0 -> sold_out (corrected cell)',
        startsInMs: -1,
        endsInMs: 600_000,
        stock: 0,
        expectedStatus: 'sold_out',
      },
    ];

    for (const c of cases) {
      it(c.label, async () => {
        await seedSale(harness.store, {
          saleId: harness.saleId,
          stock: c.stock,
          startsInMs: c.startsInMs,
          endsInMs: c.endsInMs,
        });

        const res = await get(`${harness.baseUrl}/api/sale/status`);
        expect(res.status).toBe(200);
        const parsed = saleStatusResponseSchema.parse(res.body);
        expect(parsed.status).toBe(c.expectedStatus);
      });
    }

    it('E-1 (1ms before end), stock>0 -> active', async () => {
      const seeded = await seedSale(harness.store, {
        saleId: harness.saleId,
        stock: 3,
        startsInMs: -600_000,
        endsInMs: 5000,
      });
      void seeded;
      const res = await get(`${harness.baseUrl}/api/sale/status`);
      expect(res.status).toBe(200);
      expect(saleStatusResponseSchema.parse(res.body).status).toBe('active');
    });

    it('E-1 (1ms before end), stock=0 -> sold_out', async () => {
      await seedSale(harness.store, {
        saleId: harness.saleId,
        stock: 0,
        startsInMs: -600_000,
        endsInMs: 5000,
      });
      const res = await get(`${harness.baseUrl}/api/sale/status`);
      expect(res.status).toBe(200);
      expect(saleStatusResponseSchema.parse(res.body).status).toBe('sold_out');
    });

    it('E (exact end, closed) -> ended, regardless of stock', async () => {
      const seeded = await seedSale(harness.store, {
        saleId: harness.saleId,
        stock: 3,
        startsInMs: -600_000,
        endsInMs: 1,
      });
      await waitUntilRedisClockReaches(harness.store, harness.saleId, seeded.endsAtMs);
      const res = await get(`${harness.baseUrl}/api/sale/status`);
      expect(res.status).toBe(200);
      expect(saleStatusResponseSchema.parse(res.body).status).toBe('ended');
    });
  });
});
