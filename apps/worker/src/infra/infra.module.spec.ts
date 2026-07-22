import { describe, expect, it, vi } from 'vitest';
import {
  ORDERS_BULL_WORKER,
  ORDERS_QUEUE_ADMIN,
  RECONCILIATION_STATE,
  WORKER_ENV,
  WORKER_PG_POOL,
  WORKER_REDIS_QUEUE_CLIENT,
  WORKER_REDIS_STORE_CLIENT,
  WORKER_SALE_STORE,
} from '../common/tokens.js';
import { createWorkerPgPool } from './postgres.provider.js';
import { InfraModule } from './infra.module.js';
import { installProcessHandlers, WORKER_SHUTDOWN_WATCHDOG_MS } from '../main.js';

describe('worker infrastructure', () => {
  it('uses the frozen DI token strings', () => {
    expect([
      WORKER_ENV,
      WORKER_REDIS_STORE_CLIENT,
      WORKER_REDIS_QUEUE_CLIENT,
      WORKER_SALE_STORE,
      WORKER_PG_POOL,
      ORDERS_QUEUE_ADMIN,
      ORDERS_BULL_WORKER,
      RECONCILIATION_STATE,
    ]).toEqual([
      'WORKER_ENV',
      'WORKER_REDIS_STORE_CLIENT',
      'WORKER_REDIS_QUEUE_CLIENT',
      'WORKER_SALE_STORE',
      'WORKER_PG_POOL',
      'ORDERS_QUEUE_ADMIN',
      'ORDERS_BULL_WORKER',
      'RECONCILIATION_STATE',
    ]);
  });

  it.each([2, 7, 100])(
    'constructs one bounded worker pool with validated max=%i without connecting eagerly',
    async (maximum) => {
      const pool = createWorkerPgPool({
        DATABASE_URL: 'postgresql://flash:flash@localhost:5433/flash',
        WORKER_PG_POOL_MAX: maximum,
        WORKER_PG_STATEMENT_TIMEOUT_MS: 1500,
      } as never);
      expect(pool.options.max).toBe(maximum);
      expect(pool.options.statement_timeout).toBe(1500);
      await pool.end();
    },
  );

  it('registers exactly one Postgres pool provider', () => {
    const providers = Reflect.getMetadata('providers', InfraModule) as Array<{
      provide?: unknown;
    }>;
    expect(providers.filter((provider) => provider.provide === WORKER_PG_POOL)).toHaveLength(1);
  });

  it('pins the production watchdog and rejects invalid injected deadlines', () => {
    expect(WORKER_SHUTDOWN_WATCHDOG_MS).toBe(10_000);
    expect(() => installProcessHandlers({ watchdogMs: 0 })).toThrow('positive finite');
    expect(() => installProcessHandlers({ watchdogMs: Number.NaN })).toThrow('positive finite');
  });

  it('attempts BullMQ admin, both Redis clients, and Postgres even when one close fails', async () => {
    const queue = {
      removeAllListeners: vi.fn(),
      close: vi.fn(async () => {
        throw new Error('queue close');
      }),
    };
    const storeRedis = { quit: vi.fn(async () => 'OK'), disconnect: vi.fn() };
    const adminRedis = { quit: vi.fn(async () => 'OK'), disconnect: vi.fn() };
    const pool = { end: vi.fn(async () => undefined) };
    const module = new InfraModule(
      queue as never,
      storeRedis as never,
      adminRedis as never,
      pool as never,
    );
    await expect(module.onApplicationShutdown()).rejects.toThrow('infrastructure shutdown failed');
    expect(queue.close).toHaveBeenCalledOnce();
    expect(storeRedis.quit).toHaveBeenCalledOnce();
    expect(adminRedis.quit).toHaveBeenCalledOnce();
    expect(pool.end).toHaveBeenCalledOnce();
    expect(module.onApplicationShutdown()).toBe(module.onApplicationShutdown());
  });
});
