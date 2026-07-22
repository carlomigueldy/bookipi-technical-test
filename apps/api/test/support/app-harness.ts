// apps/api/test/support/app-harness.ts  [SLICE E — frozen contract §11.1]
//
// Boots a REAL, listening Nest+Fastify application against the shared Testcontainers
// Redis/Postgres, for exactly one spec/case. Returns `{ baseUrl, app, store, pool,
// close() }` per contract §11.1. Every spec calls `bootHarness()` in `beforeEach` and
// `harness.close()` in `afterEach` — there is no shared, mutated app instance between
// specs, so no spec can leak state into another via a stale Fastify singleton.
//
import { randomUUID } from 'node:crypto';

import type { INestApplication } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test, type TestingModuleBuilder } from '@nestjs/testing';
import { SaleRedisStore } from '@flash/redis';
import Redis from 'ioredis';
import { Pool } from 'pg';
import { inject } from 'vitest';

import { createQueueTestObserver, type QueueTestObserver } from './queue-test-observer.js';

export interface HarnessEnvOverrides {
  [key: string]: string | undefined;
}

export interface BootOptions {
  /** Merged on top of `DEFAULT_TEST_ENV`; `undefined` deletes the key for this boot. */
  env?: HarnessEnvOverrides;
  /**
   * Escape hatch for `.overrideProvider(...)` (the negative control, clock-skew, and
   * enqueue-failure specs). Applied to the `TestingModuleBuilder` before `.compile()`,
   * AFTER this function's own `vi.resetModules()` + `AppModule` import below — that
   * ordering is load-bearing, not incidental. `.overrideProvider(SomeClass)` matches
   * providers by the CLASS OBJECT'S IDENTITY (unlike a string/symbol DI token, which
   * matches by value): a class imported by the CALLER before `bootHarness()` runs
   * `vi.resetModules()` is a DIFFERENT object from the one the freshly-reset
   * `AppModule` registers, so the override silently matches nothing and the real
   * provider stays wired — no error, no warning, just a no-op override. Any override
   * keyed by a class (not a string token) MUST import that class from INSIDE this
   * callback (which runs after the reset) rather than capturing it in an outer
   * closure — hence `Promise` support, so the callback can `await import(...)` itself.
   */
  overrideModule?: (
    builder: TestingModuleBuilder,
  ) => TestingModuleBuilder | Promise<TestingModuleBuilder>;
}

export interface AppHarness {
  baseUrl: string;
  app: NestFastifyApplication;
  saleId: string;
  /** Independent connection, NOT the app's own `REDIS_STORE_CLIENT` — for test-side assertions only. */
  store: SaleRedisStore;
  /** Independent connection, NOT the app's own `PG_POOL` — for test-side assertions only. */
  pool: Pool;
  redisUrl: string;
  postgresUrl: string;
  queueObserver: QueueTestObserver;
  get<T>(token: unknown): T;
  close(): Promise<void>;
}

/**
 * Defaults for every env row this contract adds or that Phase 0 already froze,
 * regardless of whether a given spec cares about it — `config/env.schema.ts` [SLICE A]
 * fail-fast parses the FULL table at module load (contract §3.2), so a harness that
 * omits any required key would fail every spec, not just the ones exercising it.
 */
const DEFAULT_TEST_ENV: HarnessEnvOverrides = {
  NODE_ENV: 'test',
  // 'silent' is not in the frozen LOG_LEVEL enum (Phase 0 §11:
  // fatal|error|warn|info|debug|trace) — 'fatal' is the quietest legal value.
  LOG_LEVEL: 'fatal',
  API_HOST: '127.0.0.1',
  // env.schema.ts requires API_PORT > 0 (Phase 0 §11 frozen row); the actual bind
  // below always uses an OS-assigned ephemeral port via `app.listen(0, ...)`, so
  // this value is parsed for boot validation only and never used to bind.
  API_PORT: '3000',
  CORS_ORIGIN: 'http://localhost:5173',
  SALE_NAME: 'Integration Test Sale',
  SALE_STARTS_AT: '2026-07-22T12:00:00.000Z',
  SALE_ENDS_AT: '2026-07-22T13:00:00.000Z',
  SALE_TOTAL_STOCK: '500',
  RATE_LIMIT_MAX: '20',
  RATE_LIMIT_WINDOW_MS: '1000',
  RATE_LIMIT_USER_MAX: '5',
  RATE_LIMIT_USER_WINDOW_MS: '1000',
  TRUST_PROXY: 'false',
  REQUEST_BODY_LIMIT_BYTES: '16384',
  CLOCK_SYNC_INTERVAL_MS: '5000',
  CLOCK_MAX_STALENESS_MS: '15000',
  CLOCK_GUARD_SKEW_MS: '250',
  ENQUEUE_TIMEOUT_MS: '500',
  PG_POOL_MAX: '10',
  PG_STATEMENT_TIMEOUT_MS: '2000',
};

