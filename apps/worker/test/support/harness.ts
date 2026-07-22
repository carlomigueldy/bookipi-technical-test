import { randomUUID } from 'node:crypto';

import { SaleRedisStore, closeRedisClient, createRedisClient } from '@flash/redis';
import {
  ORDERS_JOB_ATTEMPTS,
  ORDERS_JOB_BACKOFF_DELAY_MS,
  ORDERS_QUEUE_PREFIX,
  PERSIST_ORDER_JOB_NAME,
  buildOrdersJobId,
  saleKeys,
  type OrdersQueueJobPayload,
} from '@flash/shared';
import { Queue, type JobsOptions } from 'bullmq';
import Redis from 'ioredis';
import { Pool } from 'pg';
import { inject } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';

import {
  ORDERS_QUEUE_ADMIN,
  RECONCILIATION_STATE,
  WORKER_ENV,
  WORKER_PG_POOL,
  WORKER_SALE_STORE,
} from '../../src/common/tokens.js';
import type { WorkerEnv } from '../../src/config/env.js';
import { HealthService } from '../../src/health/health.service.js';
import { createWorkerPgPool } from '../../src/infra/postgres.provider.js';
import { OrderProcessor } from '../../src/orders/order.processor.js';
import { OrderRepository } from '../../src/orders/order.repository.js';
import { OrdersConsumer } from '../../src/orders/orders.consumer.js';
import {
  ReconciliationService,
  createReconciliationState,
  type ReconciliationState,
} from '../../src/reconciliation/reconciliation.service.js';
import { WorkerModule } from '../../src/worker.module.js';

export const jobOptions: JobsOptions = {
  attempts: ORDERS_JOB_ATTEMPTS,
  backoff: { type: 'exponential', delay: ORDERS_JOB_BACKOFF_DELAY_MS },
  removeOnComplete: { count: 1000 },
  removeOnFail: false,
};

export interface WorkerHarness {
  env: WorkerEnv;
  redis: Redis;
  store: SaleRedisStore;
  pool: Pool;
  queue: Queue;
  repository: OrderRepository;
  processor: OrderProcessor;
  consumer: OrdersConsumer;
  reconciliation: ReconciliationService;
  state: ReconciliationState;
  health: HealthService;
  seed(): Promise<void>;
  reserve(userId?: string): Promise<OrdersQueueJobPayload>;
  add(payload: OrdersQueueJobPayload): Promise<void>;
  freshLifecycle(): FreshWorkerLifecycle;
  barrierLifecycle(): BarrierWorkerLifecycle;
  productionMinimumPoolLifecycle(): Promise<ProductionMinimumPoolLifecycle>;
  close(): Promise<void>;
}

export interface FreshWorkerLifecycle {
  repository: OrderRepository;
  processor: OrderProcessor;
  consumer: OrdersConsumer;
  reconciliation: ReconciliationService;
  state: ReconciliationState;
  health: HealthService;
  close(): Promise<void>;
}

export interface LifecycleBarrier {
  entered: Promise<void>;
  release(): void;
}

export interface BarrierWorkerLifecycle extends FreshWorkerLifecycle {
  reconciliation: BarrierReconciliationService;
  beforeConsumerStart: LifecycleBarrier;
  afterResumeVerified: LifecycleBarrier;
}

export interface ProductionMinimumPoolLifecycle extends FreshWorkerLifecycle {
  module: TestingModule;
  pool: Pool;
  queue: Queue;
  store: SaleRedisStore;
  reconciliation: BootDiffBarrierReconciliationService;
  beforeConsumerStart: LifecycleBarrier;
}

class ControlledBarrier implements LifecycleBarrier {
  readonly entered: Promise<void>;
  private readonly markEntered: () => void;
  private readonly released: Promise<void>;
  private readonly markReleased: () => void;

  constructor() {
    let enter!: () => void;
    let release!: () => void;
    this.entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    this.released = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.markEntered = enter;
    this.markReleased = release;
  }

  wait(): Promise<void> {
    this.markEntered();
    return this.released;
  }

  release(): void {
    this.markReleased();
  }
}

export class BarrierReconciliationService extends ReconciliationService {
  readonly beforeConsumerStart = new ControlledBarrier();
  readonly afterResumeVerified = new ControlledBarrier();

  protected override afterBootDiffBeforeConsumerStart(): Promise<void> {
    return this.beforeConsumerStart.wait();
  }

  protected override afterQueueResumeVerified(): Promise<void> {
    return this.afterResumeVerified.wait();
  }
}

export class BootDiffBarrierReconciliationService extends ReconciliationService {
  readonly beforeConsumerStart = new ControlledBarrier();

  protected override afterBootDiffBeforeConsumerStart(): Promise<void> {
    return this.beforeConsumerStart.wait();
  }
}

export function yieldTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

