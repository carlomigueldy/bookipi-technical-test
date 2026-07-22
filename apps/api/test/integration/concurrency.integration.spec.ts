// apps/api/test/integration/concurrency.integration.spec.ts  [SLICE E]
// THE MONEY TEST — contract §11.3. PRD §6.1's concurrency spec through the FULL HTTP
// stack: 500 genuinely parallel POST /api/purchase over real sockets, stock=10.
import { randomUUID } from 'node:crypto';

import { saleKeys } from '@flash/shared';
import { purchaseResponseSchema } from '@flash/shared/schemas';
import Redis from 'ioredis';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import { type AppHarness, bootHarness } from '../support/app-harness.js';
import { closeHttpAgent, post } from '../support/http.js';
import { resetSale, seedSale } from '../support/seed.js';
import { buildOrdersJobId } from '../../src/queue/orders-queue.service.js';

const N_REQUESTS = 500;
const STOCK = 10;
const ITERATIONS = 3;

/**
 * Rate limiting during this test — the honest approach, pinned (contract §11.3). The
 * 500 requests originate from one process and therefore one source IP; at the
 * PRODUCTION limit of 20/s the limiter would 429 the other 480 and the test would
 * prove nothing. FORBIDDEN: disabling the plugin, skipping the guard, an
 * `NODE_ENV`-conditional branch anywhere in `src/**`. PINNED instead: raise the
 * numeric threshold via env far above the test's arrival rate — the plugin and the
 * guard are still registered and still traversed by every one of the 500 requests.
 */
const RAISED_LIMIT_ENV = {
  RATE_LIMIT_MAX: '100000',
  RATE_LIMIT_USER_MAX: '100000',
};

