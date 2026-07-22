import { EventEmitter } from 'node:events';
import {
  ORDERS_JOB_ATTEMPTS,
  ORDERS_JOB_BACKOFF_DELAY_MS,
  PERSIST_ORDER_JOB_NAME,
  buildOrdersJobId,
  type OrdersQueueJobPayload,
} from '@flash/shared';
import type { Job, Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  MAX_PRODUCER_IN_FLIGHT,
  OrdersQueueService,
  PRODUCER_REOPEN_BACKOFF_MS,
  PRODUCER_RETIRE_BOUND_MS,
} from './orders-queue.service.js';

const PAYLOAD: OrdersQueueJobPayload = {
  saleId: 'flash-2026',
  userId: 'alice',
  reservationId: '11111111-1111-4111-8111-111111111111',
  reservedAtMs: 1_700_000_000_000,
  requestId: 'req-1',
};
const ENV = {
  REDIS_URL: 'redis://localhost:6380',
  ORDERS_QUEUE_NAME: 'orders',
  ENQUEUE_TIMEOUT_MS: 500,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

type FakeRedis = Redis & EventEmitter & { disconnect: ReturnType<typeof vi.fn> };
type FakeQueue = Queue &
  EventEmitter & {
    waitUntilReady: ReturnType<typeof vi.fn>;
    add: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  };

class ControlledOrdersQueueService extends OrdersQueueService {
  readonly redis: FakeRedis;
  readonly queue: FakeQueue;
  redisListenersAtQueueCreation = -1;

  constructor(options: {
    readiness: Promise<unknown>;
    add?: ReturnType<typeof vi.fn>;
    close?: ReturnType<typeof vi.fn>;
    disconnect?: () => void;
  }) {
    super(ENV as never);
    this.redis = new EventEmitter() as FakeRedis;
    this.redis.disconnect = vi.fn(() => options.disconnect?.());
    this.queue = new EventEmitter() as FakeQueue;
    this.queue.waitUntilReady = vi.fn(
      () => options.readiness as ReturnType<Queue['waitUntilReady']>,
    );
    this.queue.add = options.add ?? vi.fn().mockResolvedValue({ id: 'job-1' } as Job);
    this.queue.close = options.close ?? vi.fn().mockResolvedValue(undefined);
  }

  protected override createRedis(): Redis {
    return this.redis;
  }

  protected override createQueue(): Queue {
    this.redisListenersAtQueueCreation = this.redis.listenerCount('error');
    return this.queue;
  }
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('buildOrdersJobId', () => {
  it('preserves the BullMQ-compatible A3 retry/deduplication id', () => {
    expect(buildOrdersJobId('flash-2026', 'alice')).toBe('flash-2026-alice');
  });
});

describe('OrdersQueueService A4.2 producer ownership', () => {
  it('attaches readiness exactly once, shares it, and creates no add before ready', async () => {
    const ready = deferred<unknown>();
    const service = new ControlledOrdersQueueService({ readiness: ready.promise });
    const first = service.enqueue(PAYLOAD);
    const second = service.enqueue({ ...PAYLOAD, userId: 'bob' });

    expect(service.queue.waitUntilReady).toHaveBeenCalledTimes(1);
    expect(service.queue.add).not.toHaveBeenCalled();
    expect(service.inFlightCount).toBe(2);
    expect(service.redisListenersAtQueueCreation).toBe(1);
    expect(service.redis.listenerCount('error')).toBe(1);
    expect(service.queue.listenerCount('error')).toBe(1);

    ready.resolve(undefined);
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(service.queue.add).toHaveBeenCalledTimes(2);
    expect(service.inFlightCount).toBe(0);
  });

  it('uses the frozen add options after readiness succeeds', async () => {
    const service = new ControlledOrdersQueueService({ readiness: Promise.resolve() });
    await service.enqueue(PAYLOAD);
    expect(service.queue.add).toHaveBeenCalledWith(PERSIST_ORDER_JOB_NAME, PAYLOAD, {
      jobId: buildOrdersJobId(PAYLOAD.saleId, PAYLOAD.userId),
      attempts: ORDERS_JOB_ATTEMPTS,
      backoff: { type: 'exponential', delay: ORDERS_JOB_BACKOFF_DELAY_MS },
      removeOnComplete: { count: 1000 },
      removeOnFail: false,
    });
  });

  it('validates payloads before queue.add', async () => {
    const service = new ControlledOrdersQueueService({ readiness: Promise.resolve() });

    await expect(service.enqueue({ ...PAYLOAD, reservationId: 'not-a-uuid' })).rejects.toThrow(
      TypeError,
    );
    expect(service.queue.add).not.toHaveBeenCalled();
  });

  it('readiness rejection retires once, creates zero adds, and settles every caller', async () => {
    const ready = deferred<unknown>();
    const service = new ControlledOrdersQueueService({ readiness: ready.promise });
    const calls = [service.enqueue(PAYLOAD), service.enqueue({ ...PAYLOAD, userId: 'bob' })];
    const proofs = calls.map((call) => expect(call).rejects.toThrow('not ready'));

    ready.reject(new Error('not ready'));
    await Promise.all(proofs);
    await vi.waitFor(() => expect(service.activeGenerationCount).toBe(0));
    expect(service.queue.add).not.toHaveBeenCalled();
    expect(service.queue.close).toHaveBeenCalledTimes(1);
    expect(service.redis.disconnect).toHaveBeenCalledTimes(2);
    expect(service.inFlightCount).toBe(0);
  });

  it('never-ready callers time out under one budget and clear within the retire bound', async () => {
    vi.useFakeTimers();
    const ready = deferred<unknown>();
    let disconnected = false;
    const service = new ControlledOrdersQueueService({
      readiness: ready.promise,
      disconnect: () => {
        if (!disconnected) {
          disconnected = true;
          ready.reject(new Error('disconnected'));
        }
      },
    });
    const calls = [service.enqueue(PAYLOAD), service.enqueue({ ...PAYLOAD, userId: 'bob' })];
    const outcomes = calls.map((call) =>
      call.then(
        () => null,
        (error: unknown) => error,
      ),
    );
    const unhandled: unknown[] = [];
    const onUnhandled = (error: unknown): void => {
      unhandled.push(error);
    };
    process.on('unhandledRejection', onUnhandled);

    await vi.advanceTimersByTimeAsync(ENV.ENQUEUE_TIMEOUT_MS);
    const errors = await Promise.all(outcomes);
    expect(errors.every((error) => error instanceof Error)).toBe(true);
    expect(errors.some((error) => (error as Error).message.includes('timed out'))).toBe(true);
    expect(service.queue.add).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(PRODUCER_RETIRE_BOUND_MS - ENV.ENQUEUE_TIMEOUT_MS);
    expect(service.activeGenerationCount).toBe(0);
    expect(service.inFlightCount).toBe(0);
    expect(service.queue.close).toHaveBeenCalledTimes(1);
    expect(unhandled).toEqual([]);
    process.removeListener('unhandledRejection', onUnhandled);
  });

  it('add timeout hard-disconnects once, settles concurrent adds, and retires once', async () => {
    vi.useFakeTimers();
    const adds: Array<ReturnType<typeof deferred<Job>>> = [];
    let disconnected = false;
    const add = vi.fn(() => {
      const flight = deferred<Job>();
      adds.push(flight);
      return flight.promise;
    });
    const service = new ControlledOrdersQueueService({
      readiness: Promise.resolve(),
      add,
      disconnect: () => {
        if (!disconnected) {
          disconnected = true;
          for (const flight of adds) flight.reject(new Error('disconnected'));
        }
      },
    });
    const calls = [service.enqueue(PAYLOAD), service.enqueue({ ...PAYLOAD, userId: 'bob' })];
    const outcomes = calls.map((call) =>
      call.then(
        () => null,
        (error: unknown) => error,
      ),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(add).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(ENV.ENQUEUE_TIMEOUT_MS);
    const errors = await Promise.all(outcomes);
    expect(errors.some((error) => (error as Error).message.includes('timed out'))).toBe(true);
    await vi.advanceTimersByTimeAsync(PRODUCER_RETIRE_BOUND_MS - ENV.ENQUEUE_TIMEOUT_MS);
    expect(service.queue.close).toHaveBeenCalledTimes(1);
    expect(service.redis.disconnect).toHaveBeenCalledTimes(2);
    expect(service.activeGenerationCount).toBe(0);
    expect(service.inFlightCount).toBe(0);
  });

  it('caps callers at 64 while shared readiness is pending', async () => {
    vi.useFakeTimers();
    const ready = deferred<unknown>();
    const service = new ControlledOrdersQueueService({
      readiness: ready.promise,
      disconnect: () => ready.reject(new Error('disconnected')),
    });
    const calls = Array.from({ length: MAX_PRODUCER_IN_FLIGHT }, (_, index) =>
      service.enqueue({ ...PAYLOAD, userId: `user-${index}` }).catch((error: unknown) => error),
    );
    expect(service.inFlightCount).toBe(MAX_PRODUCER_IN_FLIGHT);
    await expect(service.enqueue({ ...PAYLOAD, userId: 'overflow' })).rejects.toThrow(
      'in-flight limit',
    );
    await vi.advanceTimersByTimeAsync(ENV.ENQUEUE_TIMEOUT_MS);
    await Promise.all(calls);
  });

  it('shares close/retirement, owns close rejection, and removes both exact listeners once', async () => {
    const ready = deferred<unknown>();
    const close = vi.fn().mockRejectedValue(new Error('close failed'));
    let disconnected = false;
    const service = new ControlledOrdersQueueService({
      readiness: ready.promise,
      close,
      disconnect: () => {
        if (!disconnected) {
          disconnected = true;
          ready.reject(new Error('disconnected'));
        }
      },
    });
    const enqueue = service.enqueue(PAYLOAD);
    const enqueueProof = expect(enqueue).rejects.toThrow('disconnected');
    const removeRedis = vi.spyOn(service.redis, 'removeListener');
    const removeQueue = vi.spyOn(service.queue, 'removeListener');
    const redisListener = service.redis.listeners('error')[0];
    const queueListener = service.queue.listeners('error')[0];

    const first = service.close();
    const second = service.close();
    expect(first).toBe(second);
    await expect(first).resolves.toBeUndefined();
    await enqueueProof;
    expect(close).toHaveBeenCalledTimes(1);
    expect(removeRedis).toHaveBeenCalledWith('error', redisListener);
    expect(removeQueue).toHaveBeenCalledWith('error', queueListener);
    expect(service.redis.listenerCount('error')).toBe(0);
    expect(service.queue.listenerCount('error')).toBe(0);
    expect(service.activeGenerationCount).toBe(0);
    expect(service.inFlightCount).toBe(0);
  });

  it('reopens only after completed retirement and the frozen backoff', async () => {
    vi.useFakeTimers();
    const firstReady = deferred<unknown>();
    let disconnected = false;
    const service = new ControlledOrdersQueueService({
      readiness: firstReady.promise,
      disconnect: () => {
        if (!disconnected) {
          disconnected = true;
          firstReady.reject(new Error('disconnected'));
        }
      },
    });
    const first = service.enqueue(PAYLOAD);
    const proof = expect(first).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(ENV.ENQUEUE_TIMEOUT_MS);
    await proof;
    await vi.runAllTicks();
    await expect(service.enqueue(PAYLOAD)).rejects.toThrow('backoff');
    await vi.advanceTimersByTimeAsync(PRODUCER_REOPEN_BACKOFF_MS);
  });
});
