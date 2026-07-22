// apps/api/test/support/seed.ts  [SLICE E — frozen contract §11.3, §11.5]
//
// Seeds a sale relative to REDIS's OWN clock, never the test process's `Date.now()`.
// Window-edge and concurrency assertions are a RELATION between the response's
// `serverTimeMs` and the seeded bound (contract §11.5) — exact and race-free — so the
// seed itself must be anchored to the same clock `purchase.lua`/`status.lua` judge by.
// A `status()` call against a not-yet-seeded saleId still returns Redis's `TIME` (see
// `SaleRedisStore.status`'s `initialized: false` branch), which is what makes reading
// "Redis's now" before seeding possible without a throwaway extra round trip.
import { randomUUID } from 'node:crypto';

import { SaleRedisStore } from '@flash/redis';
import { SALE_ID_PATTERN } from '@flash/shared';

/** `t-<12 hex chars>` — always matches SALE_ID_PATTERN, always unique per spec/case. */
export function uniqueSaleId(): string {
  const id = `t-${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  if (!SALE_ID_PATTERN.test(id)) {
    // Defensive: only possible if SALE_ID_PATTERN changes underneath this helper.
    throw new Error(`seed.uniqueSaleId produced an id that fails SALE_ID_PATTERN: '${id}'`);
  }
  return id;
}

/** Redis's own `TIME`, read via the `status.lua` path — the one clock every window assertion is anchored to. */
export async function redisNowMs(store: SaleRedisStore, saleId: string): Promise<number> {
  const snapshot = await store.status(saleId);
  return snapshot.serverTimeMs;
}

export interface SeedOptions {
  /** Defaults to a fresh `uniqueSaleId()`. */
  saleId?: string;
  stock: number;
  name?: string;
  /** ms relative to Redis's OWN clock at seed time. Default: -60_000 (already open). */
  startsInMs?: number;
  /** ms relative to Redis's OWN clock at seed time. Default: +600_000 (open 10 min). */
  endsInMs?: number;
}

export interface SeededSale {
  saleId: string;
  startsAtMs: number;
  endsAtMs: number;
  /** Redis's `TIME` at the moment this seed's window was computed, in ms. */
  redisNowMsAtSeed: number;
}

/** Seeds a sale whose window is positioned relative to Redis's own clock at seed time. */
export async function seedSale(store: SaleRedisStore, options: SeedOptions): Promise<SeededSale> {
  const saleId = options.saleId ?? uniqueSaleId();
  const now = await redisNowMs(store, saleId);
  const startsAtMs = now + (options.startsInMs ?? -60_000);
  const endsAtMs = now + (options.endsInMs ?? 600_000);

  await store.seed({
    saleId,
    name: options.name ?? `Integration test sale (${saleId})`,
    startsAt: new Date(startsAtMs).toISOString(),
    endsAt: new Date(endsAtMs).toISOString(),
    totalStock: options.stock,
  });

  return { saleId, startsAtMs, endsAtMs, redisNowMsAtSeed: now };
}

/**
 * DELs one sale's keys. TEST-ONLY — `SaleRedisStore.reset` is unreachable from any HTTP
 * route in any phase (contract §6.3/§10.5); this call only ever happens from this
 * support file, never from `apps/api/src/**`.
 */
export async function resetSale(store: SaleRedisStore, saleId: string): Promise<void> {
  await store.reset(saleId);
}

/**
 * Polls `status()` until Redis's own clock reports `serverTimeMs >= targetMs`, used by
 * the "1ms after end" window-edge case (contract §11.5) instead of a wall-clock sleep —
 * the poll condition IS the same clock reading the purchase attempt will be judged by.
 */
export async function waitUntilRedisClockReaches(
  store: SaleRedisStore,
  saleId: string,
  targetMs: number,
  { pollIntervalMs = 25, timeoutMs = 10_000 }: { pollIntervalMs?: number; timeoutMs?: number } = {},
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const now = await redisNowMs(store, saleId);
    if (now >= targetMs) return now;
    if (Date.now() > deadline) {
      throw new Error(
        `waitUntilRedisClockReaches: Redis clock did not reach ${targetMs} within ${timeoutMs}ms (last seen ${now})`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
}
