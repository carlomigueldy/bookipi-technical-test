// T6 — Window / I3 at exact millisecond boundaries (.claude/contracts/phase-1.md §6.3).
//
// Uses the server's OWN clock (Redis TIME), so it is deterministic without fake timers:
// real time only moves forward, so seeding a window edge exactly at "now" and then
// making the actual purchase call a few milliseconds later reliably lands on the
// correct side of the inclusive-start / exclusive-end boundary.
import type { Redis } from 'ioredis';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { saleKeys } from '@flash/shared';

import { cleanup, connect, uniqueSaleId } from '../test/harness';
import { SaleRedisStore } from './sale-store';
import type { SaleConfigInput } from './types';

async function readServerNowMs(client: Redis): Promise<number> {
  const [seconds, microseconds] = await client.time();
  return Number(seconds) * 1000 + Math.floor(Number(microseconds) / 1000);
}

describe("SaleRedisStore window enforcement (T6, using the server's own clock)", () => {
  let client: Redis;
  let store: SaleRedisStore;
  let saleId: string | undefined;

  beforeAll(() => {
    client = connect();
    store = new SaleRedisStore(client);
  });

  afterEach(async () => {
    if (saleId) {
      await cleanup(saleId);
      saleId = undefined;
    }
  });

  it('start boundary is inclusive: purchase at exactly startsAtMs is CONFIRMED', async () => {
    saleId = uniqueSaleId();
    const t0 = await readServerNowMs(client);
    const config: SaleConfigInput = {
      saleId,
      name: 'T6 start inclusive',
      startsAt: new Date(t0).toISOString(),
      endsAt: new Date(t0 + 3_600_000).toISOString(),
      totalStock: 5,
    };
    await store.seed(config);

    const result = await store.purchase(saleId, 't6-start-buyer');
    expect(result.outcome).toBe('CONFIRMED');
  });

  it('end boundary is exclusive: purchase at/after endsAtMs is SALE_ENDED', async () => {
    saleId = uniqueSaleId();
    const t0 = await readServerNowMs(client);
    const config: SaleConfigInput = {
      saleId,
      name: 'T6 end exclusive',
      startsAt: new Date(t0 - 1000).toISOString(),
      endsAt: new Date(t0).toISOString(),
      totalStock: 5,
    };
    await store.seed(config);

    const result = await store.purchase(saleId, 't6-end-buyer');
    expect(result.outcome).toBe('SALE_ENDED');
  });

  it('SALE_NOT_STARTED has zero side effects: stock and buyers untouched', async () => {
    saleId = uniqueSaleId();
    const t0 = await readServerNowMs(client);
    const config: SaleConfigInput = {
      saleId,
      name: 'T6 not started, no side effects',
      startsAt: new Date(t0 + 60_000).toISOString(),
      endsAt: new Date(t0 + 120_000).toISOString(),
      totalStock: 5,
    };
    await store.seed(config);

    const result = await store.purchase(saleId, 't6-early-buyer');
    expect(result.outcome).toBe('SALE_NOT_STARTED');
    expect(result.reservationId).toBeNull();

    const keys = saleKeys(saleId);
    expect(await client.get(keys.stock)).toBe('5');
    expect(await client.scard(keys.buyers)).toBe(0);
    expect(await client.hlen(keys.reservations)).toBe(0);
  });

  it('SALE_ENDED has zero side effects: stock and buyers untouched', async () => {
    saleId = uniqueSaleId();
    const t0 = await readServerNowMs(client);
    const config: SaleConfigInput = {
      saleId,
      name: 'T6 ended, no side effects',
      startsAt: new Date(t0 - 120_000).toISOString(),
      endsAt: new Date(t0 - 60_000).toISOString(),
      totalStock: 5,
    };
    await store.seed(config);

    const result = await store.purchase(saleId, 't6-late-buyer');
    expect(result.outcome).toBe('SALE_ENDED');
    expect(result.reservationId).toBeNull();

    const keys = saleKeys(saleId);
    expect(await client.get(keys.stock)).toBe('5');
    expect(await client.scard(keys.buyers)).toBe(0);
    expect(await client.hlen(keys.reservations)).toBe(0);
  });

  it('an already-purchased user attempting after the sale ends gets SALE_ENDED, not ALREADY_PURCHASED', async () => {
    saleId = uniqueSaleId();
    const now = Date.now();
    const activeConfig: SaleConfigInput = {
      saleId,
      name: 'T6 already-purchased then ended',
      startsAt: new Date(now - 60_000).toISOString(),
      endsAt: new Date(now + 3_600_000).toISOString(),
      totalStock: 5,
    };
    await store.seed(activeConfig);

    const buyer = 't6-loyal-buyer';
    const purchaseWhileActive = await store.purchase(saleId, buyer);
    expect(purchaseWhileActive.outcome).toBe('CONFIRMED');

    // Directly rewrite the live config's window to one that has already closed. This
    // pins §4.3's check order (window checked BEFORE the SISMEMBER duplicate check)
    // independent of seed.lua's separate idempotency gate, which T8 already covers.
    const keys = saleKeys(saleId);
    const t0 = await readServerNowMs(client);
    await client.hset(
      keys.config,
      'startsAtMs',
      String(t0 - 120_000),
      'endsAtMs',
      String(t0 - 60_000),
    );

    const retry = await store.purchase(saleId, buyer);
    expect(retry.outcome).toBe('SALE_ENDED');
    expect(retry.outcome).not.toBe('ALREADY_PURCHASED');
  });
});
