// T7 — Compensation idempotency / I4 without breaking I1 (.claude/contracts/phase-1.md §6.3),
// PLUS the post-freeze regression spec for finding 1 of the Phase 1 review
// (.claude/contracts/phase-1.md §11.1): compensation is idempotent by construction, but
// the ORIGINAL token was `SREM`'s return value against the buyers Set — i.e. per
// *membership*, not per *reservation*. That is unsafe under legitimate re-purchase
// after compensation: a stale, redelivered DLQ job for reservation R1 must NOT be able
// to compensate a live, later reservation R2 for the same user just because the user
// is a Set member again. Compensation is now gated on matching the exact
// `reservationId` `purchase()` returned — see `sale-store.ts`/`compensate.lua.ts`.
import { afterEach, describe, expect, it } from 'vitest';

import { saleKeys } from '@flash/shared';

import { cleanup, connect, connectMany, seedActiveSale, seedEndedSale, uniqueSaleId } from '../test/harness';
import { SaleRedisStore } from './sale-store';

describe('SaleRedisStore.compensate (T7)', () => {
  let saleId: string | undefined;

  afterEach(async () => {
    if (saleId) {
      await cleanup(saleId);
      saleId = undefined;
    }
  });

  it('purchase then compensate returns stock and removes the buyer; a second compensate is a NOOP (not +1)', async () => {
    const client = connect();
    const store = new SaleRedisStore(client);
    saleId = await seedActiveSale(store, { stock: 10 });
    const keys = saleKeys(saleId);

    try {
      const purchase = await store.purchase(saleId, 't7-buyer');
      expect(purchase.outcome).toBe('CONFIRMED');
      expect(purchase.stockRemaining).toBe(9);
      expect(purchase.reservationId).toBeTruthy();

      const first = await store.compensate(saleId, 't7-buyer', purchase.reservationId!);
      expect(first.outcome).toBe('COMPENSATED');
      expect(first.stockRemaining).toBe(10);
      expect(await client.scard(keys.buyers)).toBe(0);
      expect(await client.hexists(keys.reservations, 't7-buyer')).toBe(0);

      const second = await store.compensate(saleId, 't7-buyer', purchase.reservationId!);
      expect(second.outcome).toBe('NOOP');
      expect(second.stockRemaining).toBe(10);

      expect(await client.get(keys.stock)).toBe('10');
    } finally {
      client.disconnect();
    }
  });

  it('100 concurrent compensate() for the same reservation: exactly 1 COMPENSATED, 99 NOOP, stock exactly back to 10', async () => {
    const client = connect();
    const store = new SaleRedisStore(client);
    saleId = await seedActiveSale(store, { stock: 10 });
    const keys = saleKeys(saleId);

    const purchase = await store.purchase(saleId, 't7-storm-buyer');
    expect(purchase.outcome).toBe('CONFIRMED');
    const reservationId = purchase.reservationId!;

    const clients = connectMany(20);
    const stores = clients.map((c) => new SaleRedisStore(c));

    try {
      const results = await Promise.all(
        Array.from({ length: 100 }, (_, i) =>
          stores[i % stores.length]!.compensate(saleId!, 't7-storm-buyer', reservationId),
        ),
      );

      const compensated = results.filter((r) => r.outcome === 'COMPENSATED');
      const noop = results.filter((r) => r.outcome === 'NOOP');
      expect(compensated).toHaveLength(1);
      expect(noop).toHaveLength(99);

      const finalStock = await client.get(keys.stock);
      expect(finalStock).toBe('10');
    } finally {
      clients.forEach((c) => c.disconnect());
      client.disconnect();
    }
  });

  it('compensating a user who never purchased is a NOOP and leaves stock unchanged', async () => {
    const client = connect();
    const store = new SaleRedisStore(client);
    saleId = await seedActiveSale(store, { stock: 10 });
    const keys = saleKeys(saleId);

    try {
      const result = await store.compensate(saleId, 't7-never-bought', 'no-such-reservation');
      expect(result.outcome).toBe('NOOP');
      expect(result.stockRemaining).toBe(10);
      expect(await client.get(keys.stock)).toBe('10');
    } finally {
      client.disconnect();
    }
  });

  it('an unrecognised reservationId for a user who DID purchase is a NOOP and does not touch stock/buyers', async () => {
    const client = connect();
    const store = new SaleRedisStore(client);
    saleId = await seedActiveSale(store, { stock: 10 });
    const keys = saleKeys(saleId);

    try {
      const purchase = await store.purchase(saleId, 't7-wrong-token-buyer');
      expect(purchase.outcome).toBe('CONFIRMED');

      const result = await store.compensate(saleId, 't7-wrong-token-buyer', 'totally-wrong-reservation-id');
      expect(result.outcome).toBe('NOOP');
      expect(result.stockRemaining).toBe(9);
      expect(await client.get(keys.stock)).toBe('9');
      expect(await client.sismember(keys.buyers, 't7-wrong-token-buyer')).toBe(1);
    } finally {
      client.disconnect();
    }
  });

  it(
    'FINDING 1 REGRESSION — a stale, redelivered compensation for an EARLIER reservation must not ' +
      'tear down a LATER, live reservation for the same user (compensate-then-repurchase-then-stale-redelivery)',
    async () => {
      const client = connect();
      const store = new SaleRedisStore(client);
      saleId = await seedActiveSale(store, { stock: 10 });
      const keys = saleKeys(saleId);
      const userId = 't7-finding1-buyer';

      try {
        // t1: purchase(U) -> CONFIRMED, stock 10 -> 9, reservation R1 recorded.
        const first = await store.purchase(saleId, userId);
        expect(first.outcome).toBe('CONFIRMED');
        expect(first.stockRemaining).toBe(9);
        const r1 = first.reservationId!;

        // t2/t3: the durable write for R1 fails permanently; the DLQ handler
        // compensates it. stock returns to 10, buyer removed, reservation cleared.
        const compensateR1 = await store.compensate(saleId, userId, r1);
        expect(compensateR1.outcome).toBe('COMPENSATED');
        expect(compensateR1.stockRemaining).toBe(10);
        expect(await client.sismember(keys.buyers, userId)).toBe(0);

        // t4: U retries. purchase(U) -> CONFIRMED again, a NEW reservation R2, stock
        // 10 -> 9. R2 is presumed to persist successfully to Postgres.
        const second = await store.purchase(saleId, userId);
        expect(second.outcome).toBe('CONFIRMED');
        expect(second.stockRemaining).toBe(9);
        const r2 = second.reservationId!;
        expect(r2).not.toBe(r1);

        // t5: the at-least-once queue redelivers the STALE R1 compensation job. Under
        // the original SREM-return-value token this would find the user a Set member
        // again (from R2) and incorrectly COMPENSATE it: stock -> 10, buyer removed,
        // silently destroying the live R2 reservation (I1 oversell, I2 defeated, I4
        // violated — the exact scenario in .claude/contracts/phase-1.md §11.1).
        const staleRedelivery = await store.compensate(saleId, userId, r1);

        // FIX: the stale reservationId no longer matches what's on file (r2), so this
        // is unconditionally a NOOP. R2's stock and buyer-set entry survive untouched.
        expect(staleRedelivery.outcome).toBe('NOOP');
        expect(staleRedelivery.stockRemaining).toBe(9);
        expect(await client.get(keys.stock)).toBe('9');
        expect(await client.sismember(keys.buyers, userId)).toBe(1);
        expect(await client.hget(keys.reservations, userId)).toMatch(new RegExp(`^${r2}:`));

        // And a correctly-targeted compensation of R2 still works exactly once.
        const compensateR2 = await store.compensate(saleId, userId, r2);
        expect(compensateR2.outcome).toBe('COMPENSATED');
        expect(compensateR2.stockRemaining).toBe(10);
        expect(await client.sismember(keys.buyers, userId)).toBe(0);
      } finally {
        client.disconnect();
      }
    },
  );

  it('stock already at totalStock with a buyer + reservation present returns COMPENSATED_CAPPED and does not exceed totalStock', async () => {
    const client = connect();
    const store = new SaleRedisStore(client);
    saleId = await seedActiveSale(store, { stock: 10 });
    const keys = saleKeys(saleId);
    const reservationId = 't7-capped-reservation';

    try {
      // Simulate corrupted state: a buyer + reservation recorded but stock never
      // decremented (or already restored by an earlier compensation), so stock
      // already sits at totalStock while the buyer/reservation are still present.
      await client.sadd(keys.buyers, 't7-capped-buyer');
      await client.hset(keys.reservations, 't7-capped-buyer', `${reservationId}:${Date.now()}`);

      const result = await store.compensate(saleId, 't7-capped-buyer', reservationId);
      expect(result.outcome).toBe('COMPENSATED_CAPPED');
      expect(result.stockRemaining).toBe(10);
      expect(await client.get(keys.stock)).toBe('10');
      // The buyer and reservation were still removed (unconditional once matched).
      expect(await client.sismember(keys.buyers, 't7-capped-buyer')).toBe(0);
      expect(await client.hexists(keys.reservations, 't7-capped-buyer')).toBe(0);
    } finally {
      client.disconnect();
    }
  });

  it('compensation succeeds after the sale has ended (no window gate)', async () => {
    const client = connect();
    const store = new SaleRedisStore(client);
    saleId = uniqueSaleId();
    // Seed active first so the purchase can land, then move to an ended window via a
    // second sale seeded directly as ended, exercising compensate() against it.
    const endedSaleId = await seedEndedSale(store, { saleId, stock: 10 });
    expect(endedSaleId).toBe(saleId);

    const keys = saleKeys(saleId);
    const reservationId = 't7-post-end-reservation';
    // Directly place a buyer + reservation + decremented stock to simulate a purchase
    // that was confirmed while the sale was still active, now being compensated after
    // endsAt — exactly the shape of Phase 3's DLQ traffic, which lands after the sale
    // closes.
    await client.sadd(keys.buyers, 't7-post-end-buyer');
    await client.hset(keys.reservations, 't7-post-end-buyer', `${reservationId}:${Date.now()}`);
    await client.decr(keys.stock);

    try {
      const result = await store.compensate(saleId, 't7-post-end-buyer', reservationId);
      expect(result.outcome).toBe('COMPENSATED');
      expect(result.stockRemaining).toBe(10);
    } finally {
      client.disconnect();
    }
  });
});
