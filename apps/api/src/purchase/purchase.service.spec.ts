// apps/api/src/purchase/purchase.service.spec.ts  [SLICE C]
//
// Pure unit tests: every dependency is a hand-rolled fake (no Nest DI container, no
// real Redis/Postgres/BullMQ) so these run instantly and without a container. The
// concurrency/atomicity claims themselves are proven against REAL Redis by the
// integration suite (SLICE E, `concurrency.integration.spec.ts`) — this file's job is
// the flow logic above the Lua boundary: guard order, outcome->HTTP mapping, and the
// §8.4 enqueue-failure policy.
//
// `SaleRedisStore`, `Clock`, `SaleSnapshotCache`, and `OrdersQueueService` are only
// ever imported here as TYPES (erased at build time) so this spec has no runtime
// dependency on `@flash/redis` or the not-yet-authored `infra/**` modules — it types
// its fakes structurally and casts them at the constructor boundary. Once SLICE A's
// `infra/**` lands, these casts stay exactly as-is; nothing here is provisional logic,
// only provisional wiring.
import { describe, expect, it, vi } from 'vitest';

import { PURCHASE_OUTCOME_HTTP_STATUS, type AttemptOutcome } from '@flash/shared';
import type { PurchaseResult, SaleRedisStore, SaleSnapshot } from '@flash/redis';

import type { OrdersQueueService } from '../queue/orders-queue.service.js';

import {
  buildPurchaseEnvelope,
  evaluateFastPathGuard,
  PurchaseService,
} from './purchase.service.js';

const SALE_ID = 'flash-2026';
const USER_ID = 'alice';
const REQUEST_ID = 'req-1';

function makeClock(overrides: Partial<{ isFresh: boolean; nowMs: number; rttMs: number }> = {}) {
  const { isFresh = true, nowMs = 1_700_000_000_000, rttMs = 2 } = overrides;
  return {
    isFresh: vi.fn(() => isFresh),
    nowMs: vi.fn(() => nowMs),
    rttMs: vi.fn(() => rttMs),
    offsetMs: vi.fn(() => 0),
    ageMs: vi.fn(() => 100),
  };
}

function makeCache(
  partial: { startsAtMs: number; endsAtMs: number; initialized: boolean } | null,
  ageMs = 100,
) {
  const snapshot: SaleSnapshot | null =
    partial === null
      ? null
      : {
          initialized: partial.initialized,
          saleId: SALE_ID,
          name: 'Flash Sale 2026',
          startsAt: new Date(partial.startsAtMs).toISOString(),
          endsAt: new Date(partial.endsAtMs).toISOString(),
          startsAtMs: partial.startsAtMs,
          endsAtMs: partial.endsAtMs,
          totalStock: 10,
          stockRemaining: 10,
          serverTimeMs: partial.startsAtMs,
          state: 'upcoming',
        };
  return {
    get: vi.fn(() => (snapshot === null ? null : { snapshot, ageMs })),
  };
}

const ENV = {
  SALE_ID,
  CLOCK_GUARD_SKEW_MS: 250,
  CLOCK_MAX_STALENESS_MS: 15_000,
  ENQUEUE_TIMEOUT_MS: 500,
};

function makeStore(purchaseResult: PurchaseResult | Error) {
  return {
    purchase: vi.fn(async () => {
      if (purchaseResult instanceof Error) throw purchaseResult;
      return purchaseResult;
    }),
    bumpMetric: vi.fn(async () => undefined),
  };
}

function makeQueue(behavior: 'ok' | 'always-fails' | 'fails-once' = 'ok') {
  let calls = 0;
  return {
    enqueue: vi.fn(async () => {
      calls += 1;
      if (behavior === 'always-fails') throw new Error('queue down');
      if (behavior === 'fails-once' && calls === 1) throw new Error('queue blip');
      return undefined;
    }),
  };
}

function makeService(params: {
  store: ReturnType<typeof makeStore>;
  clock?: ReturnType<typeof makeClock>;
  cache?: ReturnType<typeof makeCache>;
  queue?: ReturnType<typeof makeQueue>;
  env?: typeof ENV;
}): PurchaseService {
  const clock = params.clock ?? makeClock();
  const cache = params.cache ?? makeCache(null);
  const queue = params.queue ?? makeQueue('ok');
  const env = params.env ?? ENV;
  return new PurchaseService(
    params.store as unknown as SaleRedisStore,
    clock as never,
    cache as never,
    env as never,
    queue as unknown as OrdersQueueService,
  );
}

