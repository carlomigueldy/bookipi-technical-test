// T8 — Seed idempotency (.claude/contracts/phase-1.md §6.3).
//
// The core hazard this proves closed: two (or fifty) API pods booting concurrently
// must never reset stock mid-sale. `seed.lua`'s gate is `EXISTS config`, so exactly one
// pod writes and every other pod observes ALREADY_SEEDED / CONFIG_DRIFT / STOCK_MISSING
// without touching anything. This is the I1 regression test for the double-boot hazard.
import { afterEach, describe, expect, it } from 'vitest';

import { saleKeys } from '@flash/shared';

import { cleanup, connect, connectMany, uniqueSaleId } from '../test/harness';
import { SaleRedisStore } from './sale-store';
import type { SaleConfigInput } from './types';

describe('SaleRedisStore.seed (T8)', () => {
  let saleId: string;

  afterEach(async () => {
    if (saleId) {
      await cleanup(saleId);
    }
  });

  it('50 concurrent seeds with identical config: exactly 1 SEEDED, 49 ALREADY_SEEDED, stock === totalStock', async () => {
    saleId = uniqueSaleId();
    const now = Date.now();
    const config: SaleConfigInput = {
      saleId,
      name: 'T8 concurrent seed',
      startsAt: new Date(now - 60_000).toISOString(),
      endsAt: new Date(now + 3_600_000).toISOString(),
      totalStock: 250,
    };

    const clients = connectMany(20);
    const stores = clients.map((c) => new SaleRedisStore(c));
    try {
      const results = await Promise.all(
        Array.from({ length: 50 }, (_, i) => stores[i % stores.length]!.seed(config)),
      );

      const seeded = results.filter((r) => r.outcome === 'SEEDED');
      const alreadySeeded = results.filter((r) => r.outcome === 'ALREADY_SEEDED');
      expect(seeded).toHaveLength(1);
      expect(alreadySeeded).toHaveLength(49);
      expect(results.filter((r) => r.outcome !== 'SEEDED' && r.outcome !== 'ALREADY_SEEDED')).toHaveLength(0);

      for (const r of results) {
        expect(r.stockRemaining).toBe(250);
        expect(r.totalStock).toBe(250);
      }

      const stockValue = await clients[0]!.get(saleKeys(saleId).stock);
      expect(stockValue).toBe('250');
    } finally {
      clients.forEach((c) => c.disconnect());
    }
  });

  it('seed -> 3 purchases (stock 497) -> re-seed with the same config: ALREADY_SEEDED, stock still 497', async () => {
    saleId = uniqueSaleId();
    const now = Date.now();
    const config: SaleConfigInput = {
      saleId,
      name: 'T8 re-seed regression',
      startsAt: new Date(now - 60_000).toISOString(),
      endsAt: new Date(now + 3_600_000).toISOString(),
      totalStock: 500,
    };

    const client = connect();
    const store = new SaleRedisStore(client);
    try {
      const seedResult = await store.seed(config);
      expect(seedResult.outcome).toBe('SEEDED');

      for (const userId of ['t8-buyer-1', 't8-buyer-2', 't8-buyer-3']) {
        const purchase = await store.purchase(saleId, userId);
        expect(purchase.outcome).toBe('CONFIRMED');
      }

      const stockAfterPurchases = await client.get(saleKeys(saleId).stock);
      expect(stockAfterPurchases).toBe('497');

      // THE double-boot hazard: a pod restarts and re-runs seed() with the exact same
      // config it started with. Stock must NOT reset to 500.
      const reseed = await store.seed(config);
      expect(reseed.outcome).toBe('ALREADY_SEEDED');
      expect(reseed.stockRemaining).toBe(497);

      const stockAfterReseed = await client.get(saleKeys(saleId).stock);
      expect(stockAfterReseed).toBe('497');
    } finally {
      client.disconnect();
    }
  });

  it('re-seeding with a different totalStock returns CONFIG_DRIFT and leaves stock unchanged', async () => {
    saleId = uniqueSaleId();
    const now = Date.now();
    const config: SaleConfigInput = {
      saleId,
      name: 'T8 drift totalStock',
      startsAt: new Date(now - 60_000).toISOString(),
      endsAt: new Date(now + 3_600_000).toISOString(),
      totalStock: 100,
    };

    const client = connect();
    const store = new SaleRedisStore(client);
    try {
      await store.seed(config);

      const drift = await store.seed({ ...config, totalStock: 999 });
      expect(drift.outcome).toBe('CONFIG_DRIFT');

      const stock = await client.get(saleKeys(saleId).stock);
      expect(stock).toBe('100');
    } finally {
      client.disconnect();
    }
  });

  it('re-seeding with a different endsAt returns CONFIG_DRIFT', async () => {
    saleId = uniqueSaleId();
    const now = Date.now();
    const config: SaleConfigInput = {
      saleId,
      name: 'T8 drift endsAt',
      startsAt: new Date(now - 60_000).toISOString(),
      endsAt: new Date(now + 3_600_000).toISOString(),
      totalStock: 100,
    };

    const client = connect();
    const store = new SaleRedisStore(client);
    try {
      await store.seed(config);

      const drift = await store.seed({ ...config, endsAt: new Date(now + 7_200_000).toISOString() });
      expect(drift.outcome).toBe('CONFIG_DRIFT');
    } finally {
      client.disconnect();
    }
  });

  it('a missing stock key with a present config returns STOCK_MISSING and writes nothing', async () => {
    saleId = uniqueSaleId();
    const now = Date.now();
    const config: SaleConfigInput = {
      saleId,
      name: 'T8 stock missing',
      startsAt: new Date(now - 60_000).toISOString(),
      endsAt: new Date(now + 3_600_000).toISOString(),
      totalStock: 42,
    };

    const client = connect();
    const store = new SaleRedisStore(client);
    try {
      await store.seed(config);
      // Simulate an evicted / deleted stock key with the config hash still present.
      await client.del(saleKeys(saleId).stock);

      const result = await store.seed(config);
      expect(result.outcome).toBe('STOCK_MISSING');

      const exists = await client.exists(saleKeys(saleId).stock);
      expect(exists).toBe(0);
    } finally {
      client.disconnect();
    }
  });

  it('throws RangeError for an unparseable ISO timestamp, without touching Redis', async () => {
    const client = connect();
    const store = new SaleRedisStore(client);
    const badSaleId = uniqueSaleId();
    try {
      await expect(
        store.seed({
          saleId: badSaleId,
          name: 'T8 bad iso',
          startsAt: 'not-a-date',
          endsAt: new Date(Date.now() + 3_600_000).toISOString(),
          totalStock: 10,
        }),
      ).rejects.toThrow(RangeError);

      const exists = await client.exists(saleKeys(badSaleId).config);
      expect(exists).toBe(0);
    } finally {
      client.disconnect();
    }
  });

  it('throws RangeError when endsAt <= startsAt, without touching Redis', async () => {
    const client = connect();
    const store = new SaleRedisStore(client);
    const badSaleId = uniqueSaleId();
    const now = Date.now();
    try {
      await expect(
        store.seed({
          saleId: badSaleId,
          name: 'T8 inverted window',
          startsAt: new Date(now).toISOString(),
          endsAt: new Date(now - 1000).toISOString(),
          totalStock: 10,
        }),
      ).rejects.toThrow(RangeError);

      const exists = await client.exists(saleKeys(badSaleId).config);
      expect(exists).toBe(0);
    } finally {
      client.disconnect();
    }
  });
});
