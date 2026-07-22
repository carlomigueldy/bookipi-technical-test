// apps/api/src/purchase/purchase-status.service.spec.ts  [SLICE C — frozen contract §8.2]
//
// Pure unit tests against hand-rolled `pg.Pool` / `SaleRedisStore` fakes — no
// container. The real Postgres-backed behaviour (durable rows, `orders_user_id_uniq`)
// is exercised by SLICE E's `purchase-status.integration.spec.ts` against a real
// Postgres. This file's job is the precedence/degradation policy in §8.2, which is
// pure control flow and does not need a real datastore to prove.
import { describe, expect, it, vi } from 'vitest';

import type { SaleRedisStore } from '@flash/redis';

import { messageFor } from '../common/messages.js';
import { PurchaseStatusService } from './purchase-status.service.js';

const SALE_ID = 'flash-2026';
const USER_ID = 'alice';
const REQUEST_ID = 'req-1';
const ENV = { SALE_ID };

function makePool(queryImpl: () => Promise<{ rows: unknown[] }>) {
  return { query: vi.fn(queryImpl) };
}

function makeStore(hasPurchasedImpl: () => Promise<boolean>) {
  return { hasPurchased: vi.fn(hasPurchasedImpl) } as unknown as SaleRedisStore;
}

function makeClock(nowMs = 1_700_000_000_000) {
  return { nowMs: vi.fn(() => nowMs) };
}

function makeService(
  pool: ReturnType<typeof makePool>,
  store: SaleRedisStore,
  clock = makeClock(),
) {
  return new PurchaseStatusService(pool as never, store, clock as never, ENV as never);
}

describe('PurchaseStatusService.getStatus — §8.2 precedence', () => {
  it('a PERSISTED PG row wins: purchased true, real createdAt', async () => {
    const createdAt = new Date('2026-07-22T12:00:00.000Z');
    const pool = makePool(async () => ({ rows: [{ status: 'persisted', created_at: createdAt }] }));
    const store = makeStore(async () => {
      throw new Error('must not be called — PG row already answered the question');
    });

    const service = makeService(pool, store);
    const outcome = await service.getStatus(USER_ID, REQUEST_ID);

    expect(outcome.httpStatus).toBe(200);
    expect(outcome.body).toMatchObject({
      purchased: true,
      order: { status: 'persisted', createdAt: createdAt.toISOString() },
    });
  });

  it('a COMPENSATED PG row means purchased: false — the single most misleading thing this endpoint could get wrong', async () => {
    const createdAt = new Date('2026-07-22T12:00:00.000Z');
    const pool = makePool(async () => ({
      rows: [{ status: 'compensated', created_at: createdAt }],
    }));
    const store = makeStore(async () => true); // must not matter — PG row wins outright

    const service = makeService(pool, store);
    const outcome = await service.getStatus(USER_ID, REQUEST_ID);

    expect(outcome.httpStatus).toBe(200);
    expect(outcome.body).toMatchObject({
      purchased: false,
      order: { status: 'compensated', createdAt: createdAt.toISOString() },
    });
  });

  it('no PG row, Redis has the buyer: reserved / purchased true / createdAt null', async () => {
    const pool = makePool(async () => ({ rows: [] }));
    const store = makeStore(async () => true);

    const service = makeService(pool, store);
    const outcome = await service.getStatus(USER_ID, REQUEST_ID);

    expect(outcome.httpStatus).toBe(200);
    expect(outcome.body).toEqual(
      expect.objectContaining({
        purchased: true,
        order: { status: 'reserved', createdAt: null },
      }),
    );
  });

  it('no PG row, not in Redis either: purchased false, order null', async () => {
    const pool = makePool(async () => ({ rows: [] }));
    const store = makeStore(async () => false);

    const service = makeService(pool, store);
    const outcome = await service.getStatus(USER_ID, REQUEST_ID);

    expect(outcome.httpStatus).toBe(200);
    expect(outcome.body).toEqual(expect.objectContaining({ purchased: false, order: null }));
  });

  it('Postgres unreachable degrades to the Redis answer — NEVER a 503 on a PG outage alone', async () => {
    const pool = makePool(async () => {
      throw new Error('ECONNREFUSED');
    });
    const store = makeStore(async () => true);

    const service = makeService(pool, store);
    const outcome = await service.getStatus(USER_ID, REQUEST_ID);

    expect(outcome.httpStatus).toBe(200);
    expect(outcome.body).toEqual(
      expect.objectContaining({ purchased: true, order: { status: 'reserved', createdAt: null } }),
    );
  });

  it('Postgres unreachable AND Redis unreachable: 503 UPSTREAM_UNAVAILABLE — we genuinely do not know', async () => {
    const pool = makePool(async () => {
      throw new Error('ECONNREFUSED');
    });
    const store = makeStore(async () => {
      throw new Error('ECONNREFUSED');
    });

    const service = makeService(pool, store);
    const outcome = await service.getStatus(USER_ID, REQUEST_ID);
    const expectedMessage = messageFor('UPSTREAM_UNAVAILABLE');

    expect(outcome.httpStatus).toBe(503);
    expect(outcome.body).toMatchObject({
      error: 'UPSTREAM_UNAVAILABLE',
      message: expectedMessage,
      requestId: REQUEST_ID,
    });
    expect(expectedMessage).toBe(
      'The service is temporarily unavailable. Please try again shortly.',
    );
  });

  it('Postgres reachable with no row, Redis unreachable: still 503 (no PG row to fall back on)', async () => {
    const pool = makePool(async () => ({ rows: [] }));
    const store = makeStore(async () => {
      throw new Error('ECONNREFUSED');
    });

    const service = makeService(pool, store);
    const outcome = await service.getStatus(USER_ID, REQUEST_ID);

    expect(outcome.httpStatus).toBe(503);
  });

  it('captures the clock once and derives consistent timestamps on every response branch', async () => {
    const createdAt = new Date('2026-07-22T12:00:00.000Z');
    const cases = [
      {
        pool: makePool(async () => ({
          rows: [{ status: 'persisted', created_at: createdAt }],
        })),
        store: makeStore(async () => false),
      },
      {
        pool: makePool(async () => ({ rows: [] })),
        store: makeStore(async () => true),
      },
      {
        pool: makePool(async () => ({ rows: [] })),
        store: makeStore(async () => {
          throw new Error('ECONNREFUSED');
        }),
      },
    ];

    for (const { pool, store } of cases) {
      const firstNowMs = 1_700_000_000_000;
      let nextNowMs = firstNowMs;
      const clock = { nowMs: vi.fn(() => nextNowMs++) };
      const service = makeService(pool, store, clock);

      const outcome = await service.getStatus(USER_ID, REQUEST_ID);

      expect(outcome.body.serverTimeMs).toBe(firstNowMs);
      expect(outcome.body.serverTime).toBe(new Date(firstNowMs).toISOString());
      expect(clock.nowMs).toHaveBeenCalledOnce();
    }
  });
});