function confirmedResult(overrides: Partial<PurchaseResult> = {}): PurchaseResult {
  return {
    outcome: 'CONFIRMED',
    stockRemaining: 9,
    serverTimeMs: 1_700_000_000_500,
    reservationId: 'reservation-1',
    ...overrides,
  };
}

describe('evaluateFastPathGuard (§5.5)', () => {
  it('is disabled when the clock is not fresh', () => {
    const clock = makeClock({ isFresh: false });
    const cache = makeCache({ startsAtMs: 0, endsAtMs: 100, initialized: true });
    expect(evaluateFastPathGuard(clock, cache, ENV)).toBeNull();
  });

  it('is disabled when the cache has no snapshot', () => {
    const clock = makeClock();
    const cache = makeCache(null);
    expect(evaluateFastPathGuard(clock, cache, ENV)).toBeNull();
  });

  it('is disabled when the cached snapshot is not initialized', () => {
    const clock = makeClock();
    const cache = makeCache({ startsAtMs: 0, endsAtMs: 100, initialized: false });
    expect(evaluateFastPathGuard(clock, cache, ENV)).toBeNull();
  });

  it('is disabled when the cache entry itself is stale', () => {
    const clock = makeClock();
    const cache = makeCache(
      { startsAtMs: 0, endsAtMs: 1_800_000_000_000, initialized: true },
      20_000,
    );
    expect(evaluateFastPathGuard(clock, cache, ENV)).toBeNull();
  });

  it('rejects SALE_NOT_STARTED when now is more than the skew margin before startsAt', () => {
    const nowMs = 1_700_000_000_000;
    const clock = makeClock({ nowMs, rttMs: 1 });
    const cache = makeCache({
      startsAtMs: nowMs + 1_000,
      endsAtMs: nowMs + 10_000,
      initialized: true,
    });
    expect(evaluateFastPathGuard(clock, cache, ENV)).toEqual({
      outcome: 'SALE_NOT_STARTED',
      nowMs,
    });
  });

  it('rejects SALE_ENDED when now is at/after endsAt plus the skew margin', () => {
    const nowMs = 1_700_000_000_000;
    const clock = makeClock({ nowMs, rttMs: 1 });
    const cache = makeCache({
      startsAtMs: nowMs - 10_000,
      endsAtMs: nowMs - 1_000,
      initialized: true,
    });
    expect(evaluateFastPathGuard(clock, cache, ENV)).toEqual({ outcome: 'SALE_ENDED', nowMs });
  });

  it('stays SILENT inside the skew margin near startsAt — the boundary is always delegated to Lua', () => {
    const nowMs = 1_700_000_000_000;
    const clock = makeClock({ nowMs, rttMs: 1 }); // skew = max(250, 4) = 250
    const cache = makeCache({
      startsAtMs: nowMs + 200,
      endsAtMs: nowMs + 10_000,
      initialized: true,
    });
    expect(evaluateFastPathGuard(clock, cache, ENV)).toBeNull();
  });

  it('stays SILENT inside the skew margin near endsAt', () => {
    const nowMs = 1_700_000_000_000;
    const clock = makeClock({ nowMs, rttMs: 1 });
    const cache = makeCache({
      startsAtMs: nowMs - 10_000,
      endsAtMs: nowMs - 200,
      initialized: true,
    });
    expect(evaluateFastPathGuard(clock, cache, ENV)).toBeNull();
  });

  it('is silent (delegates to Lua) when now is safely inside the window', () => {
    const nowMs = 1_700_000_000_000;
    const clock = makeClock({ nowMs, rttMs: 1 });
    const cache = makeCache({
      startsAtMs: nowMs - 10_000,
      endsAtMs: nowMs + 10_000,
      initialized: true,
    });
    expect(evaluateFastPathGuard(clock, cache, ENV)).toBeNull();
  });

  it('widens the margin to 4x RTT when that exceeds the configured floor', () => {
    const nowMs = 1_700_000_000_000;
    const clock = makeClock({ nowMs, rttMs: 100 }); // 4*100 = 400 > 250 floor
    // 300ms before start: inside the 400ms RTT-derived margin -> must stay silent
    const cache = makeCache({
      startsAtMs: nowMs + 300,
      endsAtMs: nowMs + 10_000,
      initialized: true,
    });
    expect(evaluateFastPathGuard(clock, cache, ENV)).toBeNull();
  });
});

