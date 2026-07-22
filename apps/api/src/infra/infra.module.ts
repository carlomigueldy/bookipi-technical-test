/**
 * `InfraModule` — frozen contract §4.2. The only `@Global()` module in this
 * app: these are process-wide singletons with no feature-module semantics,
 * and threading them through four `imports:` arrays buys nothing but
 * ceremony.
 *
 * Provides and exports the application Redis/PG/clock/cache tokens. The raw
 * producer Queue and ioredis client are intentionally not DI tokens under A4;
 * `OrdersQueueService` owns them. This module imports that service so its
 * `OnApplicationShutdown` hook can close the producer FIRST, then its observer,
 * then the two application Redis clients, then the PG pool. That ordering is why shutdown is centralized in
 * one class rather than left to each module's own independent hook: Nest
 * does not guarantee cross-module `onApplicationShutdown` ordering, and
 * closing the queue's Redis client before the queue has finished flushing
 * would be exactly the kind of bug a "just let every module clean up its
 * own thing" design invites.
 *
 * This mirrors `app.module.ts`'s own precedent (§1: "A's `app.module.ts`
 * imports SaleModule, PurchaseModule, HealthModule... which A writes BEFORE
 * B/C/D exist") — importing a sibling slice's module by its frozen path and
 * class name is the pattern the contract itself specifies for the merge, not
 * a deviation from it.
 */
import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { closeRedisClient } from '@flash/redis';
import type { Redis } from 'ioredis';
import type { Pool } from 'pg';

import {
  API_ENV,
  CLOCK,
  PG_POOL,
  QUEUE_DEPTH_PROBE,
  REDIS_LIMIT_CLIENT,
  REDIS_STORE_CLIENT,
  SALE_REDIS_STORE,
  SALE_SNAPSHOT_CACHE,
} from '../common/tokens.js';
import { env } from '../config/env.js';
import { OrdersQueueModule } from '../queue/orders-queue.module.js';
import { OrdersQueueService } from '../queue/orders-queue.service.js';
import { RedisAnchoredClock } from './clock.service.js';
import { createPgPool } from './postgres.providers.js';
import { QueueDepthProbe } from './queue-depth-probe.js';
import { redisProviders } from './redis.providers.js';
import { SaleSnapshotCache } from './sale-snapshot.cache.js';

const PROCESS_SHUTDOWN_BUDGET_MS = 5000;
const RESOURCE_SHUTDOWN_BUDGET_MS = 1000;

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

@Global()
@Module({
  imports: [OrdersQueueModule],
  providers: [
    { provide: API_ENV, useValue: env },
    ...redisProviders,
    {
      provide: PG_POOL,
      useFactory: () => createPgPool(env),
    },
    { provide: SALE_SNAPSHOT_CACHE, useClass: SaleSnapshotCache },
    { provide: CLOCK, useClass: RedisAnchoredClock },
    { provide: QUEUE_DEPTH_PROBE, useClass: QueueDepthProbe },
  ],
  exports: [
    API_ENV,
    REDIS_STORE_CLIENT,
    REDIS_LIMIT_CLIENT,
    SALE_REDIS_STORE,
    PG_POOL,
    CLOCK,
    SALE_SNAPSHOT_CACHE,
    QUEUE_DEPTH_PROBE,
  ],
})
export class InfraModule implements OnApplicationShutdown {
  private shutdownPromise: Promise<void> | null = null;
  private readonly ownedShutdownOperations = new Set<Promise<unknown>>();

  constructor(
    @Inject(REDIS_STORE_CLIENT) private readonly storeClient: Redis,
    @Inject(REDIS_LIMIT_CLIENT) private readonly limitClient: Redis,
    @Inject(PG_POOL) private readonly pgPool: Pool,
    private readonly ordersQueue: OrdersQueueService,
    @Inject(QUEUE_DEPTH_PROBE) private readonly queueDepthProbe: QueueDepthProbe,
  ) {}

  /** Signal shutdown and direct app.close() share one idempotent sequence. */
  onApplicationShutdown(): Promise<void> {
    this.shutdownPromise ??= this.shutdownSequence();
    return this.shutdownPromise;
  }

