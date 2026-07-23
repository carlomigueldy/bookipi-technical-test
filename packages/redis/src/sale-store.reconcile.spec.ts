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
import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';

import { saleKeys } from '@flash/shared';

import { cleanup, connect, connectMany, seedActiveSale, uniqueSaleId } from '../test/harness';
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
          {
            userId: 'sweep-buyer-1',
            reservationId: originalReservationId,
            reservedAtMs: Date.now() - 5000,
          },
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

describe('Phase 3 Redis reconciliation primitives', () => {
  let saleId: string | undefined;

  afterEach(async () => {
    if (saleId) {
      await cleanup(saleId);
      saleId = undefined;
    }
  });

  it('getReservation performs targeted lookup and shares strict ledger parsing with scanReservations', async () => {
    const client = connect();
    const store = new SaleRedisStore(client);
    saleId = await seedActiveSale(store, { stock: 5 });
    const keys = saleKeys(saleId);

    try {
      const purchase = await store.purchase(saleId, 'targeted-buyer');
      const reservation = await store.getReservation(saleId, 'targeted-buyer');
      expect(reservation).toMatchObject({
        userId: 'targeted-buyer',
        reservationId: purchase.reservationId,
      });
      expect(reservation?.reservedAtMs).toBeGreaterThan(0);
      expect(await store.getReservation(saleId, 'missing-buyer')).toBeNull();

      await client.hset(keys.reservations, 'malformed-buyer', 'not-a-reservation');
      await expect(store.getReservation(saleId, 'malformed-buyer')).rejects.toThrow(
        'malformed reservation ledger value',
      );
      await expect(store.scanReservations(saleId)).rejects.toThrow(
        'malformed reservation ledger value',
      );
    } finally {
      client.disconnect();
    }
  });

  it('scanBuyers enumerates a Set through bounded SSCAN pages', async () => {
    const client = connect();
    const store = new SaleRedisStore(client);
    saleId = await seedActiveSale(store, { stock: 600 });

    try {
      await Promise.all(
        Array.from({ length: 600 }, (_, index) => store.purchase(saleId!, `paged-buyer-${index}`)),
      );

      let cursor = '0';
      const seen = new Set<string>();
      let pages = 0;
      do {
        const page = await store.scanBuyers(saleId, cursor, 5);
        page.userIds.forEach((userId) => seen.add(userId));
        cursor = page.cursor;
        pages += 1;
      } while (cursor !== '0');

      expect(seen.size).toBe(600);
      expect(pages).toBeGreaterThan(1);
    } finally {
      client.disconnect();
    }
  });

  it('reconcileBuyerMembership restores ledger-backed buyers and removes only ledger-absent buyers', async () => {
    const client = connect();
    const store = new SaleRedisStore(client);
    saleId = await seedActiveSale(store, { stock: 5 });
    const keys = saleKeys(saleId);

    try {
      const purchase = await store.purchase(saleId, 'present-buyer');
      expect(purchase.outcome).toBe('CONFIRMED');
      await client.srem(keys.buyers, 'present-buyer');
      await client.sadd(keys.buyers, 'stale-buyer');

      expect(await store.reconcileBuyerMembership(saleId, 'present-buyer')).toBe('PRESENT');
      expect(await client.sismember(keys.buyers, 'present-buyer')).toBe(1);
      expect(await store.reconcileBuyerMembership(saleId, 'stale-buyer')).toBe('ABSENT');
      expect(await client.sismember(keys.buyers, 'stale-buyer')).toBe(0);
    } finally {
      client.disconnect();
    }
  });

  it('membership reconciliation cannot remove a concurrently-created live reservation', async () => {
    const reconcileClient = connect();
    const purchaseClient = connect();
    const reconcileStore = new SaleRedisStore(reconcileClient);
    const purchaseStore = new SaleRedisStore(purchaseClient);
    saleId = await seedActiveSale(reconcileStore, { stock: 200 });
    const keys = saleKeys(saleId);

    try {
      for (let index = 0; index < 100; index += 1) {
        const userId = `membership-race-${index}`;
        const [, purchase] = await Promise.all([
          reconcileStore.reconcileBuyerMembership(saleId, userId),
          purchaseStore.purchase(saleId, userId),
        ]);
        expect(purchase.outcome).toBe('CONFIRMED');
        expect(await reconcileClient.hexists(keys.reservations, userId)).toBe(1);
        expect(await reconcileClient.sismember(keys.buyers, userId)).toBe(1);
      }
    } finally {
      reconcileClient.disconnect();
      purchaseClient.disconnect();
    }
  });

  it('atomically reconciles stock to totalStock minus the reservations ledger', async () => {
    const client = connect();
    const store = new SaleRedisStore(client);
    saleId = await seedActiveSale(store, { stock: 10 });
    const keys = saleKeys(saleId);

    try {
      await store.purchase(saleId, 'stock-ledger-1');
      await store.purchase(saleId, 'stock-ledger-2');
      await client.set(keys.stock, '99');

      const result = await store.reconcileStockFromReservations(saleId);
      expect(result).toEqual({
        outcome: 'RECONCILED',
        previousStock: 99,
        newStock: 8,
        reservationCount: 2,
        totalStock: 10,
      });
      expect(await client.get(keys.stock)).toBe('8');
    } finally {
      client.disconnect();
    }
  });

  it('serializes stock reconciliation with purchases on either side without losing a decrement', async () => {
    const reconcileClient = connect();
    const purchaseClient = connect();
    const reconcileStore = new SaleRedisStore(reconcileClient);
    const purchaseStore = new SaleRedisStore(purchaseClient);
    saleId = await seedActiveSale(reconcileStore, { stock: 150 });
    const keys = saleKeys(saleId);

    try {
      for (let index = 0; index < 100; index += 1) {
        await reconcileClient.set(keys.stock, '149');
        const [, purchase] = await Promise.all([
          reconcileStore.reconcileStockFromReservations(saleId),
          purchaseStore.purchase(saleId, `stock-race-${index}`),
        ]);
        expect(purchase.outcome).toBe('CONFIRMED');
        const reservationCount = await reconcileClient.hlen(keys.reservations);
        expect(Number(await reconcileClient.get(keys.stock))).toBe(150 - reservationCount);
      }
    } finally {
      reconcileClient.disconnect();
      purchaseClient.disconnect();
    }
  });

  it('fails closed when uninitialized or overcommitted and never clamps/writes stock', async () => {
    const client = connect();
    const store = new SaleRedisStore(client);
    const neverSeeded = uniqueSaleId();

    try {
      expect(await store.reconcileStockFromReservations(neverSeeded)).toEqual({
        outcome: 'NOT_INITIALIZED',
        previousStock: -1,
        newStock: -1,
        reservationCount: 0,
        totalStock: -1,
      });

      saleId = await seedActiveSale(store, { stock: 1 });
      const keys = saleKeys(saleId);
      await client.hset(
        keys.reservations,
        'overcommitted-1',
        `${randomUUID()}:${Date.now()}`,
        'overcommitted-2',
        `${randomUUID()}:${Date.now()}`,
      );
      await client.set(keys.stock, '7');

      expect(await store.reconcileStockFromReservations(saleId)).toEqual({
        outcome: 'OVERCOMMITTED',
        previousStock: 7,
        newStock: 7,
        reservationCount: 2,
        totalStock: 1,
      });
      expect(await client.get(keys.stock)).toBe('7');
    } finally {
      client.disconnect();
    }
  });
});

