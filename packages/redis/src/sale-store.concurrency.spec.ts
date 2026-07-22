// T1 (the money test) and T2 (its negative control), per .claude/contracts/phase-1.md §6.3.
//
// T1 proves purchase.lua's check-decrement-record sequence is one indivisible unit on
// real Redis 7.4 — not an in-memory mock, which cannot prove atomicity because it does
// not share Redis's single-threaded execution model (§6.1: a mocked client's
// `Promise.all` of 500 "purchases" is interleaved by the JS scheduler, not by Redis, so
// any apparent serialization would be a JS artefact, not a property of the datastore).
//
// T2 proves T1 actually has discriminating power: run T1's exact scenario against a
// deliberately non-atomic, four-round-trip implementation and confirm it oversells.
// Without T2, a green T1 is unfalsifiable — it could be green against a harness too
// weak to ever overlap requests.
import type { Redis } from 'ioredis';
import { describe, expect, it } from 'vitest';

import { saleKeys, type SaleKeys } from '@flash/shared';

import { cleanup, connectMany, seedActiveSale } from '../test/harness';
import { SaleRedisStore } from './sale-store';

const STOCK = 10;
const ATTEMPTS = 500;
const CONNECTIONS = 50;
const LOOPS = 5;

function distinctUserIds(prefix: string, n: number): string[] {
  return Array.from({ length: n }, (_, i) => `${prefix}-${i}`);
}

/**
 * Waits for every connection to be fully established before the timed workload starts.
 *
 * Without this, `Promise.all`-firing 500 calls immediately after `connectMany()` measures
 * connection-establishment jitter as part of "concurrency": ioredis queues commands on a
 * not-yet-ready socket (`enableOfflineQueue: true`) and flushes them once connected, so
 * different connections' first commands land at wildly different real times, which
 * *artificially serializes* the workload and defeats both T1 (turns a real stress test
 * into a soft one) and T2 (the whole point of which is to reliably observe the race a
 * non-atomic implementation is vulnerable to). Confirmed empirically: without this
 * warm-up, T2 sometimes failed to oversell at all; with it, T2 oversells by ~490 units
 * on every run. See this slice's completion report for the full investigation.
 */
async function warmUp(clients: readonly Redis[]): Promise<void> {
  await Promise.all(clients.map((c) => c.ping()));
}

/**
 * Deliberately NON-atomic purchase, defined only in this spec file, used exclusively
 * to prove T1 has discriminating power. Never import this outside this test — it is
 * the exact class of bug `purchase.lua` exists to make impossible: GET, then an
 * explicit yield, then a duplicate check, then DECR, then SADD, as four independent
 * Redis round trips instead of one atomic script.
 */
async function purchaseUnsafe(
  client: Redis,
  keys: SaleKeys,
  userId: string,
): Promise<{ outcome: 'CONFIRMED' | 'ALREADY_PURCHASED' | 'SOLD_OUT'; stockRemaining: number }> {
  const stockStr = await client.get(keys.stock);

  // Deterministic yield: forces every concurrent caller to have already issued its GET
  // before any of them proceeds to check/decrement, guaranteeing the race actually
  // overlaps rather than depending on incidental network jitter (i.e. not flaky).
  await new Promise<void>((resolve) => setImmediate(resolve));

  const isMember = await client.sismember(keys.buyers, userId);
  if (isMember === 1) {
    return { outcome: 'ALREADY_PURCHASED', stockRemaining: Number(stockStr ?? '0') };
  }

  const stock = Number(stockStr ?? '0');
  if (stock <= 0) {
    return { outcome: 'SOLD_OUT', stockRemaining: 0 };
  }

  const remaining = await client.decr(keys.stock);
  await client.sadd(keys.buyers, userId);
  return { outcome: 'CONFIRMED', stockRemaining: remaining };
}