describe('buildPurchaseEnvelope', () => {
  it('derives serverTime and the pinned message from the outcome', () => {
    const envelope = buildPurchaseEnvelope({
      outcome: 'CONFIRMED',
      userId: USER_ID,
      saleId: SALE_ID,
      stockRemaining: 3,
      serverTimeMs: 1_700_000_000_000,
    });
    expect(envelope.serverTime).toBe(new Date(1_700_000_000_000).toISOString());
    expect(envelope.status).toBe('CONFIRMED');
    expect(envelope.message).toBe('Purchase confirmed.');
  });

  it.each([
    ['CONFIRMED', 'Purchase confirmed.'],
    ['ALREADY_PURCHASED', 'You have already purchased this item.'],
    ['SOLD_OUT', 'This item is sold out.'],
    ['SALE_NOT_STARTED', 'The sale has not started yet.'],
    ['SALE_ENDED', 'The sale has ended.'],
    ['NOT_INITIALIZED', 'The sale is not ready yet. Please try again shortly.'],
    ['INVALID_USER_ID', 'The provided user ID is invalid.'],
    ['RATE_LIMITED', 'Too many requests. Please slow down and try again shortly.'],
    ['UPSTREAM_UNAVAILABLE', 'The service is temporarily unavailable. Please try again shortly.'],
  ] satisfies Array<[AttemptOutcome, string]>)('uses messageFor for %s', (outcome, message) => {
    const envelope = buildPurchaseEnvelope({
      outcome,
      userId: USER_ID,
      saleId: SALE_ID,
      stockRemaining: null,
      serverTimeMs: 1_700_000_000_000,
    });

    expect(envelope.message).toBe(message);
  });
});

describe('PurchaseService.purchase — outcome -> HTTP status (§6.4)', () => {
  // NOTE ON RETURN SHAPE: `purchase()` deliberately returns the bare decision
  // (`{outcome, stockRemaining, serverTimeMs, reservationId}`), NOT a finished HTTP
  // envelope — see the file header on `purchase.service.ts`. Resolving
  // `PURCHASE_OUTCOME_HTTP_STATUS` and building the envelope is
  // `PurchaseController`'s job (covered by `purchase.controller.spec.ts`); this
  // describes only the flow-level "which outcome comes out for which input".
  const cases: Array<{ outcome: AttemptOutcome; result: Partial<PurchaseResult> }> = [
    {
      outcome: 'CONFIRMED',
      result: { outcome: 'CONFIRMED', stockRemaining: 9, reservationId: 'r-1' },
    },
    {
      outcome: 'ALREADY_PURCHASED',
      result: { outcome: 'ALREADY_PURCHASED', stockRemaining: 5, reservationId: null },
    },
    {
      outcome: 'SOLD_OUT',
      result: { outcome: 'SOLD_OUT', stockRemaining: 0, reservationId: null },
    },
    {
      outcome: 'SALE_NOT_STARTED',
      result: { outcome: 'SALE_NOT_STARTED', stockRemaining: 10, reservationId: null },
    },
    {
      outcome: 'SALE_ENDED',
      result: { outcome: 'SALE_ENDED', stockRemaining: 0, reservationId: null },
    },
    {
      outcome: 'NOT_INITIALIZED',
      result: { outcome: 'NOT_INITIALIZED', stockRemaining: -1, reservationId: null },
    },
  ];

  it.each(cases)(
    'passes through Lua outcome $outcome, mappable via PURCHASE_OUTCOME_HTTP_STATUS[$outcome]',
    async ({ outcome, result }) => {
      const store = makeStore({ serverTimeMs: 1_700_000_000_777, ...result } as PurchaseResult);
      const service = makeService({ store });

      const decision = await service.purchase(USER_ID, REQUEST_ID);

      expect(PURCHASE_OUTCOME_HTTP_STATUS[decision.outcome]).toBe(
        PURCHASE_OUTCOME_HTTP_STATUS[outcome],
      );
      expect(decision.outcome).toBe(outcome);
    },
  );

  it("NOT_INITIALIZED maps Lua's -1 sentinel to stockRemaining: null, never passes -1 through", async () => {
    const store = makeStore({
      outcome: 'NOT_INITIALIZED',
      stockRemaining: -1,
      serverTimeMs: 1,
      reservationId: null,
    });
    const service = makeService({ store });

    const decision = await service.purchase(USER_ID, REQUEST_ID);

    expect(decision.stockRemaining).toBeNull();
  });

  it('a thrown Redis error maps to UPSTREAM_UNAVAILABLE / 503 — never a synthesized business outcome', async () => {
    const store = makeStore(new Error('ECONNREFUSED'));
    const service = makeService({ store });

    const decision = await service.purchase(USER_ID, REQUEST_ID);

    expect(PURCHASE_OUTCOME_HTTP_STATUS[decision.outcome]).toBe(503);
    expect(decision.outcome).toBe('UPSTREAM_UNAVAILABLE');
    expect(decision.stockRemaining).toBeNull();
  });

  it('the fast-path guard short-circuits before store.purchase is ever called', async () => {
    const nowMs = 1_700_000_000_000;
    const clock = makeClock({ nowMs, rttMs: 1 });
    const cache = makeCache({
      startsAtMs: nowMs + 10_000,
      endsAtMs: nowMs + 20_000,
      initialized: true,
    });
    const store = makeStore(confirmedResult());
    const service = makeService({ store, clock, cache });

    const decision = await service.purchase(USER_ID, REQUEST_ID);

    expect(store.purchase).not.toHaveBeenCalled();
    expect(PURCHASE_OUTCOME_HTTP_STATUS[decision.outcome]).toBe(403);
    expect(decision.outcome).toBe('SALE_NOT_STARTED');
    expect(decision.stockRemaining).toBeNull();
    expect(store.bumpMetric).toHaveBeenCalledWith(SALE_ID, 'SALE_NOT_STARTED');
  });
});

