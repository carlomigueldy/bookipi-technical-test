import { Inject, Injectable, Logger } from '@nestjs/common';
import { createRedisClient } from '@flash/redis';
import {
  ORDERS_JOB_ATTEMPTS,
  ORDERS_JOB_BACKOFF_DELAY_MS,
  ORDERS_QUEUE_PREFIX,
  PERSIST_ORDER_JOB_NAME,
  assertOrdersQueueJobPayload,
  buildOrdersJobId,
  type OrdersQueueJobPayload,
} from '@flash/shared';
import { Queue, type Job } from 'bullmq';
import type { Redis } from 'ioredis';

import { API_ENV } from '../common/tokens.js';
import type { ApiEnv } from '../config/env.js';

export const MAX_PRODUCER_IN_FLIGHT = 64;
export const PRODUCER_REOPEN_BACKOFF_MS = 1000;
export const PRODUCER_RETIRE_BOUND_MS = 2 * 500 + 250;

export type ReadinessResult = { ok: true } | { ok: false; error: unknown };
type AddResult = { ok: true; job: Job } | { ok: false; error: unknown };
type AddSettlement = Promise<AddResult>;
type DeadlineResult = { ok: false; error: Error; deadline: true };
type CloseResult = { ok: true } | { ok: false; error: unknown };

export interface ProducerGeneration {
  redis: Redis;
  queue: Queue;
  redisErrorListener: (error: Error) => void;
  queueErrorListener: (error: Error) => void;
  readiness: Promise<ReadinessResult>;
  settlements: Set<AddSettlement>;
  inFlight: number;
  retiring: boolean;
  retirementPromise: Promise<void> | null;
  closePromise: Promise<void> | null;
}

@Injectable()
export class OrdersQueueService {
  private readonly logger = new Logger(OrdersQueueService.name);
  private generation: ProducerGeneration | null = null;
  private reopenAtMs = 0;
  private closing = false;
  private serviceClosePromise: Promise<void> | null = null;

  constructor(@Inject(API_ENV) private readonly env: ApiEnv) {}

  get activeGenerationCount(): number {
    return this.generation === null ? 0 : 1;
  }

  get inFlightCount(): number {
    return this.generation?.inFlight ?? 0;
  }

  async enqueue(payload: OrdersQueueJobPayload): Promise<Job> {
    const deadlineAtMs = Date.now() + this.env.ENQUEUE_TIMEOUT_MS;
    if (this.closing) throw new Error('orders queue producer is closing');
    if (Date.now() < this.reopenAtMs) throw new Error('orders queue producer is in backoff');

    const generation = (this.generation ??= this.createGeneration());
    if (generation.retiring) throw new Error('orders queue producer circuit is open');
    if (generation.inFlight >= MAX_PRODUCER_IN_FLIGHT) {
      throw new Error('orders queue producer is at its in-flight limit');
    }
    generation.inFlight += 1;

    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline: Promise<DeadlineResult> = new Promise((resolve) => {
      timer = setTimeout(
        () =>
          resolve({
            ok: false,
            error: new Error('orders queue enqueue timed out'),
            deadline: true,
          }),
        Math.max(0, deadlineAtMs - Date.now()),
      );
      timer.unref?.();
    });

    try {
      const readiness = await Promise.race([generation.readiness, deadline]);
      if (!readiness.ok) {
        this.retireGeneration(generation);
        throw readiness.error;
      }

      let baseSettlement: AddSettlement;
      try {
        assertOrdersQueueJobPayload(payload);
        baseSettlement = generation.queue
          .add(PERSIST_ORDER_JOB_NAME, payload, {
            jobId: buildOrdersJobId(payload.saleId, payload.userId),
            attempts: ORDERS_JOB_ATTEMPTS,
            backoff: { type: 'exponential', delay: ORDERS_JOB_BACKOFF_DELAY_MS },
            removeOnComplete: { count: 1000 },
            removeOnFail: false,
          })
          .then(
            (job) => ({ ok: true as const, job }),
            (error: unknown) => ({ ok: false as const, error }),
          );
      } catch (error) {
        baseSettlement = Promise.resolve({ ok: false as const, error });
      }
      const settlement: AddSettlement = baseSettlement.then((result) => {
        generation.settlements.delete(settlement);
        return result;
      });
      generation.settlements.add(settlement);
      const result = await Promise.race([settlement, deadline]);
      if (!result.ok) {
        this.retireGeneration(generation);
        throw result.error;
      }
      return result.job;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      generation.inFlight = Math.max(0, generation.inFlight - 1);
    }
  }

