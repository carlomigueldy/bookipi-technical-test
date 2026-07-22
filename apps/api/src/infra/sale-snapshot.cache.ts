/**
 * `SaleSnapshotCache` — frozen contract §5.4.
 *
 * Holds the last successful `SaleSnapshot` and the wall-clock time it was
 * received, written by `RedisAnchoredClock`'s own sync tick (`clock.service.ts`
 * — "refreshed by the clock timer", per this file's own tree annotation in
 * §2.1) — NOT by a separate polling loop of its own. That is what makes the
 * clock offset and the guard's window come from ONE Redis round trip every
 * `CLOCK_SYNC_INTERVAL_MS`, not two.
 *
 * Consumers (contract §5.4):
 *  - `PurchaseService`'s fast-path guard reads `startsAtMs` / `endsAtMs`.
 *    NEVER `stockRemaining` — a cached stock value is exactly how you
 *    oversell, and stock is Lua's business alone.
 *  - `HealthService` reads `initialized`.
 *  - `SaleController` does NOT read this cache — `GET /api/sale/status`
 *    performs a live `store.status()` call per request (§6.1).
 */
import { Injectable } from '@nestjs/common';
import type { SaleSnapshot } from '@flash/redis';

export interface SaleSnapshotEntry {
  snapshot: SaleSnapshot;
  ageMs: number;
}

@Injectable()
export class SaleSnapshotCache {
  private state: { snapshot: SaleSnapshot; receivedAtMs: number } | null = null;

  /** Called by `RedisAnchoredClock` after each successful sync tick. */
  update(snapshot: SaleSnapshot, receivedAtMs: number): void {
    this.state = { snapshot, receivedAtMs };
  }

  /** `null` before the first successful sync has ever landed. */
  get(): SaleSnapshotEntry | null {
    if (!this.state) return null;
    return { snapshot: this.state.snapshot, ageMs: Date.now() - this.state.receivedAtMs };
  }
}