describe('PurchaseService.purchase — the §8.4 enqueue-failure (I4) path', () => {
  it('enqueues exactly once on the happy path', async () => {
    const store = makeStore(confirmedResult());
    const queue = makeQueue('ok');
    const service = makeService({ store, queue });

    const decision = await service.purchase(USER_ID, REQUEST_ID);

    expect(queue.enqueue).toHaveBeenCalledTimes(1);
    expect(queue.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        saleId: SALE_ID,
        userId: USER_ID,
        reservationId: 'reservation-1',
        reservedAtMs: 1_700_000_000_500,
        requestId: REQUEST_ID,
      }),
    );
    expect(decision.outcome).toBe('CONFIRMED');
  });

  it('retries exactly once when the first enqueue attempt fails, and still returns CONFIRMED on the retry succeeding', async () => {
    const store = makeStore(confirmedResult());
    const queue = makeQueue('fails-once');
    const service = makeService({ store, queue });

    const decision = await service.purchase(USER_ID, REQUEST_ID);

    expect(queue.enqueue).toHaveBeenCalledTimes(2);
    expect(decision.outcome).toBe('CONFIRMED');
  });

  it(
    'THE I4 INVARIANT: both enqueue attempts failing still returns CONFIRMED (-> 201) — never 503, ' +
      'never a synthesized failure, because the reservation is real and already committed by Lua',
    async () => {
      const store = makeStore(
        confirmedResult({ stockRemaining: 4, reservationId: 'reservation-42' }),
      );
      const queue = makeQueue('always-fails');
      const service = makeService({ store, queue });

      const decision = await service.purchase(USER_ID, REQUEST_ID);

      expect(queue.enqueue).toHaveBeenCalledTimes(2);
      expect(decision.outcome).toBe('CONFIRMED');
      expect(PURCHASE_OUTCOME_HTTP_STATUS[decision.outcome]).toBe(201);
      expect(decision.stockRemaining).toBe(4);
      // §8.4 point 2: the API must NEVER compensate on an enqueue failure — proven at
      // this layer by the simple fact that nothing resembling a compensate call exists
      // anywhere in PurchaseService; the real "never tears down a live reservation"
      // guarantee is asserted against real Redis by the integration suite (§11.7).
    },
  );

  it('does not enqueue at all for a non-CONFIRMED outcome', async () => {
    const store = makeStore({
      outcome: 'SOLD_OUT',
      stockRemaining: 0,
      serverTimeMs: 1,
      reservationId: null,
    });
    const queue = makeQueue('ok');
    const service = makeService({ store, queue });

    await service.purchase(USER_ID, REQUEST_ID);

    expect(queue.enqueue).not.toHaveBeenCalled();
  });
});
