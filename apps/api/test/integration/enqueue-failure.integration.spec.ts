// apps/api/test/integration/enqueue-failure.integration.spec.ts  [SLICE E]
// The I4 enqueue-failure spec required verbatim by the frozen contract §11.7 (and
// referenced from §8.4): "with the queue client pointed at a dead Redis (or
// `queue.add` stubbed to reject), a purchase in an open window returns 201; SCARD
// buyers === 1; HGET reservations {userId} matches ^<uuid>:<digits>$; stock
// decremented by exactly 1; no compensation occurred; and the
// `purchase.enqueue_failed` log record contains `reservationId`."
//
// This was previously proven ONLY by `purchase.service.spec.ts`'s unit test with a
// hand-rolled `makeQueue('always-fails')` fake — useful for the control-flow claim
// ("CONFIRMED still returned after 2 failed attempts") but it never touched real
// Redis and never asserted the actual SADD/HSET/DECR side effects §11.7 requires.
// This spec closes that gap: it boots the REAL app, over REAL HTTP, against REAL
// Redis, and replaces only the producer service with an owned, awaited rejecting
// boundary while `purchase.lua` and the rate limiter keep working normally. This
// avoids force-disconnecting a shared live BullMQ/ioredis client while it may still
// own internal commands, which is exactly the lifecycle defect Amendment A3 forbids.
import { saleKeys } from '@flash/shared';
import { purchaseResponseSchema } from '@flash/shared/schemas';
import Redis from 'ioredis';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type AppHarness, bootHarness } from '../support/app-harness.js';
import { closeHttpAgent, post } from '../support/http.js';
import { seedSale } from '../support/seed.js';

/** `<reservationId(uuid)>:<reservedAtMs(digits)>` — the reservations-hash value shape (contract §11.7). */
const RESERVATION_ENTRY_PATTERN = /^([0-9a-f-]{36}):(\d+)$/i;

describe('POST /api/purchase — I4 enqueue-failure spec (contract §11.7 / §8.4)', () => {
  let harness: AppHarness;

  beforeEach(async () => {
    harness = await bootHarness();
  });

  afterEach(async () => {
    await harness.close();
  });

  afterAll(async () => {
    await closeHttpAgent();
  });

  it(
    'queue client pointed at a dead Redis -> 201 CONFIRMED; buyers/reservations/stock committed; ' +
      'no compensation; purchase.enqueue_failed log carries reservationId',
    async () => {
      const saleId = harness.saleId;
      await seedSale(harness.store, { saleId, stock: 5, startsInMs: -60_000, endsInMs: 600_000 });

      // Re-import AFTER `bootHarness()` has already run its own `vi.resetModules()` —
      // per `app-harness.ts`'s own documented rule, this resolves to the SAME
      // per-boot module instances `AppModule`/`PurchaseService` themselves saw within
      // this reset epoch, so `Logger.prototype` here is the identical prototype
      // `PurchaseService`'s `new Logger(...)` instance walks.
      const { Logger } = (await import('@nestjs/common')) as typeof import('@nestjs/common');
      const { OrdersQueueService } =
        (await import('../../src/queue/orders-queue.service.js')) as typeof import('../../src/queue/orders-queue.service.js');

      const errorSpy = vi.spyOn(Logger.prototype, 'error');

      const queueService =
        harness.get<import('../../src/queue/orders-queue.service.js').OrdersQueueService>(
          OrdersQueueService,
        );
      const enqueueSpy = vi
        .spyOn(queueService, 'enqueue')
        .mockRejectedValue(new Error('owned queue outage'));

      const userId = 'enqueue-failure-2026';
      const res = await post(`${harness.baseUrl}/api/purchase`, { body: { userId } });

      // The reservation is real even though the queue never heard about it (§8.4
      // point 2) — the API must NOT lie and return 503/failure here.
      expect(res.status).toBe(201);
      const parsed = purchaseResponseSchema.parse(res.body);
      expect(parsed.status).toBe('CONFIRMED');
      expect(parsed.stockRemaining).toBe(4);
      expect(enqueueSpy).toHaveBeenCalledTimes(2);

      // Independent connection, NOT the app's own clients, mirroring
      // `concurrency.integration.spec.ts`'s assertion pattern.
      const raw = new Redis(harness.redisUrl, { connectionName: 'flash-api-enqueue-failure-test' });
      try {
        const keys = saleKeys(saleId);

        // SCARD buyers === 1.
        const buyersCount = await raw.scard(keys.buyers);
        expect(buyersCount).toBe(1);
        const buyers = await raw.smembers(keys.buyers);
        expect(buyers).toEqual([userId]);

        // HGET reservations {userId} matches ^<uuid>:<digits>$.
        const reservationEntry = await raw.hget(keys.reservations, userId);
        expect(reservationEntry).not.toBeNull();
        const match = RESERVATION_ENTRY_PATTERN.exec(reservationEntry ?? '');
        expect(match).not.toBeNull();
        const [, reservationId] = match as RegExpExecArray;

        // Stock decremented by exactly 1 (seeded 5 -> 4), and — critically — it did
        // NOT bounce back: the API must never compensate on an enqueue failure
        // (§8.4 point 2; Phase 1 finding 1 is exactly this failure mode at the API
        // layer). Re-read status a second time to rule out an async compensation
        // racing this assertion.
        const statusNow = await harness.store.status(saleId);
        expect(statusNow.stockRemaining).toBe(4);
        await new Promise((resolve) => setTimeout(resolve, 50));
        const statusAfterDelay = await harness.store.status(saleId);
        expect(statusAfterDelay.stockRemaining).toBe(4);
        const buyersCountAfterDelay = await raw.scard(keys.buyers);
        expect(buyersCountAfterDelay).toBe(1);

        // The `purchase.enqueue_failed` log record contains `reservationId`, and it
        // is the SAME reservationId the ledger recorded — not an empty string, not a
        // stand-in.
        const enqueueFailedCalls = errorSpy.mock.calls.filter(
          (call) => call[1] === 'purchase.enqueue_failed',
        );
        expect(enqueueFailedCalls.length).toBeGreaterThan(0);
        const [logPayload] = enqueueFailedCalls[0] as [Record<string, unknown>, string];
        expect(logPayload.reservationId).toBe(reservationId);
        expect(logPayload.userId).toBe(userId);
        expect(logPayload.saleId).toBe(saleId);
        expect(logPayload.attempts).toBe(2);
      } finally {
        raw.disconnect();
      }
    },
  );
});
