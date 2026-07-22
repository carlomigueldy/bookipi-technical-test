// apps/api/test/support/unsafe-purchase.service.ts  [SLICE E — frozen contract §11.4]
//
// THE NEGATIVE CONTROL (Phase 1 T2 precedent, restated in contract §11.4). A
// deliberately non-atomic re-implementation of the purchase decision: GET stock ->
// yield the event loop -> DECR stock -> SADD buyers. No Lua, no window check — this
// isolates I1/I2 atomicity, the exact race `purchase.lua`'s single EVAL makes
// impossible. `concurrency-negative-control.integration.spec.ts` swaps this in for the
// real `PurchaseService` via `.overrideProvider(PurchaseService)
// .useClass(UnsafePurchaseService)` and asserts the IDENTICAL 500-parallel scenario
// OVERSELLS. If it doesn't, §11.3's "money test" has no discriminating power and its
// green is meaningless.
//
// MUST NEVER be importable from `apps/api/src/**` — `rg -n "unsafe" apps/api/src/`
// must return zero hits (contract §11.4, §12 grep gate). Living under `test/support/**`
// makes that structurally true, not just a convention.
//
// ---------------------------------------------------------------------------------
// CONTRACT GAP (flagged, not silently resolved — see this slice's completion report).
// §11.4 requires this class to "implement the same PurchaseService interface" but the
// frozen contract pins `PurchaseService`'s *behavior* (§8.1's 9-step table), never its
// TypeScript method name/signature — that is Slice C's implementation detail. This
// class exposes `purchase(userId: string): Promise<UnsafePurchaseResult>`, mirroring
// `@flash/redis`'s own `SaleRedisStore.purchase(saleId, userId)` naming (§8.1 step 6
// delegates straight to `store.purchase(...)`, so the same method name on the service
// wrapping it is the natural reading). `.overrideProvider(...).useClass(...)` is
// runtime substitution — Nest does not structurally check `UnsafePurchaseService`
// against `PurchaseService`'s shape at compile time — so this is a best-effort,
// documented assumption a mechanical rename can fix at merge time if Slice C's real
// method differs, not a redesign.
//
// Minor contract-text note: §11.4 says "four round trips" but lists three Redis
// operations (GET, DECR, SADD) plus one JS-level event-loop yield. Implemented exactly
// as literally named, in order — no extra round trip invented to make the count match.
import { randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import { saleKeys, type PurchaseOutcome } from '@flash/shared';
import type { Redis } from 'ioredis';

import { API_ENV, REDIS_STORE_CLIENT } from '../../src/common/tokens.js';
import type { ApiEnv } from '../../src/config/env.js';

export interface UnsafePurchaseResult {
  outcome: PurchaseOutcome;
  stockRemaining: number;
  serverTimeMs: number;
  reservationId: string | null;
}

@Injectable()
export class UnsafePurchaseService {
  private positiveReaders = 0;
  private releaseRace!: () => void;
  private readonly raceGate = new Promise<void>((resolve) => {
    this.releaseRace = resolve;
  });

  constructor(
    @Inject(REDIS_STORE_CLIENT) private readonly redis: Redis,
    @Inject(API_ENV) private readonly env: ApiEnv,
  ) {}

  /**
   * Deliberately non-atomic, deliberately no window check — this control isolates I1
   * (oversell) and I2 (double-purchase) atomicity only.
   */
  async purchase(userId: string): Promise<UnsafePurchaseResult> {
    const keys = saleKeys(this.env.SALE_ID);

    // 1. GET stock
    const rawStock = await this.redis.get(keys.stock);
    const stock = rawStock === null ? -1 : Number(rawStock);

    // 2. Yield the event loop — the race window named in the frozen contract.
    await new Promise((resolve) => setTimeout(resolve, 0));

    if (stock <= 0) {
      return {
        outcome: 'SOLD_OUT',
        stockRemaining: 0,
        serverTimeMs: Date.now(),
        reservationId: null,
      };
    }

    // Make the negative control deterministic under fast local Redis too. The
    // money test seeds stock=10, so releasing only after 11 positive GET snapshots
    // guarantees at least one oversell. A bare zero-delay yield occasionally let
    // Redis serialize GET/DECR pairs closely enough that the intentionally unsafe
    // implementation appeared correct, making the control itself flaky.
    this.positiveReaders += 1;
    if (this.positiveReaders >= 11) this.releaseRace();
    await this.raceGate;

    // 3. DECR stock
    const newStock = await this.redis.decrby(keys.stock, 1);
    // 4. SADD buyers
    await this.redis.sadd(keys.buyers, userId);

    return {
      outcome: 'CONFIRMED',
      stockRemaining: newStock,
      serverTimeMs: Date.now(),
      reservationId: randomUUID(),
    };
  }
}