/**
 * `SCAN`s (never `KEYS` — `redis-connections` skill guidance) and deletes
 * every `rl:ip:*` / `rl:u:*` key. See `bootHarness`'s call site for why this
 * runs on every boot: the per-IP limiter's Redis keyspace is NOT scoped by
 * the per-boot-unique `saleId`, so it is the one piece of state that
 * `seedSale`'s per-test isolation does not already cover.
 */
async function flushRateLimitKeys(redis: Redis): Promise<void> {
  const keys: string[] = [];
  let cursor = '0';
  do {
    const [next, batch] = await redis.scan(cursor, 'MATCH', 'rl:*', 'COUNT', '500');
    cursor = next;
    keys.push(...batch);
  } while (cursor !== '0');
  if (keys.length > 0) await redis.del(...keys);
}

/**
 * Boots a fresh app against a fresh, unique `saleId`. `env` overrides are applied to
 * `process.env` for exactly the lifetime of this call via `vi.resetModules()` so
 * `config/env.ts`'s fail-fast `.parse()` (run once at module load, contract §3.2)
 * re-reads the values THIS call set, not a previous boot's. This is the standard
 * Vitest technique for env-driven singleton modules — there is no other way to get two
 * different `ApiEnv` snapshots in one process without it.
 */
export async function bootHarness(options: BootOptions = {}): Promise<AppHarness> {
  const redisUrl = inject('redisUrl');
  const postgresUrl = inject('postgresUrl');
  const saleId = `t-${randomUUID().replace(/-/g, '').slice(0, 12)}`;

  const merged: HarnessEnvOverrides = {
    ...DEFAULT_TEST_ENV,
    REDIS_URL: redisUrl,
    DATABASE_URL: postgresUrl,
    REDIS_TEST_URL: redisUrl,
    POSTGRES_TEST_URL: postgresUrl,
    SALE_ID: saleId,
    // Sale ids are random per boot, so the queue is isolated even when a
    // developer points repeated Vitest processes at one persistent Redis.
    ORDERS_QUEUE_NAME: `orders-test-${saleId}`,
    ...options.env,
  };

  for (const [key, value] of Object.entries(merged)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  const { vi } = await import('vitest');
  vi.resetModules();

  const { AppModule } =
    (await import('../../src/app.module.js')) as typeof import('../../src/app.module.js');
  const { configureApp, createHttpAdapter } =
    (await import('../../src/main.js')) as typeof import('../../src/main.js');
  // Re-import AFTER `vi.resetModules()` + the `AppModule` import above so this
  // resolves to the SAME per-boot singleton `env` object `AppModule` itself saw.
  const { env: bootEnv } =
    (await import('../../src/config/env.js')) as typeof import('../../src/config/env.js');

  let builder = Test.createTestingModule({ imports: [AppModule] });
  if (options.overrideModule) builder = await options.overrideModule(builder);
  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication<NestFastifyApplication>(createHttpAdapter(bootEnv), {
    logger: false,
  });

  const { REDIS_LIMIT_CLIENT } =
    (await import('../../src/common/tokens.js')) as typeof import('../../src/common/tokens.js');
  const limiterClient = app.get<Redis>(REDIS_LIMIT_CLIENT);
  // Every `bootHarness()` boot registers a FRESH `@fastify/rate-limit`
  // plugin instance, but its Redis-side counters are keyed by client IP
  // only (`rl:ip:127.0.0.1`, contract §7.1's frozen `nameSpace`) — the SAME
  // key every boot in this process reuses, because every request in this
  // suite originates from the loopback IP. Without a flush here, an earlier
  // spec's traffic (most severely `concurrency.integration.spec.ts`'s 500+
  // requests) leaks into whichever spec boots next within the same
  // `RATE_LIMIT_WINDOW_MS`, and `rate-limit.integration.spec.ts` — the one
  // spec that asserts the EXACT count at PRODUCTION limits — starts already
  // over budget. This mirrors the sale-state `reset()`/`seed()` isolation
  // contract §11.1 already requires, extended to the rate-limiter's own
  // keyspace, which no per-test `saleId` uniqueness protects.
  await flushRateLimitKeys(limiterClient);
  await configureApp(app, bootEnv);

  app.enableShutdownHooks();

  await app.listen(0, '127.0.0.1');
  const baseUrl = (await app.getUrl())
    .replace('[::1]', '127.0.0.1')
    .replace('0.0.0.0', '127.0.0.1');

  const assertionRedis = new Redis(redisUrl, {
    lazyConnect: false,
    connectionName: 'flash-api-test-harness',
  });
  const store = new SaleRedisStore(assertionRedis);
  const pool = new Pool({ connectionString: postgresUrl, max: 5 });
  const queueObserver = createQueueTestObserver({
    redisUrl,
    queueName: bootEnv.ORDERS_QUEUE_NAME,
  });

  return {
    baseUrl,
    app,
    saleId,
    store,
    pool,
    redisUrl,
    postgresUrl,
    queueObserver,
    get<T>(token: unknown): T {
      return moduleRef.get<T>(token as never, { strict: false });
    },
    async close(): Promise<void> {
      await queueObserver.close();
      await (app as unknown as INestApplication).close();
      await pool.end();
      assertionRedis.disconnect();
    },
  };
}