describe('SaleRedisStore.compareAndRestoreReservation — Phase 3 A2 identity CAS', () => {
  let saleId: string | undefined;

  afterEach(async () => {
    if (saleId) {
      await cleanup(saleId);
      saleId = undefined;
    }
  });

  it('RESTORED writes the missing ledger identity before restoring buyer membership', async () => {
    const client = connect();
    const store = new SaleRedisStore(client);
    saleId = await seedActiveSale(store, { stock: 10 });
    const keys = saleKeys(saleId);
    const input = {
      userId: 'cas-restored-buyer',
      reservationId: randomUUID(),
      reservedAtMs: 1_700_000_000_001,
    };

    try {
      expect(await store.compareAndRestoreReservation(saleId, input)).toEqual({
        outcome: 'RESTORED',
        current: input,
      });
      expect(await client.hget(keys.reservations, input.userId)).toBe(
        `${input.reservationId}:${input.reservedAtMs}`,
      );
      expect(await client.sismember(keys.buyers, input.userId)).toBe(1);
    } finally {
      client.disconnect();
    }
  });

  it('ALREADY_MATCHED repairs membership while preserving the original reservedAtMs', async () => {
    const client = connect();
    const store = new SaleRedisStore(client);
    saleId = await seedActiveSale(store, { stock: 10 });
    const keys = saleKeys(saleId);
    const reservationId = randomUUID();
    const originalReservedAtMs = 1_700_000_000_002;
    await client.hset(
      keys.reservations,
      'cas-matched-buyer',
      `${reservationId}:${originalReservedAtMs}`,
    );

    try {
      expect(
        await store.compareAndRestoreReservation(saleId, {
          userId: 'cas-matched-buyer',
          reservationId,
          reservedAtMs: originalReservedAtMs + 999,
        }),
      ).toEqual({
        outcome: 'ALREADY_MATCHED',
        current: {
          userId: 'cas-matched-buyer',
          reservationId,
          reservedAtMs: originalReservedAtMs,
        },
      });
      expect(await client.hget(keys.reservations, 'cas-matched-buyer')).toBe(
        `${reservationId}:${originalReservedAtMs}`,
      );
      expect(await client.sismember(keys.buyers, 'cas-matched-buyer')).toBe(1);
    } finally {
      client.disconnect();
    }
  });

  it('CONFLICT performs zero writes for a different live identity', async () => {
    const client = connect();
    const store = new SaleRedisStore(client);
    saleId = await seedActiveSale(store, { stock: 10 });
    const keys = saleKeys(saleId);
    const userId = 'cas-conflict-buyer';
    const liveReservationId = randomUUID();
    const liveValue = `${liveReservationId}:1700000000003`;
    await client.hset(keys.reservations, userId, liveValue);

    try {
      expect(
        await store.compareAndRestoreReservation(saleId, {
          userId,
          reservationId: randomUUID(),
          reservedAtMs: 1_700_000_000_004,
        }),
      ).toEqual({
        outcome: 'CONFLICT',
        current: {
          userId,
          reservationId: liveReservationId,
          reservedAtMs: 1_700_000_000_003,
        },
      });
      expect(await client.hget(keys.reservations, userId)).toBe(liveValue);
      expect(await client.sismember(keys.buyers, userId)).toBe(0);
    } finally {
      client.disconnect();
    }
  });

  it('200 concurrent stale R1 restore attempts cannot alter live R2 byte-for-byte', async () => {
    const client = connect();
    const store = new SaleRedisStore(client);
    saleId = await seedActiveSale(store, { stock: 10 });
    const keys = saleKeys(saleId);
    const userId = 'cas-stale-r1-buyer';
    const liveR2 = await store.purchase(saleId, userId);
    expect(liveR2.outcome).toBe('CONFIRMED');
    const liveValue = await client.hget(keys.reservations, userId);
    const stockBefore = await client.get(keys.stock);
    const staleR1 = randomUUID();

    const clients = connectMany(20);
    const stores = clients.map((redis) => new SaleRedisStore(redis));
    try {
      const results = await Promise.all(
        Array.from({ length: 200 }, (_, index) =>
          stores[index % stores.length]!.compareAndRestoreReservation(saleId!, {
            userId,
            reservationId: staleR1,
            reservedAtMs: 1_600_000_000_000 + index,
          }),
        ),
      );

      expect(results.every((result) => result.outcome === 'CONFLICT')).toBe(true);
      expect(
        results.every((result) => result.current?.reservationId === liveR2.reservationId),
      ).toBe(true);
      expect(await client.hget(keys.reservations, userId)).toBe(liveValue);
      expect(await client.sismember(keys.buyers, userId)).toBe(1);
      expect(await client.get(keys.stock)).toBe(stockBefore);
    } finally {
      clients.forEach((redis) => redis.disconnect());
      client.disconnect();
    }
  });

  it('200 concurrent CAS-versus-purchase races serialize to one identity without stock inflation or loss', async () => {
    const observer = connect();
    const observerStore = new SaleRedisStore(observer);
    const raceClients = connectMany(40);
    const stores = raceClients.map((redis) => new SaleRedisStore(redis));
    saleId = await seedActiveSale(stores[0]!, { stock: 200 });
    const keys = saleKeys(saleId);
    const candidateIds = new Map<string, string>();

    try {
      const races = await Promise.all(
        Array.from({ length: 200 }, async (_, index) => {
          const userId = `cas-purchase-race-${index}`;
          const candidateId = randomUUID();
          candidateIds.set(userId, candidateId);
          const casStore = stores[index % 20]!;
          const purchaseStore = stores[20 + (index % 20)]!;
          const casPromise = casStore.compareAndRestoreReservation(saleId!, {
            userId,
            reservationId: candidateId,
            reservedAtMs: 1_700_000_100_000 + index,
          });
          const purchasePromise = purchaseStore.purchase(saleId!, userId);
          const [cas, purchase] = await Promise.all([casPromise, purchasePromise]);
          return { userId, cas, purchase };
        }),
      );

      const confirmed = races.filter(({ purchase }) => purchase.outcome === 'CONFIRMED').length;
      expect(Number(await observer.get(keys.stock))).toBe(200 - confirmed);
      expect(await observer.hlen(keys.reservations)).toBe(200);
      expect(await observer.scard(keys.buyers)).toBe(200);

      for (const { userId, cas, purchase } of races) {
        const stored = await observerStore.getReservation(saleId, userId);
        expect(stored).not.toBeNull();
        if (purchase.outcome === 'CONFIRMED') {
          expect(cas.outcome).toBe('CONFLICT');
          expect(stored?.reservationId).toBe(purchase.reservationId);
        } else {
          expect(purchase.outcome).toBe('ALREADY_PURCHASED');
          expect(cas.outcome).toBe('RESTORED');
          expect(stored?.reservationId).toBe(candidateIds.get(userId));
        }
      }
    } finally {
      raceClients.forEach((redis) => redis.disconnect());
      observer.disconnect();
    }
  });

  it.each([
    { userId: ' x ', reservationId: randomUUID(), reservedAtMs: 1 },
    { userId: 'valid-user', reservationId: 'not-a-uuid', reservedAtMs: 1 },
    { userId: 'valid-user', reservationId: randomUUID(), reservedAtMs: -1 },
    { userId: 'valid-user', reservationId: randomUUID(), reservedAtMs: 1.5 },
    {
      userId: 'valid-user',
      reservationId: randomUUID(),
      reservedAtMs: Number.MAX_SAFE_INTEGER + 1,
    },
  ])('rejects invalid compare-and-restore input before writing Redis: $input', async (input) => {
    const client = connect();
    const store = new SaleRedisStore(client);
    const targetSaleId = uniqueSaleId();
    try {
      await expect(store.compareAndRestoreReservation(targetSaleId, input)).rejects.toThrow(
        TypeError,
      );
      expect(await client.exists(saleKeys(targetSaleId).reservations)).toBe(0);
    } finally {
      client.disconnect();
    }
  });
});

