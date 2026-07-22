// Post-freeze regression spec for finding 2 of the Phase 1 review
// (.claude/contracts/phase-1.md §11.2, CRITICAL, I1/I4): `seed()`'s only gate is
// `EXISTS config`, so warm recovery (config survives an AOF `everysec` partial replay,
// stock/buyers do not) is unimplementable with `seed()` alone — it reads
// ALREADY_SEEDED and writes nothing, silently leaving Redis oversold and I2's guard
// short some buyers. This file proves the two primitives added to close that gap:
//   - `reconcileStock` — the explicit-intent stock correction `seed()` refuses to do.
//   - `scanReservations` / `restoreReservations` — cursor-paged (HSCAN) enumeration
//     and chunked, pipelined restoration of the reservations ledger, so a cold rebuild
//     can restore the I2 guard (not just the stock counter) without ever calling the
//     banned SMEMBERS/HGETALL.
import { afterEach, describe, expect, it } from 'vitest';

import { saleKeys } from '@flash/shared';

import { cleanup, connect, seedActiveSale, uniqueSaleId } from '../test/harness';
import { SaleRedisStore } from './sale-store';

describe('SaleRedisStore.reconcileStock — the warm-recovery primitive seed() cannot provide', () => {
  let saleId: string | undefined;

  afterEach(async () => {
    if (saleId) {
      await cleanup(saleId);
      saleId = undefined;
    }
  });

  it('returns NOT_INITIALIZED for a never-seeded sale and touches nothing', async () => {
    const client = connect();
    const store = new SaleRedisStore(client);
    const neverSeeded = uniqueSaleId();

    try {
      const result = await store.reconcileStock(neverSeeded, 42);
      expect(result.outcome).toBe('NOT_INITIALIZED');
      expect(result.previousStock).toBe(-1);
      expect(await client.exists(saleKeys(neverSeeded).stock)).toBe(0);
    } finally {
      client.disconnect();
    }
  });

  it(
    'FINDING 2 REGRESSION — reproduces the warm-restart drift scenario: seed() cannot correct it, ' +
      'reconcileStock() can',
    async () => {
      const client = connect();
      const store = new SaleRedisStore(client);
      saleId = await seedActiveSale(store, { stock: 500 });
      const keys = saleKeys(saleId);

      try {
        // 300 units sell during the sale (stock: 500 -> 200).
        for (let i = 0; i < 300; i += 1) {
          const result = await store.purchase(saleId, `reconcile-buyer-${i}`);
          expect(result.outcome).toBe('CONFIRMED');
        }
        expect(await client.get(keys.stock)).toBe('200');

        // Simulate the AOF `everysec` partial-loss window: Redis restarts and replays
        // ~1s less than what actually happened. Config survives (rarely mutated);
        // stock replays 10 units "too high" (210 instead of 200) because the last 10
        // DECRs never made it into the AOF segment that got replayed. The `EXISTS
        // config` state is now: config unchanged, stock wrong. T8
        // (sale-store.seed.spec.ts) already proves `seed()` with the identical config
        // in this exact state returns ALREADY_SEEDED / CONFIG_DRIFT and writes nothing
        // — the recovery lever PRD §3.5 names for this case is a no-op here by
        // construction. This test proves the primitive that closes the gap.
        await client.set(keys.stock, '210');

        // reconcileStock(), called by Phase 3's boot reconciliation with the
        // authoritative value derived from Postgres (totalStock - persistedOrders =
        // 500 - 300 = 200), IS able to correct it.
        const reconciled = await store.reconcileStock(saleId, 200);
        expect(reconciled.outcome).toBe('RECONCILED');
        expect(reconciled.previousStock).toBe(210);
        expect(reconciled.newStock).toBe(200);
        expect(await client.get(keys.stock)).toBe('200');
      } finally {
        client.disconnect();
      }
    },
  );

  it('never creates a sale even if called against an id nothing has ever seeded, regardless of value', async () => {
    const client = connect();
    const store = new SaleRedisStore(client);
    const neverSeeded = uniqueSaleId();

    try {
      await store.reconcileStock(neverSeeded, 0);
      const exists = await client.exists(saleKeys(neverSeeded).config);
      expect(exists).toBe(0);
    } finally {
      client.disconnect();
    }
  });
});

