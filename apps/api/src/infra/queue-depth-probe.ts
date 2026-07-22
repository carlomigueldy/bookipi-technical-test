import { Inject, Injectable } from '@nestjs/common';
import { createRedisClient } from '@flash/redis';
import { Queue } from 'bullmq';
import type { Redis } from 'ioredis';

import { API_ENV } from '../common/tokens.js';
import type { ApiEnv } from '../config/env.js';

export interface QueueDepth {
  waiting: number;
  active: number;
  delayed: number;
  failed: number;
}

export interface ObserverGeneration {
  redis: Redis;
  queue: Queue;
  closePromise: Promise<void> | null;
}

export const QUEUE_DEPTH_DEADLINE_MS = 750;

@Injectable()
export class QueueDepthProbe {
  private generation: ObserverGeneration | null = null;
  private flight: Promise<QueueDepth> | null = null;
  private closing = false;

  constructor(@Inject(API_ENV) private readonly env: ApiEnv) {}

  /** Exposed for boundedness proofs and operational diagnostics only. */
  get activeGenerationCount(): number {
    return this.generation === null ? 0 : 1;
  }

  get inFlightCount(): number {
    return this.flight === null ? 0 : 1;
  }

  depth(): Promise<QueueDepth> {
    if (this.closing) return Promise.reject(new Error('queue depth probe is closing'));
    this.flight ??= this.runDepth().finally(() => {
      this.flight = null;
    });
    return this.flight;
  }

  async close(): Promise<void> {
    if (this.closing) {
      await this.flight?.catch(() => undefined);
      return;
    }

    this.closing = true;
    const generation = this.generation;
    if (generation !== null) generation.redis.disconnect(false);
    await this.flight?.catch(() => undefined);
    if (generation !== null) await this.disposeGeneration(generation);
  }

  protected createGeneration(): ObserverGeneration {
    const redis = createRedisClient({
      url: this.env.REDIS_URL,
      connectionName: 'flash-api-queue-observer',
      overrides: {
        maxRetriesPerRequest: 1,
        commandTimeout: QUEUE_DEPTH_DEADLINE_MS,
        connectTimeout: QUEUE_DEPTH_DEADLINE_MS,
        enableOfflineQueue: false,
        retryStrategy: () => null,
      },
    });
    const queue = new Queue(this.env.ORDERS_QUEUE_NAME, {
      connection: redis,
      prefix: 'bull',
    });
    return { redis, queue, closePromise: null };
  }

  private async runDepth(): Promise<QueueDepth> {
    const generation = (this.generation ??= this.createGeneration());
    const command = generation.queue.getJobCounts('waiting', 'active', 'delayed', 'failed');
    // Own the rejection immediately. A forced socket close can reject on a later turn.
    const settledCommand = command.then(
      (counts) => ({ ok: true as const, counts }),
      (error: unknown) => ({ ok: false as const, error }),
    );

    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<{ ok: false; error: Error }>((resolve) => {
      timer = setTimeout(() => {
        generation.redis.disconnect(false);
        resolve({ ok: false, error: new Error('queue depth observation timed out') });
      }, QUEUE_DEPTH_DEADLINE_MS);
      timer.unref?.();
    });

    const result = await Promise.race([settledCommand, deadline]);
    if (timer !== undefined) clearTimeout(timer);

    if (!result.ok) {
      generation.redis.disconnect(false);
      // disconnect(false) is the hard cancellation boundary: it rejects and
      // removes the in-flight command. Observe that settlement before allowing
      // a fresh generation to be created.
      await settledCommand;
      await this.disposeGeneration(generation);
      throw result.error;
    }

    return {
      waiting: result.counts.waiting ?? 0,
      active: result.counts.active ?? 0,
      delayed: result.counts.delayed ?? 0,
      failed: result.counts.failed ?? 0,
    };
  }

  private async disposeGeneration(generation: ObserverGeneration): Promise<void> {
    generation.closePromise ??= (async () => {
      generation.redis.disconnect(false);
      // Queue.close() normally settles after the owned Redis connection is
      // disconnected, but BullMQ does not provide a stronger cancellation API.
      // Own its eventual rejection before racing it so a broken close cannot
      // hold application shutdown open or reject unhandled after we progress.
      const close = Promise.resolve()
        .then(() => generation.queue.close())
        .then(
          () => undefined,
          () => undefined,
        );
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, QUEUE_DEPTH_DEADLINE_MS);
        timer.unref?.();
      });

      await Promise.race([close, deadline]);
      if (timer !== undefined) clearTimeout(timer);
      // Reassert the hard cancellation boundary in case Queue.close() tried to
      // reconnect or retained work after the first disconnect.
      generation.redis.disconnect(false);
      if (this.generation === generation) this.generation = null;
    })();
    await generation.closePromise;
  }
}