export async function eventually<T>(
  read: () => Promise<T>,
  accept: (value: T) => boolean,
  label: string,
  timeoutMs = 30_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let value: T;
  do {
    value = await read();
    if (accept(value)) return value;
    await yieldTurn();
  } while (Date.now() < deadline);
  throw new Error(`timed out waiting for ${label}; last value=${JSON.stringify(value!)}`);
}

export function makePayload(
  saleId: string,
  userId: string,
  reservationId = randomUUID(),
  reservedAtMs = Date.now(),
): OrdersQueueJobPayload {
  return { saleId, userId, reservationId, reservedAtMs, requestId: `req-${randomUUID()}` };
}

export async function createHarness(overrides: Partial<WorkerEnv> = {}): Promise<WorkerHarness> {
  const redisUrl = inject('redisUrl');
  const postgresUrl = inject('postgresUrl');
  const token = randomUUID().replaceAll('-', '').slice(0, 12);
  const saleId = `w-${token}`;
  const env: WorkerEnv = {
    NODE_ENV: 'test',
    LOG_LEVEL: 'fatal',
    WORKER_HEALTH_PORT: 3001,
    DATABASE_URL: postgresUrl,
    REDIS_URL: redisUrl,
    SALE_ID: saleId,
    SALE_NAME: `Worker test ${token}`,
    SALE_STARTS_AT: '2020-01-01T00:00:00.000Z',
    SALE_ENDS_AT: '2099-01-01T00:00:00.000Z',
    SALE_TOTAL_STOCK: 20,
    ORDERS_QUEUE_NAME: `orders-${token}`,
    WORKER_CONCURRENCY: 2,
    WORKER_MAX_ATTEMPTS: ORDERS_JOB_ATTEMPTS,
    WORKER_PG_POOL_MAX: 10,
    WORKER_PG_STATEMENT_TIMEOUT_MS: 5000,
    WORKER_RECONCILE_INTERVAL_MS: 250,
    WORKER_RECONCILE_SCAN_COUNT: 20,
    WORKER_DLQ_SWEEP_INTERVAL_MS: 250,
    WORKER_DLQ_SCAN_COUNT: 20,
    REDIS_TEST_URL: redisUrl,
    POSTGRES_TEST_URL: postgresUrl,
    ...overrides,
  };
  const redis = createRedisClient({ url: redisUrl, connectionName: `test-store-${token}` });
  redis.on('error', (error) => console.error('test store Redis error', error));
  const queueRedis = new Redis(redisUrl, { maxRetriesPerRequest: 2, enableReadyCheck: false });
  queueRedis.on('error', (error) => console.error('test queue Redis error', error));
  const store = new SaleRedisStore(redis);
  const pool = new Pool({
    connectionString: postgresUrl,
    max: env.WORKER_PG_POOL_MAX,
    statement_timeout: 5000,
  });
  pool.on('error', (error) => console.error('test Postgres pool error', error));
  const queue = new Queue(env.ORDERS_QUEUE_NAME, {
    connection: queueRedis,
    prefix: ORDERS_QUEUE_PREFIX,
  });
  queue.on('error', (error) => console.error('test queue error', error));
  const repository = new OrderRepository(pool, env, store);
  const processor = new OrderProcessor(repository);
  const consumer = new OrdersConsumer(env, processor);
  const state = createReconciliationState();
  const reconciliation = new ReconciliationService(env, store, queue, state, repository, consumer);
  const health = new HealthService(state);
  const freshLifecycles: FreshWorkerLifecycle[] = [];
  const productionLifecycles: ProductionMinimumPoolLifecycle[] = [];

  const harness: WorkerHarness = {
    env,
    redis,
    store,
    pool,
    queue,
    repository,
    processor,
    consumer,
    reconciliation,
    state,
    health,
    async seed() {
      await repository.ensureSale();
      await store.seed({
        saleId: env.SALE_ID,
        name: env.SALE_NAME,
        startsAt: env.SALE_STARTS_AT,
        endsAt: env.SALE_ENDS_AT,
        totalStock: env.SALE_TOTAL_STOCK,
      });
    },
    async reserve(userId = `usr-${randomUUID().slice(0, 8)}`) {
      const result = await store.purchase(env.SALE_ID, userId);
      if (result.outcome !== 'CONFIRMED' || !result.reservationId)
        throw new Error(`reservation failed: ${result.outcome}`);
      return {
        saleId: env.SALE_ID,
        userId,
        reservationId: result.reservationId,
        reservedAtMs: result.serverTimeMs,
        requestId: `req-${randomUUID()}`,
      };
    },
    async add(payload) {
      await queue.add(PERSIST_ORDER_JOB_NAME, payload, {
        ...jobOptions,
        jobId: buildOrdersJobId(payload.saleId, payload.userId),
      });
    },
    freshLifecycle() {
      const freshRepository = new OrderRepository(pool, env, store);
      const freshProcessor = new OrderProcessor(freshRepository);
      const freshConsumer = new OrdersConsumer(env, freshProcessor);
      const freshState = createReconciliationState();
      const freshReconciliation = new ReconciliationService(
        env,
        store,
        queue,
        freshState,
        freshRepository,
        freshConsumer,
      );
      const lifecycle: FreshWorkerLifecycle = {
        repository: freshRepository,
        processor: freshProcessor,
        consumer: freshConsumer,
        reconciliation: freshReconciliation,
        state: freshState,
        health: new HealthService(freshState),
        async close() {
          await freshReconciliation.stop();
          await freshConsumer.close();
        },
      };
      freshLifecycles.push(lifecycle);
      return lifecycle;
    },
    barrierLifecycle() {
      const freshRepository = new OrderRepository(pool, env, store);
      const freshProcessor = new OrderProcessor(freshRepository);
      const freshConsumer = new OrdersConsumer(env, freshProcessor);
      const freshState = createReconciliationState();
      const freshReconciliation = new BarrierReconciliationService(
        env,
        store,
        queue,
        freshState,
        freshRepository,
        freshConsumer,
      );
      const lifecycle: BarrierWorkerLifecycle = {
        repository: freshRepository,
        processor: freshProcessor,
        consumer: freshConsumer,
        reconciliation: freshReconciliation,
        state: freshState,
        health: new HealthService(freshState),
        beforeConsumerStart: freshReconciliation.beforeConsumerStart,
        afterResumeVerified: freshReconciliation.afterResumeVerified,
        async close() {
          freshReconciliation.beforeConsumerStart.release();
          freshReconciliation.afterResumeVerified.release();
          await freshReconciliation.stop();
          await freshConsumer.close();
        },
      };
      freshLifecycles.push(lifecycle);
      return lifecycle;
    },
    async productionMinimumPoolLifecycle() {
      if (env.WORKER_PG_POOL_MAX !== 2) {
        throw new Error('production minimum-pool lifecycle requires WORKER_PG_POOL_MAX=2');
      }
      const workerPool = createWorkerPgPool(env);
      let module: TestingModule;
      try {
        module = await Test.createTestingModule({ imports: [WorkerModule] })
          .overrideProvider(WORKER_ENV)
          .useValue(env)
          .overrideProvider(WORKER_PG_POOL)
          .useValue(workerPool)
          .overrideProvider(ReconciliationService)
          .useClass(BootDiffBarrierReconciliationService)
          .compile();
        await module.init();
      } catch (error) {
        await workerPool.end().catch(() => undefined);
        throw error;
      }
      const reconciliation =
        module.get<BootDiffBarrierReconciliationService>(ReconciliationService);
      const lifecycle: ProductionMinimumPoolLifecycle = {
        module,
        pool: workerPool,
        queue: module.get<Queue>(ORDERS_QUEUE_ADMIN),
        store: module.get<SaleRedisStore>(WORKER_SALE_STORE),
        repository: module.get(OrderRepository),
        processor: module.get(OrderProcessor),
        consumer: module.get(OrdersConsumer),
        reconciliation,
        state: module.get<ReconciliationState>(RECONCILIATION_STATE),
        health: module.get(HealthService),
        beforeConsumerStart: reconciliation.beforeConsumerStart,
        async close() {
          reconciliation.beforeConsumerStart.release();
          const errors: unknown[] = [];
          try {
            await reconciliation.stop();
          } catch (error) {
            errors.push(error);
          }
          try {
            await module.close();
          } catch (error) {
            errors.push(error);
          }
          if (errors.length > 0) {
            throw new AggregateError(errors, 'production test lifecycle shutdown failed');
          }
        },
      };
      productionLifecycles.push(lifecycle);
      return lifecycle;
    },
    async close() {
      await Promise.allSettled(productionLifecycles.map((lifecycle) => lifecycle.close()));
      await Promise.allSettled(freshLifecycles.map((lifecycle) => lifecycle.close()));
      await reconciliation.stop();
      await consumer.close();
      await queue.obliterate({ force: true }).catch(() => undefined);
      await queue.close();
      queueRedis.disconnect(false);
      await store.reset(env.SALE_ID).catch(() => undefined);
      await pool.query('DELETE FROM orders WHERE sale_id=$1', [env.SALE_ID]).catch(() => undefined);
      await pool.query('DELETE FROM sales WHERE id=$1', [env.SALE_ID]).catch(() => undefined);
      await pool.end();
      await closeRedisClient(redis).catch(() => redis.disconnect(false));
    },
  };
  return harness;
}

export async function stock(harness: WorkerHarness): Promise<number> {
  const raw = await harness.redis.get(saleKeys(harness.env.SALE_ID).stock);
  return Number(raw);
}

export async function orderRow(harness: WorkerHarness, userId: string) {
  const result = await harness.pool.query<{ id: string; status: 'persisted' | 'compensated' }>(
    'SELECT id,status FROM orders WHERE user_id=$1',
    [userId],
  );
  return result.rows[0] ?? null;
}
