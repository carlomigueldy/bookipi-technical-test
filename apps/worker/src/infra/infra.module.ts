import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { closeRedisClient } from '@flash/redis';
import type { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import type { Pool } from 'pg';

import {
  ORDERS_QUEUE_ADMIN,
  WORKER_ENV,
  WORKER_PG_POOL,
  WORKER_REDIS_QUEUE_CLIENT,
  WORKER_REDIS_STORE_CLIENT,
  WORKER_SALE_STORE,
} from '../common/tokens.js';
import { env } from '../config/env.js';
import { createWorkerPgPool } from './postgres.provider.js';
import { redisProviders } from './redis.providers.js';

async function within<T>(
  operation: Promise<T>,
  timeoutMs: number,
  timeout: () => void,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      timeout();
      reject(new Error(`resource close timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();
  });
  try {
    await Promise.race([operation.then(() => undefined), deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

@Global()
@Module({
  providers: [
    { provide: WORKER_ENV, useValue: env },
    ...redisProviders,
    { provide: WORKER_PG_POOL, useFactory: () => createWorkerPgPool(env) },
  ],
  exports: [
    WORKER_ENV,
    WORKER_REDIS_STORE_CLIENT,
    WORKER_REDIS_QUEUE_CLIENT,
    WORKER_SALE_STORE,
    WORKER_PG_POOL,
    ORDERS_QUEUE_ADMIN,
  ],
})
export class InfraModule implements OnApplicationShutdown {
  private closePromise: Promise<void> | null = null;

  constructor(
    @Inject(ORDERS_QUEUE_ADMIN) private readonly queue: Queue,
    @Inject(WORKER_REDIS_STORE_CLIENT) private readonly storeRedis: Redis,
    @Inject(WORKER_REDIS_QUEUE_CLIENT) private readonly adminRedis: Redis,
    @Inject(WORKER_PG_POOL) private readonly pool: Pool,
  ) {}

  onApplicationShutdown(): Promise<void> {
    this.closePromise ??= this.close();
    return this.closePromise;
  }

  private async close(): Promise<void> {
    const errors: unknown[] = [];
    this.queue.removeAllListeners();
    try {
      await within(this.queue.close(), 2000, () => this.adminRedis.disconnect(false));
    } catch (error) {
      errors.push(error);
    }
    const redisResults = await Promise.allSettled([
      within(closeRedisClient(this.storeRedis), 2000, () => this.storeRedis.disconnect(false)),
      within(closeRedisClient(this.adminRedis), 2000, () => this.adminRedis.disconnect(false)),
    ]);
    for (const result of redisResults) if (result.status === 'rejected') errors.push(result.reason);
    try {
      await this.pool.end();
    } catch (error) {
      errors.push(error);
    }
    if (errors.length > 0)
      throw new AggregateError(errors, 'worker infrastructure shutdown failed');
  }
}
