// apps/api/src/purchase/purchase.service.ts  [SLICE C — frozen contract §8.1, §8.4]
//
// The hot path. Guard order (§8.1, steps 5-9) is normative:
//   5. fast-path window guard (no Redis call when it can safely reject)
//   6. store.purchase() — the ONE round trip that decides CONFIRMED / SOLD_OUT /
//      ALREADY_PURCHASED / SALE_NOT_STARTED / SALE_ENDED / NOT_INITIALIZED
//   7. on CONFIRMED: await the enqueue (with the §8.4 retry-once-then-still-201 policy)
//   8. bumpMetric — fire-and-forget, never awaited, never allowed to throw
//   9. build the frozen envelope; the controller sets the HTTP status from
//      PURCHASE_OUTCOME_HTTP_STATUS
//
// Step 6 is THE invariant this file must never violate: a caught Redis error is
// UPSTREAM_UNAVAILABLE, full stop. Synthesizing any other outcome from a Redis
// exception would risk an oversell (the request may have executed server-side) and
// would hide an outage as a business answer.
//
// PUBLIC METHOD SHAPE — deliberately minimal, deliberately swap-compatible.
// `purchase()` returns the bare decision (`{ outcome, stockRemaining, serverTimeMs,
// reservationId }`) rather than a finished HTTP envelope; `PurchaseController` (which
// is NEVER swapped) owns turning that into `PURCHASE_OUTCOME_HTTP_STATUS` +
// `buildPurchaseEnvelope`. This is not cosmetic: the frozen contract's negative
// control (§11.4, a deliberately non-atomic stand-in under `test/support/`) works by
// overriding this provider with the stand-in and driving the SAME real HTTP route —
// its documented, best-effort assumption is a method mirroring
// `SaleRedisStore.purchase(saleId, userId)`'s own shape. Building the HTTP envelope
// inside this class would mean the swapped-in stand-in implementation returns a shape
// the controller cannot render, turning every request into a 500 and hiding the very
// oversell the negative control exists to prove — a plumbing bug masquerading as "the
// harness has no discriminating power". Keeping the seam this thin is what makes the
// swap transparent.
import { Inject, Injectable, Logger } from '@nestjs/common';

import type { PurchaseResult, SaleRedisStore } from '@flash/redis';
import type { AttemptOutcome } from '@flash/shared';
import type { PurchaseResponse } from '@flash/shared/schemas';

import { messageFor } from '../common/messages.js';
import { API_ENV, CLOCK, SALE_REDIS_STORE, SALE_SNAPSHOT_CACHE } from '../common/tokens.js';
import type { ApiEnv } from '../config/env.js';
import type { Clock } from '../infra/clock.service.js';
import type { SaleSnapshotCache } from '../infra/sale-snapshot.cache.js';
import { OrdersQueueService } from '../queue/orders-queue.service.js';

/** Outcome + the clock reading that judged it, returned by the §5.5 fast-path guard. */
export interface FastPathGuardResult {
  outcome: 'SALE_NOT_STARTED' | 'SALE_ENDED';
  nowMs: number;
}

/**
 * §5.5, verbatim. `guardEnabled` requires ALL of: the clock's own offset is fresh,
 * the snapshot cache has a value, that snapshot is `initialized`, and the cache entry
 * itself is not stale relative to `CLOCK_MAX_STALENESS_MS`. Inside the asymmetric skew
 * margin the guard is silent — every request in the boundary neighbourhood is
 * unconditionally delegated to `purchase.lua`, which is what makes a false negative
 * structurally impossible (§5.5's proof).
 *
 * Exported standalone (not a private method) so it is unit-testable without booting a
 * `PurchaseService` instance — pure function of its four inputs, no I/O.
 */
export function evaluateFastPathGuard(
  clock: Pick<Clock, 'isFresh' | 'nowMs' | 'rttMs'>,
  cache: Pick<SaleSnapshotCache, 'get'>,
  env: Pick<ApiEnv, 'CLOCK_GUARD_SKEW_MS' | 'CLOCK_MAX_STALENESS_MS'>,
): FastPathGuardResult | null {
  if (!clock.isFresh()) return null;

  const cached = cache.get();
  if (!cached || !cached.snapshot.initialized) return null;
  if (cached.ageMs > env.CLOCK_MAX_STALENESS_MS) return null;

  const skew = Math.max(env.CLOCK_GUARD_SKEW_MS, 4 * clock.rttMs());
  const nowMs = clock.nowMs();
  const { startsAtMs, endsAtMs } = cached.snapshot;

  if (nowMs < startsAtMs - skew) {
    return { outcome: 'SALE_NOT_STARTED', nowMs };
  }
  if (nowMs >= endsAtMs + skew) {
    return { outcome: 'SALE_ENDED', nowMs };
  }
  return null;
}

/**
 * Builds the ONE envelope every outcome (success and failure alike) responds with
 * (§6.4). Pure and standalone so `PurchaseController` can call it regardless of which
 * `PurchaseService`-shaped provider produced the decision.
 */
export function buildPurchaseEnvelope(params: {
  outcome: AttemptOutcome;
  userId: string;
  saleId: string;
  stockRemaining: number | null;
  serverTimeMs: number;
}): PurchaseResponse {
  return {
    status: params.outcome,
    message: messageFor(params.outcome),
    userId: params.userId,
    saleId: params.saleId,
    stockRemaining: params.stockRemaining,
    serverTime: new Date(params.serverTimeMs).toISOString(),
    serverTimeMs: params.serverTimeMs,
  };
}