describe('SaleRedisStore.inspectReservationMembership — Phase 5 A4 atomic inspection', () => {
  let saleId: string | undefined;

  afterEach(async () => {
    if (saleId) {
      await cleanup(saleId);
      saleId = undefined;
    }
  });

  async function identityState(client: ReturnType<typeof connect>, userId: string) {
    const keys = saleKeys(saleId!);
    return {
      buyerCount: await client.scard(keys.buyers),
      reservationCount: await client.hlen(keys.reservations),
      buyerMember: await client.sismember(keys.buyers, userId),
      reservationValue: await client.hget(keys.reservations, userId),
    };
  }

  it('A4 — inspection classifies BOTH from one read-only Redis serialization point', async () => {
    const client = connect();
    const store = new SaleRedisStore(client);
    saleId = await seedActiveSale(store, { stock: 5 });
    const userId = 'a4-both-buyer';

    try {
      const purchase = await store.purchase(saleId, userId);
      const before = await identityState(client, userId);

      expect(await store.inspectReservationMembership(saleId, userId)).toEqual({
        outcome: 'BOTH',
        reservation: {
          userId,
          reservationId: purchase.reservationId,
          reservedAtMs: expect.any(Number),
        },
      });
      expect(await identityState(client, userId)).toEqual(before);
    } finally {
      client.disconnect();
    }
  });

  it('A4 — inspection classifies NEITHER without mutating either key', async () => {
    const client = connect();
    const store = new SaleRedisStore(client);
    saleId = await seedActiveSale(store, { stock: 5 });
    const userId = 'a4-neither-buyer';

    try {
      const before = await identityState(client, userId);
      expect(await store.inspectReservationMembership(saleId, userId)).toEqual({
        outcome: 'NEITHER',
        reservation: null,
      });
      expect(await identityState(client, userId)).toEqual(before);
    } finally {
      client.disconnect();
    }
  });

  it('A4 — inspection distinguishes BUYER_ONLY from RESERVATION_ONLY without repair', async () => {
    const client = connect();
    const store = new SaleRedisStore(client);
    saleId = await seedActiveSale(store, { stock: 5 });
    const keys = saleKeys(saleId);
    const buyerOnlyUserId = 'a4-buyer-only';
    const reservationOnlyUserId = 'a4-reservation-only';
    const reservationId = randomUUID();
    const reservedAtMs = 1_700_000_000_005;
    await client.sadd(keys.buyers, buyerOnlyUserId);
    await client.hset(keys.reservations, reservationOnlyUserId, `${reservationId}:${reservedAtMs}`);

    try {
      const buyerBefore = await identityState(client, buyerOnlyUserId);
      const reservationBefore = await identityState(client, reservationOnlyUserId);

      expect(await store.inspectReservationMembership(saleId, buyerOnlyUserId)).toEqual({
        outcome: 'BUYER_ONLY',
        reservation: null,
      });
      expect(await store.inspectReservationMembership(saleId, reservationOnlyUserId)).toEqual({
        outcome: 'RESERVATION_ONLY',
        reservation: { userId: reservationOnlyUserId, reservationId, reservedAtMs },
      });
      expect(await identityState(client, buyerOnlyUserId)).toEqual(buyerBefore);
      expect(await identityState(client, reservationOnlyUserId)).toEqual(reservationBefore);
    } finally {
      client.disconnect();
    }
  });

  it('A4 — inspection strictly parses reservation identity and rejects malformed values', async () => {
    const client = connect();
    const store = new SaleRedisStore(client);
    saleId = await seedActiveSale(store, { stock: 5 });
    const keys = saleKeys(saleId);
    const validUserId = 'a4-valid-legacy';
    const malformedUserId = 'a4-malformed-ledger';
    const reservationId = randomUUID();
    await client.hset(keys.reservations, validUserId, reservationId);
    await client.hset(keys.reservations, malformedUserId, 'not-a-reservation');

    try {
      expect(await store.inspectReservationMembership(saleId, validUserId)).toEqual({
        outcome: 'RESERVATION_ONLY',
        reservation: { userId: validUserId, reservationId, reservedAtMs: null },
      });
      await expect(store.inspectReservationMembership(saleId, malformedUserId)).rejects.toThrow(
        `malformed reservation ledger value for user '${malformedUserId}'`,
      );
    } finally {
      client.disconnect();
    }
  });

  it('A4 — inspection rejects invalid userId before Redis execution', async () => {
    const client = connect();
    const store = new SaleRedisStore(client);
    saleId = await seedActiveSale(store, { stock: 5 });
    const evalsha = vi.spyOn(client, 'evalsha');
    const evalScript = vi.spyOn(client, 'eval');

    try {
      await expect(store.inspectReservationMembership(saleId, ' invalid ')).rejects.toThrow(
        new TypeError('Invalid reservation-membership userId'),
      );
      expect(evalsha).not.toHaveBeenCalled();
      expect(evalScript).not.toHaveBeenCalled();
    } finally {
      evalsha.mockRestore();
      evalScript.mockRestore();
      client.disconnect();
    }
  });
});
