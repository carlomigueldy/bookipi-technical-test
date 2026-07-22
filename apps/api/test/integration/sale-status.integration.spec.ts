// apps/api/test/integration/sale-status.integration.spec.ts  [SLICE E]
// GET /api/sale/status — contract §6.1, §6.2 (the sentinel fix), §11.2.
import { saleKeys } from '@flash/shared';
import { saleStatusResponseSchema } from '@flash/shared/schemas';
import Redis from 'ioredis';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { type AppHarness, bootHarness } from '../support/app-harness.js';
import { get } from '../support/http.js';
import { redisNowMs, seedSale, uniqueSaleId } from '../support/seed.js';

interface ApiErrorBody {
  error: string;
  message: string;
  requestId: string;
  serverTime: string;
  serverTimeMs: number;
}

describe('GET /api/sale/status', () => {
  let harness: AppHarness;

  beforeEach(async () => {
    harness = await bootHarness();
  });

  afterEach(async () => {
    await harness.close();
  });

  it('200s with a body that parses against saleStatusResponseSchema, live not cached', async () => {
    const seeded = await seedSale(harness.store, { saleId: harness.saleId, stock: 7 });

    const res = await get(`${harness.baseUrl}/api/sale/status`);

    expect(res.status).toBe(200);
    const parsed = saleStatusResponseSchema.parse(res.body);
    expect(parsed.saleId).toBe(seeded.saleId);
    expect(parsed.stockRemaining).toBe(7);
    expect(parsed.totalStock).toBe(7);
    expect(parsed.status).toBe('active');
  });

  it('serverTimeMs matches Redis TIME within 0ms of a same-instant status() call', async () => {
    await seedSale(harness.store, { saleId: harness.saleId, stock: 3 });

    const before = await redisNowMs(harness.store, harness.saleId);
    const res = await get(`${harness.baseUrl}/api/sale/status`);
    const after = await redisNowMs(harness.store, harness.saleId);

    expect(res.status).toBe(200);
    const parsed = saleStatusResponseSchema.parse(res.body);
    // The response's serverTimeMs must be a live Redis TIME reading taken during this
    // request, i.e. bounded by two independent status() calls made immediately before
    // and after it — never a cached or stale value.
    expect(parsed.serverTimeMs).toBeGreaterThanOrEqual(before);
    expect(parsed.serverTimeMs).toBeLessThanOrEqual(after);
  });

  it('§6.2 sentinel: config present, stock key DELeted -> 503 NOT_INITIALIZED, never 200 stockRemaining:0', async () => {
    await seedSale(harness.store, { saleId: harness.saleId, stock: 5 });
    const keys = saleKeys(harness.saleId);

    // Simulate the partial-AOF-replay case Phase 1's finding 2 identified: the config
    // hash survives, the stock key does not. A fresh connection, not the app's own
    // REDIS_STORE_CLIENT, does the DEL — this is a test-side fault injection, not
    // something the API itself would ever do.
    const raw = new Redis(harness.redisUrl);
    try {
      await raw.del(keys.stock);
    } finally {
      raw.disconnect();
    }

    const res = await get<ApiErrorBody>(`${harness.baseUrl}/api/sale/status`);

    expect(res.status).toBe(503);
    expect(res.body.error).toBe('NOT_INITIALIZED');
    // Must never be the alternative the contract explicitly rejects.
    expect(res.status).not.toBe(200);
  });

  it('never-seeded sale -> 503 NOT_INITIALIZED', async () => {
    const freshSaleId = uniqueSaleId();
    // Boot a harness pinned to a saleId nobody has seeded.
    const fresh = await bootHarness({ env: { SALE_ID: freshSaleId } });
    try {
      const res = await get<ApiErrorBody>(`${fresh.baseUrl}/api/sale/status`);
      expect(res.status).toBe(503);
      expect(res.body.error).toBe('NOT_INITIALIZED');
      expect(Object.keys(res.body).sort()).toEqual(
        ['error', 'message', 'requestId', 'serverTime', 'serverTimeMs'].sort(),
      );
    } finally {
      await fresh.close();
    }
  });

  it('sold_out at stock 0 within an open window', async () => {
    await seedSale(harness.store, { saleId: harness.saleId, stock: 0 });
    const res = await get(`${harness.baseUrl}/api/sale/status`);
    expect(res.status).toBe(200);
    const parsed = saleStatusResponseSchema.parse(res.body);
    expect(parsed.status).toBe('sold_out');
    expect(parsed.stockRemaining).toBe(0);
  });
});
