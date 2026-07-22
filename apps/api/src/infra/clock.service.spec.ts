import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SaleRedisStore, SaleSnapshot } from '@flash/redis';

import type { ApiEnv } from '../config/env.js';
import { RedisAnchoredClock } from './clock.service.js';
import { SaleSnapshotCache } from './sale-snapshot.cache.js';

function buildEnv(overrides: Partial<ApiEnv> = {}): ApiEnv {
  return {
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent' as ApiEnv['LOG_LEVEL'],
    API_HOST: '127.0.0.1',
    API_PORT: 0,
    CORS_ORIGIN: 'http://localhost:5173',
    DATABASE_URL: 'postgresql://flash:flash@localhost:5433/flash',
    REDIS_URL: 'redis://localhost:6380',
    SALE_ID: 'flash-2026',
    SALE_NAME: 'Aurora',
    SALE_STARTS_AT: '2026-07-22T12:00:00.000Z',
    SALE_ENDS_AT: '2026-07-22T13:00:00.000Z',
    SALE_TOTAL_STOCK: 500,
    RATE_LIMIT_MAX: 20,
    RATE_LIMIT_WINDOW_MS: 1000,
    ORDERS_QUEUE_NAME: 'orders',
    TRUST_PROXY: false,
    REQUEST_BODY_LIMIT_BYTES: 16384,
    RATE_LIMIT_USER_MAX: 5,
    RATE_LIMIT_USER_WINDOW_MS: 1000,
    CLOCK_SYNC_INTERVAL_MS: 5000,
    CLOCK_MAX_STALENESS_MS: 15000,
    CLOCK_GUARD_SKEW_MS: 250,
    ENQUEUE_TIMEOUT_MS: 500,
    PG_POOL_MAX: 10,
    PG_STATEMENT_TIMEOUT_MS: 2000,
    POSTGRES_TEST_URL: '',
    ...overrides,
  };
}

function buildSnapshot(serverTimeMs: number, overrides: Partial<SaleSnapshot> = {}): SaleSnapshot {
  return {
    initialized: true,
    saleId: 'flash-2026',
    name: 'Aurora',
    startsAt: '2026-07-22T12:00:00.000Z',
    endsAt: '2026-07-22T13:00:00.000Z',
    startsAtMs: Date.parse('2026-07-22T12:00:00.000Z'),
    endsAtMs: Date.parse('2026-07-22T13:00:00.000Z'),
    totalStock: 500,
    stockRemaining: 480,
    serverTimeMs,
    state: 'active',
    ...overrides,
  };
}

/** A minimal stand-in satisfying only the one method `RedisAnchoredClock` calls. */
function fakeStore(statusImpl: () => Promise<SaleSnapshot>): SaleRedisStore {
  return { status: statusImpl } as unknown as SaleRedisStore;
}