describe('THE MONEY TEST — 500 concurrent purchases, stock=10, through HTTP', () => {
  let harness: AppHarness;

  beforeEach(async () => {
    harness = await bootHarness({ env: RAISED_LIMIT_ENV });
  });

  afterEach(async () => {
    await harness.close();
  });

  afterAll(async () => {
    await closeHttpAgent();
  });

  it(`runs the scenario ${ITERATIONS} times, each time exactly 10 CONFIRMED / 490 SOLD_OUT / 0 other`, async () => {
    const raw = new Redis(harness.redisUrl, { connectionName: 'flash-api-money-test' });
    try {
      for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
        // Contract §11.3: "repeat: the whole scenario 3x in one spec run, RESETTING
        // between iterations." The app's purchase route always operates on its own
        // fixed `env.SALE_ID` (contract §10.1 point 2 — "saleId is always
        // env.SALE_ID", not something a request/test can redirect), so this harness
        // instance's ONE `env.SALE_ID` (= `harness.saleId`) is the ONLY saleId real
        // purchases can ever land against for its whole lifetime. A per-iteration
        // DISTINCT saleId (the original, buggy form of this test) seeds fresh stock
        // under a key the app never actually reads, while every purchase keeps
        // hitting iteration 0's now-depleted `harness.saleId` — hence "reset", not
        // "reseed under a new key", is what the contract text actually specifies.
        const saleId = harness.saleId;
        await resetSale(harness.store, saleId);
        await seedSale(harness.store, {
          saleId,
          stock: STOCK,
          startsInMs: -60_000,
          endsInMs: 600_000,
        });

        const userIds = Array.from(
          { length: N_REQUESTS },
          (_, i) => `money-${iteration}-${i}-${randomUUID()}`,
        );

        // Genuinely parallel: Promise.all over N_REQUESTS independent undici requests
        // against 128 real sockets — not a loop with awaits, which would serialize
        // the arrivals and prove nothing about concurrency.
        const responses = await Promise.all(
          userIds.map((userId) =>
            post(`${harness.baseUrl}/api/purchase`, { body: { userId } }).then((res) => ({
              userId,
              res,
            })),
          ),
        );

        let confirmed = 0;
        let soldOut = 0;
        let other = 0;
        const confirmedUserIds: string[] = [];
        const confirmedStockValues: number[] = [];
        let sawRateLimitHeader = false;
        let responsesWithConsumedBudget = 0;

        for (const { userId, res } of responses) {
          const parsed = purchaseResponseSchema.parse(res.body);

          const limitHeader = res.headers['x-ratelimit-limit'];
          const remainingHeader = res.headers['x-ratelimit-remaining'];
          if (String(limitHeader) === '100000') sawRateLimitHeader = true;
          if (remainingHeader !== undefined && Number(remainingHeader) < 100000) {
            responsesWithConsumedBudget += 1;
          }

          if (res.status === 201 && parsed.status === 'CONFIRMED') {
            confirmed += 1;
            confirmedUserIds.push(userId);
            expect(parsed.stockRemaining).not.toBeNull();
            confirmedStockValues.push(parsed.stockRemaining as number);
          } else if (res.status === 410 && parsed.status === 'SOLD_OUT') {
            soldOut += 1;
          } else {
            other += 1;
          }
        }

        expect({ iteration, confirmed, soldOut, other }).toEqual({
          iteration,
          confirmed: STOCK,
          soldOut: N_REQUESTS - STOCK,
          other: 0,
        });

        // PROOF the limiter was actually in the path (contract §11.3) — a bypassed
        // limiter emits none of these headers, so this assertion would fail loudly.
        expect(sawRateLimitHeader).toBe(true);
        expect(responsesWithConsumedBudget).toBeGreaterThanOrEqual(490);

        // I1 — no oversell, ever negative.
        const finalStock = await harness.store.status(saleId);
        expect(finalStock.stockRemaining).toBe(0);

        // I2 — exactly the 10 confirmed userIds hold the buyers set, and only them.
        const keys = saleKeys(saleId);
        const buyers = await raw.smembers(keys.buyers);
        expect(buyers.sort()).toEqual([...confirmedUserIds].sort());
        expect(new Set(confirmedUserIds).size).toBe(STOCK);

        // The 10 CONFIRMED stockRemaining values are the distinct set {0,...,9}.
        expect([...confirmedStockValues].sort((a, b) => a - b)).toEqual(
          Array.from({ length: STOCK }, (_, i) => i),
        );

        // I4 — the reservations ledger has exactly 10 distinct, non-empty entries.
        const reservationsCount = await raw.hlen(keys.reservations);
        expect(reservationsCount).toBe(STOCK);
        const reservationEntries: Record<string, string> = await raw.hgetall(keys.reservations);
        const reservationIds = Object.values(reservationEntries).map((v) => v.split(':')[0] ?? '');
        expect(new Set(reservationIds).size).toBe(STOCK);
        expect(reservationIds.every((id) => id.length > 0)).toBe(true);

        // I4 — BullMQ waiting+active jobs === 10, jobIds === buildOrdersJobId(saleId, userId)
        // exactly, SCOPED TO THIS ITERATION: Phase 2 defines no worker/consumer (§0.1 —
        // draining the queue is Phase 3), so jobs from earlier iterations in this same
        // `it()` (same fixed `saleId` — see the "reset, not reseed" comment above) are
        // still sitting in `waiting`/`active` and would otherwise inflate this count.
        // Every userId in this iteration is generated with an iteration-tagged prefix
        // (`money-${iteration}-...`), so filtering the full jobId on that substring
        // isolates exactly this iteration's own jobs without loosening the
        // exact-count/exact-set assertion.
        const jobIdIterationTag = `-money-${iteration}-`;
        const observedJobIds = await harness.queueObserver.listJobIds(['waiting', 'active']);
        const jobIds = new Set(observedJobIds.filter((id) => id.includes(jobIdIterationTag)));
        expect(jobIds.size).toBe(STOCK);
        const expectedJobIds = new Set(confirmedUserIds.map((u) => buildOrdersJobId(saleId, u)));
        expect(jobIds).toEqual(expectedJobIds);
      }
    } finally {
      raw.disconnect();
    }
  });
});