  /** Order is normative (A3/A4): producer, observer, application Redis, then PG. */
  private async shutdownSequence(): Promise<void> {
    const startedAt = Date.now();

    // A4: the producer service owns hard cancellation, add settlements, Queue
    // disposal, and listener cleanup. It is always the first shutdown attempt.
    await this.attemptWithinBudget(
      'orders_queue.close',
      () => this.ordersQueue.close(),
      RESOURCE_SHUTDOWN_BUDGET_MS,
    );

    // The probe owns its observer cancellation, while this independent budget
    // ensures a defective third-party Queue.close() can never starve Redis/PG.
    await this.attemptWithinBudget(
      'queue_depth_probe.close',
      () => this.queueDepthProbe.close(),
      RESOURCE_SHUTDOWN_BUDGET_MS,
    );

    await Promise.all([
      this.closeRedisClientOnce('redis_store.close', this.storeClient),
      this.closeRedisClientOnce('redis_limit.close', this.limitClient),
    ]);

    const remaining = Math.max(0, PROCESS_SHUTDOWN_BUDGET_MS - (Date.now() - startedAt));
    await this.closePgPoolOnce(remaining);
  }

  /**
   * A test harness (or a real network blip) may have already forced a client
   * into ioredis's terminal `'end'` status before this shutdown ever runs.
   * Re-entering QUIT/disconnect cannot make that resource more closed, so
   * skip it just as `closePgPoolOnce` skips an externally ended PG pool.
   */
  private async closeRedisClientOnce(label: string, client: Redis): Promise<void> {
    if (client.status === 'end') return;

    // ioredis resolves QUIT when Redis acknowledges it, just before the socket's
    // close handler transitions the client to `end`. Await that terminal event too:
    // otherwise app.close() can return while ioredis is still flushing its queues,
    // leaking a late rejection into the next Vitest case/application instance.
    let resolveEnded: (() => void) | undefined;
    const ended = new Promise<void>((resolve) => {
      resolveEnded = resolve;
      client.once('end', resolve);
    });
    const close = async (): Promise<void> => {
      await closeRedisClient(client);
      if ((client.status as string) !== 'end') await ended;
    };
    await this.attemptWithinBudget(label, close, RESOURCE_SHUTDOWN_BUDGET_MS, () => {
      client.disconnect(false);
      resolveEnded?.();
    });
    client.removeListener('end', resolveEnded!);
  }

  /** pg Pool exposes these lifecycle flags at runtime (pg-pool 3.x) but omits
   * them from its public TypeScript surface. They are the only synchronous way
   * to distinguish a healthy pool from one an outage test/operator already ended. */
  private async closePgPoolOnce(timeoutMs: number): Promise<void> {
    const lifecycle = this.pgPool as Pool & { ending?: boolean; ended?: boolean };
    if (lifecycle.ending === true || lifecycle.ended === true) return;
    await this.attemptWithinBudget('pg_pool.end', () => this.pgPool.end(), timeoutMs);
  }

  private async attemptWithinBudget(
    label: string,
    fn: () => Promise<unknown>,
    timeoutMs: number,
    abort?: () => void,
  ): Promise<void> {
    const operation = Promise.resolve()
      .then(fn)
      .then(
        () => ({ kind: 'settled' as const }),
        (error: unknown) => ({ kind: 'failed' as const, error }),
      );
    this.ownedShutdownOperations.add(operation);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<{ kind: 'timeout' }>((resolve) => {
      timer = setTimeout(() => resolve({ kind: 'timeout' }), timeoutMs);
      timer.unref?.();
    });
    const outcome = await Promise.race([operation, deadline]);
    if (timer !== undefined) clearTimeout(timer);

    if (outcome.kind === 'timeout') {
      try {
        abort?.();
      } catch (error) {
        console.error(
          `InfraModule shutdown: ${label} cancellation failed: ${describeError(error)}`,
        );
      }
      console.error(`InfraModule shutdown: ${label} timed out after ${timeoutMs}ms`);
    } else if (outcome.kind === 'failed') {
      console.error(`InfraModule shutdown: ${label} failed: ${describeError(outcome.error)}`);
      try {
        abort?.();
      } catch (error) {
        console.error(
          `InfraModule shutdown: ${label} cancellation failed: ${describeError(error)}`,
        );
      }
    }
  }
}