describe('SaleRedisStore.scanReservations / restoreReservations — the I4 boot-sweep primitives', () => {
  let saleId: string | undefined;

  afterEach(async () => {
    if (saleId) {
      await cleanup(saleId);
      saleId = undefined;
    }
  });

  it('scanReservations (HSCAN) enumerates every reservation across cursor pages, matching the buyers set exactly', async () => {
    const client = connect();
    const store = new SaleRedisStore(client);
    saleId = await seedActiveSale(store, { stock: 60 });
    const keys = saleKeys(saleId);

    const purchases = await Promise.all(
      Array.from({ length: 50 }, (_, i) => store.purchase(saleId!, `scan-buyer-${i}`)),
    );
    const confirmedUserIds = new Set(
      purchases.filter((r) => r.outcome === 'CONFIRMED').map((_r, i) => `scan-buyer-${i}`),
    );
    expect(confirmedUserIds.size).toBe(50);

    try {
      // Page through with a small COUNT to force multiple round trips.
      let cursor = '0';
      const seen = new Map<string, string>();
      do {
        const page = await store.scanReservations(saleId, cursor, 7);
        for (const entry of page.entries) {
          seen.set(entry.userId, entry.reservationId);
          expect(entry.reservedAtMs).not.toBeNull();
          expect(entry.reservedAtMs).toBeGreaterThan(0);
        }
        cursor = page.cursor;
      } while (cursor !== '0');

      expect(new Set(seen.keys())).toEqual(confirmedUserIds);
      // Every scanned reservationId is non-empty and distinct.
      const ids = [...seen.values()];
      expect(new Set(ids).size).toBe(ids.length);

      const buyerMembers = await client.smembers(keys.buyers);
      expect(new Set(buyerMembers)).toEqual(confirmedUserIds);
    } finally {
      client.disconnect();
    }
  });

  it(
    'restoreReservations rebuilds both the buyers Set (I2 guard) and the reservations ledger (I4 ' +
      'compensation identity) after a simulated cold-data-loss reset() — the sweep scenario PRD §3.5 requires',
    async () => {
      const client = connect();
      const store = new SaleRedisStore(client);
      saleId = await seedActiveSale(store, { stock: 20 });
      const keys = saleKeys(saleId);

      try {
        const originalPurchase = await store.purchase(saleId, 'sweep-buyer-1');
        expect(originalPurchase.outcome).toBe('CONFIRMED');
        const originalReservationId = originalPurchase.reservationId!;

        // Simulate an API pod dying post-Lua/pre-enqueue on a DIFFERENT purchase, whose
        // durable write never happened, but whose Redis-side reservation is exactly the
        // kind of record Phase 3's sweep needs to find and re-enqueue. We simulate data
        // loss by wiping the buyers Set + reservations hash directly (as a crashed pod
        // or an unreplicated AOF segment would), leaving Postgres as the only truth —
        // Postgres in this test is stood in for by a hand-built snapshot.
        await client.del(keys.buyers, keys.reservations);
        expect(await client.scard(keys.buyers)).toBe(0);

        // The "Postgres truth" a real Phase 3 sweep would read: one persisted order for
        // sweep-buyer-1, keeping its original reservationId for correlation.
        await store.restoreReservations(saleId, [
          { userId: 'sweep-buyer-1', reservationId: originalReservationId, reservedAtMs: Date.now() - 5000 },
        ]);

        // I2 restored: the buyer is a Set member again, so a duplicate purchase is
        // correctly rejected.
        expect(await client.sismember(keys.buyers, 'sweep-buyer-1')).toBe(1);
        const duplicate = await store.purchase(saleId, 'sweep-buyer-1');
        expect(duplicate.outcome).toBe('ALREADY_PURCHASED');

        // I4 restored: the reservation ledger entry is back, so compensation still
        // works with the ORIGINAL reservationId (the identity Phase 3's DLQ job would
        // have been carrying all along).
        const page = await store.scanReservations(saleId);
        expect(page.entries).toHaveLength(1);
        expect(page.entries[0]).toMatchObject({
          userId: 'sweep-buyer-1',
          reservationId: originalReservationId,
        });

        const compensated = await store.compensate(saleId, 'sweep-buyer-1', originalReservationId);
        expect(compensated.outcome).toBe('COMPENSATED');
        expect(await client.sismember(keys.buyers, 'sweep-buyer-1')).toBe(0);
      } finally {
        client.disconnect();
      }
    },
  );

  it('restoreReservations is a no-op for an empty snapshot', async () => {
    const client = connect();
    const store = new SaleRedisStore(client);
    saleId = await seedActiveSale(store, { stock: 5 });
    const keys = saleKeys(saleId);

    try {
      await store.restoreReservations(saleId, []);
      expect(await client.scard(keys.buyers)).toBe(0);
      expect(await client.hlen(keys.reservations)).toBe(0);
    } finally {
      client.disconnect();
    }
  });
});
