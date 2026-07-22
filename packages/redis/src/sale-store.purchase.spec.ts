// T3 (I2 duplicate storm) and T9 (fail-closed on an uninitialized sale), per
// .claude/contracts/phase-1.md §6.3.
import { afterEach, describe, expect, it } from 'vitest';

import { saleKeys } from '@flash/shared';

import { cleanup, connect, connectMany, seedActiveSale, uniqueSaleId } from '../test/harness';
import { SaleRedisStore } from './sale-store';

describe('SaleRedisStore.purchase', () => {
  let saleId: string | undefined;

  afterEach(async () => {
    if (saleId) {
      await cleanup(saleId);
      saleId = undefined;
    }
  });

  it('T3 — one userId, 200 concurrent attempts: exactly 1 CONFIRMED, 199 ALREADY_PURCHASED', async () => {
    const client = connect();
    const store = new SaleRedisStore(client);
    saleId = await seedActiveSale(store, { stock: 100 });

    const clients = connectMany(20);
    const stores = clients.map((c) => new SaleRedisStore(c));
    const userId = 't3-single-buyer';

    try {
      const results = await Promise.all(
        Array.from({ length: 200 }, (_, i) => stores[i % stores.length]!.purchase(saleId!, userId)),
      );

      const confirmed = results.filter((r) => r.outcome === 'CONFIRMED');
      const alreadyPurchased = results.filter((r) => r.outcome === 'ALREADY_PURCHASED');
      expect(confirmed).toHaveLength(1);
      expect(alreadyPurchased).toHaveLength(199);
      expect(results).toHaveLength(200);

      const stock = await client.get(saleKeys(saleId).stock);
      expect(stock).toBe('99');

      const buyersCount = await client.scard(saleKeys(saleId).buyers);
      expect(buyersCount).toBe(1);
    } finally {
      clients.forEach((c) => c.disconnect());
      client.disconnect();
    }
  });

  it('T9 — purchase() against a never-seeded sale returns NOT_INITIALIZED, stockRemaining -1, never SOLD_OUT', async () => {
    const client = connect();
    const store = new SaleRedisStore(client);
    const neverSeededSaleId = uniqueSaleId();

    try {
      const result = await store.purchase(neverSeededSaleId, 't9-buyer');
      expect(result.outcome).toBe('NOT_INITIALIZED');
      expect(result.outcome).not.toBe('SOLD_OUT');
      expect(result.stockRemaining).toBe(-1);
    } finally {
      client.disconnect();
    }
  });

  it('repairs ledger-only drift and rejects all 200 concurrent duplicate attempts without decrementing stock', async () => {
    const client = connect();
    const store = new SaleRedisStore(client);
    saleId = await seedActiveSale(store, { stock: 100 });
    const keys = saleKeys(saleId);
    const userId = 'ledger-only-duplicate';

    const original = await store.purchase(saleId, userId);
    expect(original.outcome).toBe('CONFIRMED');
    expect(original.reservationId).not.toBeNull();
    const ledgerValue = await client.hget(keys.reservations, userId);
    await client.srem(keys.buyers, userId);

    const clients = connectMany(20);
    const stores = clients.map((redis) => new SaleRedisStore(redis));
    try {
      const results = await Promise.all(
        Array.from({ length: 200 }, (_, index) =>
          stores[index % stores.length]!.purchase(saleId!, userId),
        ),
      );

      expect(results.every((result) => result.outcome === 'ALREADY_PURCHASED')).toBe(true);
      expect(await client.get(keys.stock)).toBe('99');
      expect(await client.sismember(keys.buyers, userId)).toBe(1);
      expect(await client.hget(keys.reservations, userId)).toBe(ledgerValue);
    } finally {
      clients.forEach((redis) => redis.disconnect());
      client.disconnect();
    }
  });
});