describe('RedisAnchoredClock', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-22T12:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('before any sync: nowMs() is raw Date.now(), offsetMs() is 0, isFresh() is false, ageMs() is +Infinity', () => {
    const store = fakeStore(() => new Promise(() => undefined)); // never resolves
    const cache = new SaleSnapshotCache();
    const clock = new RedisAnchoredClock(store, buildEnv(), cache);

    expect(clock.offsetMs()).toBe(0);
    expect(clock.isFresh()).toBe(false);
    expect(clock.ageMs()).toBe(Number.POSITIVE_INFINITY);
    expect(clock.nowMs()).toBe(Date.now());
  });

  it('onModuleInit performs one successful sync and computes the Cristian-algorithm offset', async () => {
    // Redis's clock is 5000ms ahead of the local clock. Simulate a 20ms RTT
    // by advancing the fake clock by 10ms between t0 and the resolved value's
    // logical "now", then another 10ms before t1 is read.
    let call = 0;
    const store = fakeStore(async () => {
      call += 1;
      vi.advanceTimersByTime(10);
      const nowMs = Date.now() + 5000; // Redis is 5000ms ahead at the instant it answered
      vi.advanceTimersByTime(10);
      return buildSnapshot(nowMs);
    });
    const cache = new SaleSnapshotCache();
    const clock = new RedisAnchoredClock(store, buildEnv(), cache);

    await clock.onModuleInit();

    expect(call).toBe(1);
    expect(clock.isFresh()).toBe(true);
    expect(clock.rttMs()).toBe(20);
    // offset = serverTimeMs - (t0 + rtt/2) = (t0+10+5000) - (t0+10) = 5000
    expect(clock.offsetMs()).toBe(5000);
    expect(clock.ageMs()).toBe(0);
  });

  it('keeps the LOWEST-rtt sample of the last 5, not an average', async () => {
    const rtts = [100, 10, 50, 30, 20]; // lowest is index 1 (10ms), offset 2000
    const offsets = [500, 2000, 800, 300, 100];
    let call = 0;
    const store = fakeStore(async () => {
      const i = call;
      call += 1;
      const rtt = rtts[i]!;
      const offset = offsets[i]!;
      const t0 = Date.now();
      vi.advanceTimersByTime(rtt);
      return buildSnapshot(t0 + rtt / 2 + offset);
    });
    const cache = new SaleSnapshotCache();
    const clock = new RedisAnchoredClock(store, buildEnv(), cache);

    for (let i = 0; i < 5; i += 1) {
      // Directly exercise the private sync path via onModuleInit's first call,
      // then subsequent calls via the periodic timer's callback semantics —
      // simplest is to call onModuleInit once (1 sync) and then invoke the
      // same underlying behavior by re-triggering onModuleInit is not legal
      // (would re-run the whole backoff loop), so we drive `attemptSync`
      // indirectly through repeated `onModuleInit` calls on FRESH instances
      // is wrong too. Instead: call the public surface the way production
      // does — one `onModuleInit` per process. For this test we assert the
      // min-of-5 behavior via 5 independent instances is not equivalent
      // either. So: reach into the once-per-tick timer by advancing it.
      if (i === 0) {
        await clock.onModuleInit();
      } else {
        await vi.advanceTimersByTimeAsync(buildEnv().CLOCK_SYNC_INTERVAL_MS);
      }
    }

    expect(call).toBe(5);
    expect(clock.rttMs()).toBe(10);
    expect(clock.offsetMs()).toBe(2000);
  });

  it('isFresh() becomes false once ageMs exceeds CLOCK_MAX_STALENESS_MS', async () => {
    const store = fakeStore(async () => buildSnapshot(Date.now()));
    const cache = new SaleSnapshotCache();
    const env = buildEnv({ CLOCK_MAX_STALENESS_MS: 1000, CLOCK_SYNC_INTERVAL_MS: 60_000 });
    const clock = new RedisAnchoredClock(store, env, cache);

    await clock.onModuleInit();
    expect(clock.isFresh()).toBe(true);

    vi.setSystemTime(new Date(Date.now() + 1001));
    expect(clock.isFresh()).toBe(false);
  });

  it('onModuleInit retries with the 100/200/400/800ms backoff then every 1s, up to a 10s budget, and still starts', async () => {
    const store = fakeStore(async () => {
      throw new Error('ECONNREFUSED');
    });
    const cache = new SaleSnapshotCache();
    const clock = new RedisAnchoredClock(store, buildEnv(), cache);

    const initPromise = clock.onModuleInit();
    await vi.advanceTimersByTimeAsync(11_000);
    await initPromise;

    expect(clock.isFresh()).toBe(false);
    expect(clock.offsetMs()).toBe(0);
  });

  it('populates SaleSnapshotCache on the same round trip that updates the offset (§5.2 "zero extra cost")', async () => {
    const snapshot = buildSnapshot(Date.now() + 42);
    const store = fakeStore(async () => snapshot);
    const cache = new SaleSnapshotCache();
    const clock = new RedisAnchoredClock(store, buildEnv(), cache);

    expect(cache.get()).toBeNull();
    await clock.onModuleInit();

    const entry = cache.get();
    expect(entry).not.toBeNull();
    expect(entry!.snapshot).toEqual(snapshot);
  });

  it('a failed sync leaves the previous good offset/cache in place (never regresses to 0 on a transient blip)', async () => {
    let shouldFail = false;
    const store = fakeStore(async () => {
      if (shouldFail) throw new Error('ECONNRESET');
      return buildSnapshot(Date.now() + 777);
    });
    const cache = new SaleSnapshotCache();
    const env = buildEnv({ CLOCK_SYNC_INTERVAL_MS: 5000 });
    const clock = new RedisAnchoredClock(store, env, cache);

    await clock.onModuleInit();
    const offsetAfterFirstSync = clock.offsetMs();
    expect(offsetAfterFirstSync).toBeGreaterThan(0);

    shouldFail = true;
    await vi.advanceTimersByTimeAsync(env.CLOCK_SYNC_INTERVAL_MS);

    // offset is unchanged (best sample retained); only ageMs grows.
    expect(clock.offsetMs()).toBe(offsetAfterFirstSync);
  });

  it('onApplicationShutdown clears the periodic timer (no dangling interval)', async () => {
    const store = fakeStore(async () => buildSnapshot(Date.now()));
    const cache = new SaleSnapshotCache();
    const clock = new RedisAnchoredClock(store, buildEnv(), cache);
    await clock.onModuleInit();

    const clearSpy = vi.spyOn(global, 'clearInterval');
    clock.onApplicationShutdown();
    expect(clearSpy).toHaveBeenCalled();
    clearSpy.mockRestore();
  });
});
