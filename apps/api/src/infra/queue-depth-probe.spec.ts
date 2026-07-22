import type { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ApiEnv } from '../config/env.js';
import {
  QUEUE_DEPTH_DEADLINE_MS,
  QueueDepthProbe,
  type ObserverGeneration,
} from './queue-depth-probe.js';

const env = {
  REDIS_URL: 'redis://observer.invalid:6379',
  ORDERS_QUEUE_NAME: 'orders',
} as ApiEnv;

class TestQueueDepthProbe extends QueueDepthProbe {
  constructor(private readonly factory: () => ObserverGeneration) {
    super(env);
  }

  protected override createGeneration(): ObserverGeneration {
    return this.factory();
  }
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('QueueDepthProbe', () => {
  it('shares one flight, force-cancels it at 750ms, and creates one fresh generation', async () => {
    vi.useFakeTimers();
    const commands = [deferred<Record<string, number>>(), deferred<Record<string, number>>()];
    let generationIndex = 0;
    const getJobCounts = vi.fn(() => commands[generationIndex - 1]!.promise);
    const disconnect = vi.fn();
    const close = vi.fn().mockResolvedValue(undefined);
    const factory = vi.fn(() => {
      const index = generationIndex;
      generationIndex += 1;
      const generation: ObserverGeneration = {
        redis: {
          disconnect: (reconnect: boolean) => {
            disconnect(reconnect);
            commands[index]!.reject(new Error('disconnected'));
          },
        } as unknown as Redis,
        queue: { getJobCounts, close } as unknown as Queue,
        closePromise: null,
      };
      return generation;
    });
    const probe = new TestQueueDepthProbe(factory);

    const calls = Array.from({ length: 100 }, () => probe.depth());
    const settledCalls = Promise.allSettled(calls);
    expect(getJobCounts).toHaveBeenCalledTimes(1);
    expect(probe.inFlightCount).toBe(1);
    await vi.advanceTimersByTimeAsync(QUEUE_DEPTH_DEADLINE_MS);
    const results = await settledCalls;

    expect(results.every((result) => result.status === 'rejected')).toBe(true);
    expect(disconnect).toHaveBeenCalledWith(false);
    expect(probe.activeGenerationCount).toBe(0);
    expect(probe.inFlightCount).toBe(0);

    const next = probe.depth();
    expect(factory).toHaveBeenCalledTimes(2);
    expect(getJobCounts).toHaveBeenCalledTimes(2);
    commands[1]!.resolve({ waiting: 2, active: 1, delayed: 3, failed: 4 });
    await expect(next).resolves.toEqual({ waiting: 2, active: 1, delayed: 3, failed: 4 });
    await probe.close();
  });

  it('rejects new observations after idempotent close begins', async () => {
    const command = deferred<Record<string, number>>();
    const disconnect = vi.fn(() => command.reject(new Error('closed')));
    const generation: ObserverGeneration = {
      redis: { disconnect } as unknown as Redis,
      queue: {
        getJobCounts: () => command.promise,
        close: vi.fn().mockResolvedValue(undefined),
      } as unknown as Queue,
      closePromise: null,
    };
    const probe = new TestQueueDepthProbe(() => generation);

    const active = probe.depth();
    const firstClose = probe.close();
    await expect(active).rejects.toThrow('closed');
    await firstClose;
    await probe.close();
    await expect(probe.depth()).rejects.toThrow('closing');
  });

  it('bounds a never-settling observer Queue.close and owns its late rejection', async () => {
    vi.useFakeTimers();
    const command = deferred<Record<string, number>>();
    const queueClose = deferred<void>();
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    const generation: ObserverGeneration = {
      redis: { disconnect: vi.fn() } as unknown as Redis,
      queue: {
        getJobCounts: () => command.promise,
        close: vi.fn(() => queueClose.promise),
      } as unknown as Queue,
      closePromise: null,
    };
    const probe = new TestQueueDepthProbe(() => generation);

    const depth = probe.depth();
    command.resolve({ waiting: 0, active: 0, delayed: 0, failed: 0 });
    await depth;
    const close = probe.close();
    let settled = false;
    void close.then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(QUEUE_DEPTH_DEADLINE_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(close).resolves.toBeUndefined();
    expect(probe.activeGenerationCount).toBe(0);

    queueClose.reject(new Error('late observer close rejection'));
    await Promise.resolve();
    await Promise.resolve();
    expect(unhandled).not.toHaveBeenCalled();
    process.off('unhandledRejection', unhandled);
  });
});