describe('SaleRedisStore concurrency — the money test (T1) and its negative control (T2)', () => {
  it(
    `T1 — ${ATTEMPTS} concurrent attempts over ${CONNECTIONS} connections for stock=${STOCK}, run ${LOOPS}x`,
    async () => {
      const clients = connectMany(CONNECTIONS);
      await warmUp(clients);
      const stores = clients.map((c) => new SaleRedisStore(c));

      try {
        for (let loop = 0; loop < LOOPS; loop += 1) {
          const saleId = await seedActiveSale(stores[0]!, { stock: STOCK });
          const userIds = distinctUserIds(`t1-loop${loop}`, ATTEMPTS);

          try {
            const results = await Promise.all(
              userIds.map((userId, i) => stores[i % stores.length]!.purchase(saleId, userId)),
            );

            const confirmed = results.filter((r) => r.outcome === 'CONFIRMED');
            const soldOut = results.filter((r) => r.outcome === 'SOLD_OUT');
            const other = results.filter(
              (r) => r.outcome !== 'CONFIRMED' && r.outcome !== 'SOLD_OUT',
            );

            expect(confirmed).toHaveLength(STOCK);
            expect(soldOut).toHaveLength(ATTEMPTS - STOCK);
            expect(other).toHaveLength(0);

            const keys = saleKeys(saleId);
            const finalStock = Number(await clients[0]!.get(keys.stock));
            expect(finalStock).toBe(0);
            expect(finalStock).toBeGreaterThanOrEqual(0);

            const buyersCount = await clients[0]!.scard(keys.buyers);
            expect(buyersCount).toBe(STOCK);

            // The double-spend detector: every CONFIRMED must report a DISTINCT
            // remaining value. Two concurrent non-atomic decrements would either
            // report the same remaining value or skip one — asserted on the sorted
            // array, not merely on the count.
            const remainingValues = confirmed.map((r) => r.stockRemaining).sort((a, b) => a - b);
            expect(remainingValues).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);

            // Confirmed userIds are distinct and are exactly the buyers-set members.
            const confirmedUserIds = new Set<string>();
            results.forEach((r, i) => {
              if (r.outcome === 'CONFIRMED') confirmedUserIds.add(userIds[i]!);
            });
            expect(confirmedUserIds.size).toBe(STOCK);

            const buyerMembers = await clients[0]!.smembers(keys.buyers);
            expect(new Set(buyerMembers)).toEqual(confirmedUserIds);

            // Post-freeze (.claude/contracts/phase-1.md §11.1, finding 1): every
            // CONFIRMED result must carry a distinct, non-empty reservationId, and the
            // reservations hash must have exactly STOCK entries matching the buyers
            // set. A second atomic-uniqueness proof, independent of the stockRemaining
            // one above — two concurrent purchases racing to reuse a reservationId (or
            // to skip writing one) would show up here even if they didn't skew stock.
            const reservationIds = confirmed.map((r) => r.reservationId);
            expect(reservationIds.every((id) => typeof id === 'string' && id.length > 0)).toBe(true);
            expect(new Set(reservationIds).size).toBe(STOCK);

            const reservationCount = await clients[0]!.hlen(keys.reservations);
            expect(reservationCount).toBe(STOCK);
          } finally {
            await cleanup(saleId);
          }
        }
      } finally {
        clients.forEach((c) => c.disconnect());
      }
    },
  );

  it('T2 — negative control: the same scenario against a non-atomic purchaseUnsafe() oversells', async () => {
    const clients = connectMany(CONNECTIONS);
    await warmUp(clients);
    const seedClient = clients[0]!;
    const store = new SaleRedisStore(seedClient);
    const saleId = await seedActiveSale(store, { stock: STOCK });
    const keys = saleKeys(saleId);
    const userIds = distinctUserIds('t2-unsafe', ATTEMPTS);

    try {
      const results = await Promise.all(
        userIds.map((userId, i) => purchaseUnsafe(clients[i % clients.length]!, keys, userId)),
      );

      const confirmedCount = results.filter((r) => r.outcome === 'CONFIRMED').length;
      const finalStock = Number(await seedClient.get(keys.stock));

      // If the harness lacked the concurrency to actually overlap requests, this
      // deliberately broken implementation would still look correct — which would mean
      // T1's green result proves nothing. Fail loudly rather than silently passing.
      const oversold = confirmedCount > STOCK || finalStock < 0;
      expect(oversold).toBe(true);
    } finally {
      await cleanup(saleId);
      clients.forEach((c) => c.disconnect());
    }
  });
});