  close(): Promise<void> {
    this.serviceClosePromise ??= this.closeService();
    return this.serviceClosePromise;
  }

  protected createRedis(): Redis {
    return createRedisClient({
      url: this.env.REDIS_URL,
      connectionName: 'flash-api-queue',
      overrides: {
        lazyConnect: true,
        enableReadyCheck: false,
        enableOfflineQueue: false,
        maxRetriesPerRequest: 1,
        commandTimeout: this.env.ENQUEUE_TIMEOUT_MS,
        connectTimeout: this.env.ENQUEUE_TIMEOUT_MS,
        retryStrategy: () => null,
      },
    });
  }

  protected createQueue(redis: Redis): Queue {
    return new Queue(this.env.ORDERS_QUEUE_NAME, {
      connection: redis,
      prefix: ORDERS_QUEUE_PREFIX,
    });
  }

  protected createGeneration(): ProducerGeneration {
    const redis = this.createRedis();
    const redisErrorListener = (error: Error): void => this.logQueueError(error);
    redis.on('error', redisErrorListener);

    let queue: Queue;
    try {
      queue = this.createQueue(redis);
    } catch (error) {
      redis.removeListener('error', redisErrorListener);
      redis.disconnect(false);
      throw error;
    }
    const queueErrorListener = (error: Error): void => this.logQueueError(error);
    queue.on('error', queueErrorListener);
    const readiness: Promise<ReadinessResult> = queue.waitUntilReady().then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    );

    return {
      redis,
      queue,
      redisErrorListener,
      queueErrorListener,
      readiness,
      settlements: new Set(),
      inFlight: 0,
      retiring: false,
      retirementPromise: null,
      closePromise: null,
    };
  }

  private logQueueError(error: Error): void {
    this.logger.error({ err: error.message }, 'orders_queue.error');
  }

  private retireGeneration(generation: ProducerGeneration): Promise<void> {
    if (generation.retirementPromise !== null) return generation.retirementPromise;
    generation.retiring = true;
    generation.redis.disconnect(false);
    const retirement = this.finishRetirement(generation).then(
      () => undefined,
      (error: unknown) => {
        this.logQueueError(error instanceof Error ? error : new Error(String(error)));
      },
    );
    generation.retirementPromise = retirement;
    return retirement;
  }

  private async finishRetirement(generation: ProducerGeneration): Promise<void> {
    try {
      await generation.readiness;
      await Promise.all([...generation.settlements]);
      await this.disposeGeneration(generation);
    } finally {
      generation.redis.removeListener('error', generation.redisErrorListener);
      generation.queue.removeListener('error', generation.queueErrorListener);
      generation.redis.disconnect(false);
      generation.settlements.clear();
      generation.inFlight = 0;
      if (this.generation === generation) {
        this.generation = null;
        this.reopenAtMs = Date.now() + PRODUCER_REOPEN_BACKOFF_MS;
      }
    }
  }

  private async closeService(): Promise<void> {
    this.closing = true;
    const generation = this.generation;
    if (generation !== null) await this.retireGeneration(generation);
  }

  private async disposeGeneration(generation: ProducerGeneration): Promise<void> {
    generation.closePromise ??= this.closeGeneration(generation);
    await generation.closePromise;
  }

  private async closeGeneration(generation: ProducerGeneration): Promise<void> {
    let close: Promise<CloseResult>;
    try {
      close = generation.queue.close().then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, error }),
      );
    } catch (error) {
      close = Promise.resolve({ ok: false as const, error });
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline: Promise<{ ok: false; error: Error }> = new Promise((resolve) => {
      timer = setTimeout(
        () => resolve({ ok: false, error: new Error('orders queue close timed out') }),
        this.env.ENQUEUE_TIMEOUT_MS,
      );
      timer.unref?.();
    });
    await Promise.race([close, deadline]);
    if (timer !== undefined) clearTimeout(timer);
  }
}
