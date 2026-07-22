import { Inject, Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import { createRedisClient } from '@flash/redis';
import { ORDERS_QUEUE_PREFIX } from '@flash/shared';
import { QueueEvents, Worker, type Job } from 'bullmq';
import type { Redis } from 'ioredis';

import { WORKER_ENV } from '../common/tokens.js';
import type { WorkerEnv } from '../config/env.js';
import { OrderProcessor } from './order.processor.js';

export const ORDERS_MAX_STALLED_COUNT = 2 as const;
export const BULLMQ_MAX_STALLED_FAILED_REASON = 'job stalled more than allowable limit' as const;
export const ORDERS_LOCK_DURATION_MS = 30_000 as const;
export const ORDERS_STALLED_INTERVAL_MS = 30_000 as const;

interface ConsumerResources {
  redis: Redis | null;
  eventsRedis: Redis | null;
  worker: Worker | null;
  events: QueueEvents | null;
}

export type ConsumerRunTermination = { kind: 'resolved' } | { kind: 'rejected'; error: unknown };

@Injectable()
export class OrdersConsumer implements OnApplicationShutdown {
  private readonly logger = new Logger(OrdersConsumer.name);
  private redis: Redis | null = null;
  private eventsRedis: Redis | null = null;
  private worker: Worker | null = null;
  private events: QueueEvents | null = null;
  private preparationPromise: Promise<void> | null = null;
  private startPromise: Promise<void> | null = null;
  private runPromise: Promise<void> | null = null;
  private closePromise: Promise<void> | null = null;
  private processingReady = false;
  private closing = false;
  private readonly terminationListeners = new Set<(termination: ConsumerRunTermination) => void>();

  constructor(
    @Inject(WORKER_ENV) private readonly env: WorkerEnv,
    private readonly processor: OrderProcessor,
  ) {}

  get ready(): boolean {
    return this.processingReady;
  }

  prepareForBootstrapRecovery(): Promise<void> {
    if (this.preparationPromise) return this.preparationPromise;
    if (this.closing) return Promise.reject(new Error('orders consumer is closing'));
    this.preparationPromise = this.prepareResources().catch(async (error: unknown) => {
      const resources = this.takeResources();
      const cleanupErrors = await this.closeOwnedResources(resources, false);
      this.preparationPromise = null;
      if (cleanupErrors.length > 0) {
        throw new AggregateError(
          [error, ...cleanupErrors],
          'orders consumer preparation and cleanup failed',
        );
      }
      throw error;
    });
    return this.preparationPromise;
  }

  start(): Promise<void> {
    this.startPromise ??= this.startProcessing();
    return this.startPromise;
  }

  private async prepareResources(): Promise<void> {
    this.redis = this.createConsumerRedis('flash-worker-consumer');
    this.eventsRedis = this.createConsumerRedis('flash-worker-events');
    this.worker = new Worker(
      this.env.ORDERS_QUEUE_NAME,
      (job: Job) => this.processor.process(job),
      {
        connection: this.redis,
        prefix: ORDERS_QUEUE_PREFIX,
        concurrency: this.env.WORKER_CONCURRENCY,
        autorun: false,
        lockDuration: ORDERS_LOCK_DURATION_MS,
        stalledInterval: ORDERS_STALLED_INTERVAL_MS,
        maxStalledCount: ORDERS_MAX_STALLED_COUNT,
      },
    );
    this.events = new QueueEvents(this.env.ORDERS_QUEUE_NAME, {
      connection: this.eventsRedis,
      prefix: ORDERS_QUEUE_PREFIX,
    });
    const onError = (error: Error): void =>
      this.logger.error({ event: 'worker.consumer_error', message: error.message });
    this.worker.on('error', onError);
    this.events.on('error', onError);
    this.worker.on('stalled', (jobId) => this.logger.warn({ event: 'order.stalled', jobId }));
    this.worker.on('failed', (job, error) =>
      this.logger.error({ event: 'order.failed', jobId: job?.id, message: error.message }),
    );
    const worker = this.worker;
    const events = this.events;
    await Promise.all([worker.waitUntilReady(), events.waitUntilReady()]);
    if (this.closing) throw new Error('orders consumer closed during preparation');
    await worker.startStalledCheckTimer();
    if (this.closing) throw new Error('orders consumer closed during preparation');
  }

  private async startProcessing(): Promise<void> {
    await this.prepareForBootstrapRecovery();
    if (this.closing) throw new Error('orders consumer is closing');
    const worker = this.worker;
    if (!worker) throw new Error('orders consumer preparation completed without a Worker');
    const lifetime = worker.run();
    this.runPromise = lifetime.then(
      () => this.handleRunTermination({ kind: 'resolved' }),
      (error: unknown) => this.handleRunTermination({ kind: 'rejected', error }),
    );
    if (!worker.isRunning()) throw new Error('orders consumer run loop did not start');
    this.processingReady = true;
  }

  onFailedHint(listener: () => void): () => void {
    this.events?.on('failed', listener);
    let subscribed = this.events !== null;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      this.events?.off('failed', listener);
    };
  }

  onUnexpectedRunTermination(listener: (termination: ConsumerRunTermination) => void): () => void {
    this.terminationListeners.add(listener);
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      this.terminationListeners.delete(listener);
    };
  }

  onApplicationShutdown(): Promise<void> {
    return this.close();
  }
  close(): Promise<void> {
    this.closePromise ??= this.closeResources();
    return this.closePromise;
  }

  private createConsumerRedis(name: string): Redis {
    const client = createRedisClient({
      url: this.env.REDIS_URL,
      connectionName: name,
      overrides: { maxRetriesPerRequest: null, enableReadyCheck: false, commandTimeout: undefined },
    });
    client.on('error', (error) =>
      this.logger.error({ event: 'redis.error', scope: name, message: error.message }),
    );
    return client;
  }

  private async closeResources(): Promise<void> {
    this.closing = true;
    this.processingReady = false;
    const preparationPromise = this.preparationPromise;
    const runPromise = this.runPromise;
    const resources = this.takeResources();
    const errors = await this.closeOwnedResources(resources, runPromise !== null);
    await Promise.allSettled(
      [preparationPromise, runPromise].filter(
        (promise): promise is Promise<void> => promise !== null,
      ),
    );
    this.preparationPromise = null;
    this.startPromise = null;
    this.runPromise = null;
    this.terminationListeners.clear();
    if (errors.length > 0) throw new AggregateError(errors, 'orders consumer shutdown failed');
  }

  private takeResources(): ConsumerResources {
    const resources = {
      redis: this.redis,
      eventsRedis: this.eventsRedis,
      worker: this.worker,
      events: this.events,
    };
    this.worker = null;
    this.events = null;
    this.redis = null;
    this.eventsRedis = null;
    return resources;
  }

  private async closeOwnedResources(
    resources: ConsumerResources,
    processing: boolean,
  ): Promise<unknown[]> {
    const errors: unknown[] = [];
    if (resources.worker) {
      if (processing) {
        try {
          await resources.worker.pause(true);
        } catch (error) {
          errors.push(error);
        }
      }
      try {
        await resources.worker.close();
      } catch (error) {
        errors.push(error);
      }
      try {
        resources.worker.removeAllListeners();
      } catch (error) {
        errors.push(error);
      }
    }
    if (resources.events) {
      try {
        await resources.events.close();
      } catch (error) {
        errors.push(error);
      }
      try {
        resources.events.removeAllListeners();
      } catch (error) {
        errors.push(error);
      }
    }
    const redisResults = await Promise.allSettled(
      [resources.redis, resources.eventsRedis]
        .filter((redis): redis is Redis => redis !== null)
        .map(async (redis) => {
          const hard = setTimeout(() => redis.disconnect(false), 2000);
          hard.unref?.();
          try {
            await redis.quit();
          } catch (error) {
            redis.disconnect(false);
            throw error;
          } finally {
            clearTimeout(hard);
          }
        }),
    );
    for (const result of redisResults) if (result.status === 'rejected') errors.push(result.reason);
    return errors;
  }

  private handleRunTermination(termination: ConsumerRunTermination): void {
    if (this.closing) return;
    this.processingReady = false;
    for (const listener of [...this.terminationListeners]) {
      try {
        listener(termination);
      } catch (error) {
        this.logger.error({
          event: 'worker.termination_listener_error',
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
}
