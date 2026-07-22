// packages/redis/test/harness.ts
//
// Shared test utilities, frozen per .claude/contracts/phase-1.md §6.2.
//
// Isolation is by **unique sale id per spec/case**, never by FLUSHDB/FLUSHALL — a
// developer may point REDIS_TEST_URL at their own compose Redis on :6380, and a flush
// would nuke their working sale. Because ids never collide, `fileParallelism` stays
// enabled.
import { randomUUID } from 'node:crypto';

import Redis from 'ioredis';
import { inject } from 'vitest';

import { SaleRedisStore } from '../src/sale-store';
import type { SaleConfigInput } from '../src/types';
import { SALE_ID_PATTERN } from '@flash/shared';

/** `t-<12 hex chars>` — always matches SALE_ID_PATTERN, always unique. */
export function uniqueSaleId(): string {
  const id = `t-${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  if (!SALE_ID_PATTERN.test(id)) {
    // Defensive: this can only happen if SALE_ID_PATTERN changes underneath the harness.
    throw new Error(`harness.uniqueSaleId produced an id that fails SALE_ID_PATTERN: '${id}'`);
  }
  return id;
}

/** A fresh, independent ioredis connection against the injected test Redis. */
export function connect(): Redis {
  const url = inject('redisUrl');
  return new Redis(url, {
    connectionName: 'flash-redis-test',
    connectTimeout: 5000,
    commandTimeout: 5000,
    maxRetriesPerRequest: 2,
    enableReadyCheck: true,
    enableOfflineQueue: true,
    lazyConnect: false,
  });
}

/**
 * `n` independent connections, round-robined by callers over concurrent commands.
 * Used by the concurrency specs so the test harness itself cannot serialize the
 * workload client-side the way a single multiplexed connection would.
 */
export function connectMany(n: number): Redis[] {
  return Array.from({ length: n }, () => connect());
}

export interface SeedSaleOptions {
  /** Defaults to a fresh uniqueSaleId(). */
  saleId?: string;
  stock: number;
  name?: string;
}

async function seedWithWindow(
  store: SaleRedisStore,
  options: SeedSaleOptions,
  startsAtMs: number,
  endsAtMs: number,
  label: string,
): Promise<string> {
  const saleId = options.saleId ?? uniqueSaleId();
  const config: SaleConfigInput = {
    saleId,
    name: options.name ?? `Test sale (${label})`,
    startsAt: new Date(startsAtMs).toISOString(),
    endsAt: new Date(endsAtMs).toISOString(),
    totalStock: options.stock,
  };
  await store.seed(config);
  return saleId;
}

/** Seeds a sale whose window is already open and stays open for an hour. */
export async function seedActiveSale(
  store: SaleRedisStore,
  options: SeedSaleOptions,
): Promise<string> {
  const now = Date.now();
  return seedWithWindow(store, options, now - 60_000, now + 3_600_000, 'active');
}

/** Seeds a sale whose window has not opened yet. */
export async function seedFutureSale(
  store: SaleRedisStore,
  options: SeedSaleOptions,
): Promise<string> {
  const now = Date.now();
  return seedWithWindow(store, options, now + 3_600_000, now + 7_200_000, 'future');
}

/** Seeds a sale whose window has already closed. */
export async function seedEndedSale(
  store: SaleRedisStore,
  options: SeedSaleOptions,
): Promise<string> {
  const now = Date.now();
  return seedWithWindow(store, options, now - 7_200_000, now - 3_600_000, 'ended');
}

/** Deletes one sale's keys via `SaleRedisStore.reset`. Call from `afterEach`. */
export async function cleanup(saleId: string): Promise<void> {
  const client = connect();
  try {
    const store = new SaleRedisStore(client);
    await store.reset(saleId);
  } finally {
    client.disconnect();
  }
}
