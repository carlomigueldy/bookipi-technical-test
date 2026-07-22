/**
 * `RedisAnchoredClock` — resolution of Phase 1 open issue 2, frozen contract §5.
 *
 * Two different `now`s, pinned separately (§5.1):
 *  (a) `serverTime` in a response that reached Lua is ALWAYS Lua's own
 *      `TIME` (`purchase.lua` / `status.lua` already return it) — zero
 *      drift, nothing this class does. That is built directly into
 *      `PurchaseResult.serverTimeMs` / `SaleSnapshot.serverTimeMs`
 *      (`@flash/redis`), consumed by `SaleService` / `PurchaseService`
 *      (Slices B/C), not by this file.
 *  (b) Everywhere else — the fast-path window guard, `ApiErrorResponse`s,
 *      the readiness probe — uses THIS class: a Redis-anchored,
 *      periodically-refreshed in-memory offset (Cristian's algorithm,
 *      minimum-RTT of the last 5 samples).
 *
 * `onModuleInit` performs the bounded initial sync (§5.2's "await one
 * successful sync before `app.listen(...)`" requirement) as a normal Nest
 * lifecycle hook — `NestFactory.create()` awaits every provider's
 * `onModuleInit` before returning, so `main.ts` needs no special
 * orchestration to get this property; it falls out of using the hook Nest
 * already provides for exactly this purpose.
 */
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import type { SaleRedisStore } from '@flash/redis';

import { API_ENV, SALE_REDIS_STORE, SALE_SNAPSHOT_CACHE } from '../common/tokens.js';
import type { ApiEnv } from '../config/env.js';
import { SaleSnapshotCache } from './sale-snapshot.cache.js';

/** §5.1(b) — the frozen interface. Exactly these five methods; no more. */
export interface Clock {
  nowMs(): number;
  offsetMs(): number;
  /** RTT of the sample the current offset came from. */
  rttMs(): number;
  /** ms since the last successful sync. */
  ageMs(): number;
  /** `ageMs() <= CLOCK_MAX_STALENESS_MS`. */
  isFresh(): boolean;
}

/** §5.2 — backoff schedule for the bounded initial sync: 100/200/400/800ms, then every 1s. */
const INITIAL_BACKOFF_SCHEDULE_MS = [100, 200, 400, 800] as const;
const INITIAL_RETRY_INTERVAL_MS = 1000;
/** §5.2 — "for up to 10s; after that the process starts anyway". */
const INITIAL_SYNC_BUDGET_MS = 10_000;
/** §5.2 — keep the sample with the LOWEST rtt of the last 5, not an average. */
const RTT_SAMPLE_WINDOW = 5;

interface ClockSample {
  offsetMs: number;
  rttMs: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    // Never holds the process open by itself — mirrors the periodic sync
    // timer's own `.unref()` discipline a few lines down.
    timer.unref?.();
  });
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

@Injectable()
export class RedisAnchoredClock implements Clock, OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(RedisAnchoredClock.name);
  private readonly samples: ClockSample[] = [];
  private best: ClockSample | null = null;
  private lastSyncAtMs: number | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    @Inject(SALE_REDIS_STORE) private readonly store: SaleRedisStore,
    @Inject(API_ENV) private readonly env: ApiEnv,
    @Inject(SALE_SNAPSHOT_CACHE) private readonly snapshotCache: SaleSnapshotCache,
  ) {}

  async onModuleInit(): Promise<void> {
    const deadline = Date.now() + INITIAL_SYNC_BUDGET_MS;
    let attempt = 0;
    let synced = false;

    while (Date.now() < deadline) {
      synced = await this.attemptSync();
      if (synced) break;
      const backoff = INITIAL_BACKOFF_SCHEDULE_MS[attempt] ?? INITIAL_RETRY_INTERVAL_MS;
      attempt += 1;
      await sleep(backoff);
    }

    if (!synced) {
      this.logger.warn(
        `initial Redis clock sync did not land within ${INITIAL_SYNC_BUDGET_MS}ms — ` +
          'starting with offsetMs=0 and isFresh()=false. The fast-path guard is disabled ' +
          'until the next sync succeeds; the readiness probe reports degraded meanwhile.',
      );
    }

    // Ongoing periodic sync, unbounded, `.unref()`d so it never holds the
    // process open on its own (§5.2's 5s interval).
    this.timer = setInterval(() => {
      void this.attemptSync();
    }, this.env.CLOCK_SYNC_INTERVAL_MS);
    this.timer.unref?.();
  }

  onApplicationShutdown(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * One `SaleRedisStore.status(SALE_ID)` call — the same round trip that
   * refreshes `SaleSnapshotCache` (§5.2/§5.4: "zero extra cost"). Cristian's
   * algorithm: `offset = serverTimeMs - (t0 + rtt/2)`.
   */
  private async attemptSync(): Promise<boolean> {
    const t0 = Date.now();
    let snapshot;
    try {
      snapshot = await this.store.status(this.env.SALE_ID);
    } catch (err) {
      this.logger.warn(`clock sync failed: ${describeError(err)}`);
      return false;
    }
    const t1 = Date.now();
    const rtt = t1 - t0;
    // `rtt / 2` is fractional whenever `rtt` is odd (e.g. 3ms -> 1.5ms),
    // which would make every downstream `nowMs()` a non-integer millisecond
    // — `serverTimeMs` is a frozen `z.int()` (safeint) field across every
    // response schema (`saleStatusResponseSchema`, `purchaseResponseSchema`,
    // `ApiErrorResponse`), so an unrounded offset silently corrupts every
    // response built from the fast-path guard / rate-limit envelope /
    // exception filter the very next time an odd-RTT sample becomes the
    // lowest-RTT sample. `Math.round` keeps millisecond precision (Cristian's
    // algorithm has no sub-millisecond meaning here anyway) and matches what
    // Lua's own integer `TIME`-derived `serverTimeMs` already is.
    const offset = Math.round(snapshot.serverTimeMs - (t0 + rtt / 2));

    this.samples.push({ offsetMs: offset, rttMs: rtt });
    if (this.samples.length > RTT_SAMPLE_WINDOW) this.samples.shift();

    let lowest = this.samples[0]!;
    for (const sample of this.samples) {
      if (sample.rttMs < lowest.rttMs) lowest = sample;
    }
    this.best = lowest;
    this.lastSyncAtMs = t1;

    this.snapshotCache.update(snapshot, t1);
    return true;
  }

  nowMs(): number {
    return Date.now() + this.offsetMs();
  }

  offsetMs(): number {
    return this.best?.offsetMs ?? 0;
  }

  rttMs(): number {
    return this.best?.rttMs ?? 0;
  }

  ageMs(): number {
    if (this.lastSyncAtMs === null) return Number.POSITIVE_INFINITY;
    return Date.now() - this.lastSyncAtMs;
  }

  isFresh(): boolean {
    return this.lastSyncAtMs !== null && this.ageMs() <= this.env.CLOCK_MAX_STALENESS_MS;
  }
}