/**
 * The bare purchase decision — deliberately the SAME shape as `@flash/redis`'s
 * `PurchaseResult`, widened to the full `AttemptOutcome` vocabulary only because this
 * layer (unlike `store.purchase` itself) can also produce `UPSTREAM_UNAVAILABLE` (a
 * caught Redis error) and the two fast-path-guard outcomes. No `httpStatus`, no
 * `saleId`, no `message` — see the file header for why the seam is kept this thin.
 */
export interface PurchaseDecision {
  outcome: AttemptOutcome;
  stockRemaining: number | null;
  serverTimeMs: number;
  reservationId: string | null;
}

@Injectable()
export class PurchaseService {
  private readonly logger = new Logger(PurchaseService.name);

  constructor(
    @Inject(SALE_REDIS_STORE) private readonly store: SaleRedisStore,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(SALE_SNAPSHOT_CACHE) private readonly snapshotCache: SaleSnapshotCache,
    @Inject(API_ENV) private readonly env: ApiEnv,
    private readonly ordersQueue: OrdersQueueService,
  ) {}

  /**
   * Entry point for `POST /api/purchase`. Never throws — every branch returns a
   * decision the controller can render. Mirrors `SaleRedisStore.purchase(saleId,
   * userId)`'s own two-argument-in / decision-out shape by design (see file header).
   */
  async purchase(userId: string, requestId: string): Promise<PurchaseDecision> {
    const saleId = this.env.SALE_ID;

    const guard = evaluateFastPathGuard(this.clock, this.snapshotCache, this.env);
    if (guard) {
      void this.store.bumpMetric(saleId, guard.outcome);
      return {
        outcome: guard.outcome,
        stockRemaining: null,
        serverTimeMs: guard.nowMs,
        reservationId: null,
      };
    }

    let result: PurchaseResult;
    try {
      result = await this.store.purchase(saleId, userId);
    } catch (err) {
      // THE INVARIANT (§8.1 step 6): a Redis exception is UPSTREAM_UNAVAILABLE and
      // nothing else. Never synthesize CONFIRMED/SOLD_OUT/etc from a caught error.
      this.logger.error(
        { err: err instanceof Error ? err.message : String(err), saleId, userId, requestId },
        'purchase.upstream_unavailable',
      );
      return {
        outcome: 'UPSTREAM_UNAVAILABLE',
        stockRemaining: null,
        serverTimeMs: this.clock.nowMs(),
        reservationId: null,
      };
    }

    if (result.outcome === 'CONFIRMED') {
      // Awaited BEFORE the response is built (§8.1 step 7) — the only window left open
      // is the one Lua itself created (reservation committed, ack not yet delivered),
      // which §8.4's reservations-ledger recovery path exists to close in Phase 3.
      await this.enqueueConfirmedOrder(
        {
          saleId,
          userId,
          reservationId: result.reservationId ?? '',
          reservedAtMs: result.serverTimeMs,
          requestId,
        },
        requestId,
      );
    }

    // Fire-and-forget; @flash/redis's bumpMetric already swallows its own errors.
    void this.store.bumpMetric(saleId, result.outcome);

    const stockRemaining = result.outcome === 'NOT_INITIALIZED' ? null : result.stockRemaining;
    return {
      outcome: result.outcome,
      stockRemaining,
      serverTimeMs: result.serverTimeMs,
      reservationId: result.reservationId,
    };
  }

  /**
   * §8.4 / A4 — the I4 hazard. `OrdersQueueService` owns the finite producer
   * deadline and hard cancellation. A rejection is retried EXACTLY ONCE with the identical payload (same
   * `jobId` at the `OrdersQueueService` layer, so a landed-but-unacked first attempt
   * makes the retry a BullMQ no-op). If both attempts fail the purchase still stands:
   * the reservation is real, Lua already committed it, and the API must never
   * compensate on the mere suspicion the job didn't land — that is precisely Phase 1
   * finding 1 (compensating a live reservation) reintroduced at the API layer. The
   * durable recovery path is the reservations ledger `purchase.lua` wrote atomically;
   * Phase 3's boot sweep reconciles it. This method therefore NEVER throws and NEVER
   * flips the outcome — its only externally visible effect on double failure is the
   * `purchase.enqueue_failed` error log, which MUST carry `reservationId` for that
   * sweep / a manual reconciliation to key on.
   */
  private async enqueueConfirmedOrder(
    payload: {
      saleId: string;
      userId: string;
      reservationId: string;
      reservedAtMs: number;
      requestId: string;
    },
    requestId: string,
  ): Promise<void> {
    const attempt = () => this.ordersQueue.enqueue(payload);

    try {
      await attempt();
      return;
    } catch {
      // First attempt failed (rejection or timeout) — retry exactly once, immediately.
    }

    try {
      await attempt();
    } catch (err) {
      this.logger.error(
        {
          saleId: payload.saleId,
          userId: payload.userId,
          reservationId: payload.reservationId,
          reservedAtMs: payload.reservedAtMs,
          requestId,
          attempts: 2,
          err: err instanceof Error ? err.message : String(err),
        },
        'purchase.enqueue_failed',
      );
    }
  }
}
