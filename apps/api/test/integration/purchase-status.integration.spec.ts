// apps/api/test/integration/purchase-status.integration.spec.ts  [SLICE E]
// GET /api/purchase/:userId — contract §6.5, §8.2, §11.2.
import { purchaseStatusResponseSchema } from '@flash/shared/schemas';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type AppHarness, bootHarness } from '../support/app-harness.js';
import { get, post } from '../support/http.js';
import { seedSale } from '../support/seed.js';

interface ApiErrorBody {
  error: string;
}

describe('GET /api/purchase/:userId', () => {
  let harness: AppHarness;

  beforeEach(async () => {
    harness = await bootHarness();
  });

  afterEach(async () => {
    await harness.close();
  });

  it('reserved-only (Redis, no PG row yet) -> purchased:true, order.status:"reserved", createdAt:null', async () => {
    await seedSale(harness.store, { saleId: harness.saleId, stock: 5 });
    const purchaseRes = await post(`${harness.baseUrl}/api/purchase`, {
      body: { userId: 'reserved-only-2026' },
    });
    expect(purchaseRes.status).toBe(201);

    // Give BullMQ's producer-only enqueue a moment, but do NOT wait for a worker to
    // drain it into Postgres — there is no worker in Phase 2 (contract §0.1); the
    // "reserved" state IS the expected steady state here.
    const res = await get(`${harness.baseUrl}/api/purchase/reserved-only-2026`);

    expect(res.status).toBe(200);
    const parsed = purchaseStatusResponseSchema.parse(res.body);
    expect(parsed.purchased).toBe(true);
    expect(parsed.order?.status).toBe('reserved');
    expect(parsed.order?.createdAt).toBeNull();
  });

  it('PG row persisted -> purchased:true, order.status:"persisted", real createdAt', async () => {
    await seedSale(harness.store, { saleId: harness.saleId, stock: 5 });
    await harness.pool.query(
      `INSERT INTO sales (id, name, total_stock, starts_at, ends_at)
       VALUES ($1, 'test', 5, now() - interval '1 hour', now() + interval '1 hour')
       ON CONFLICT (id) DO NOTHING`,
      [harness.saleId],
    );
    await harness.pool.query(
      `INSERT INTO orders (user_id, sale_id, status, persisted_at) VALUES ($1, $2, 'persisted', now())`,
      ['persisted-2026', harness.saleId],
    );

    const res = await get(`${harness.baseUrl}/api/purchase/persisted-2026`);

    expect(res.status).toBe(200);
    const parsed = purchaseStatusResponseSchema.parse(res.body);
    expect(parsed.purchased).toBe(true);
    expect(parsed.order?.status).toBe('persisted');
    expect(parsed.order?.createdAt).not.toBeNull();
  });

  it('PG row compensated -> purchased:FALSE (never true), order still describes why', async () => {
    await seedSale(harness.store, { saleId: harness.saleId, stock: 5 });
    await harness.pool.query(
      `INSERT INTO sales (id, name, total_stock, starts_at, ends_at)
       VALUES ($1, 'test', 5, now() - interval '1 hour', now() + interval '1 hour')
       ON CONFLICT (id) DO NOTHING`,
      [harness.saleId],
    );
    await harness.pool.query(
      `INSERT INTO orders (user_id, sale_id, status) VALUES ($1, $2, 'compensated')`,
      ['compensated-2026', harness.saleId],
    );

    const res = await get(`${harness.baseUrl}/api/purchase/compensated-2026`);

    expect(res.status).toBe(200);
    const parsed = purchaseStatusResponseSchema.parse(res.body);
    expect(parsed.purchased).toBe(false);
    expect(parsed.order?.status).toBe('compensated');
  });

  it('unknown user -> purchased:false, order:null', async () => {
    await seedSale(harness.store, { saleId: harness.saleId, stock: 5 });

    const res = await get(`${harness.baseUrl}/api/purchase/nobody-at-all-2026`);

    expect(res.status).toBe(200);
    const parsed = purchaseStatusResponseSchema.parse(res.body);
    expect(parsed.purchased).toBe(false);
    expect(parsed.order).toBeNull();
  });

  it('invalid param -> 422', async () => {
    const res = await get<ApiErrorBody>(`${harness.baseUrl}/api/purchase/x`); // below USER_ID_MIN_LENGTH
    expect(res.status).toBe(422);
  });

  it('PG pool stopped -> still 200 from the Redis fallback, never 503', async () => {
    await seedSale(harness.store, { saleId: harness.saleId, stock: 5 });
    const purchaseRes = await post(`${harness.baseUrl}/api/purchase`, {
      body: { userId: 'pg-down-2026' },
    });
    expect(purchaseRes.status).toBe(201);

    // Simulate a PG outage from the app's point of view without tearing down the
    // shared container: point the harness's OWN assertion pool is irrelevant here —
    // what matters is the app's injected PG_POOL. We end the app's pool via its own
    // DI-resolved instance so the app genuinely observes the outage.
    const { PG_POOL } =
      (await import('../../src/common/tokens.js')) as typeof import('../../src/common/tokens.js');
    const appPool = harness.get<import('pg').Pool>(PG_POOL);
    const endSpy = vi.spyOn(appPool, 'end');
    await appPool.end();

    const res = await get(`${harness.baseUrl}/api/purchase/pg-down-2026`);

    expect(res.status).toBe(200);
    const parsed = purchaseStatusResponseSchema.parse(res.body);
    expect(parsed.purchased).toBe(true);
    expect(parsed.order?.status).toBe('reserved');

    await harness.app.close();
    await harness.app.close();
    expect(endSpy).toHaveBeenCalledTimes(1);
  });
});
