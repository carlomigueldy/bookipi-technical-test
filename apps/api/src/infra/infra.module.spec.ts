import { EventEmitter } from 'node:events';
import type { Redis } from 'ioredis';
import type { Pool } from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { InfraModule } from './infra.module.js';
import type { QueueDepthProbe } from './queue-depth-probe.js';
import type { OrdersQueueService } from '../queue/orders-queue.service.js';

function never(): Promise<never> {
  return new Promise(() => undefined);
}

function fakeRedis() {
  const client = new EventEmitter() as EventEmitter & {
    status: string;
    quit: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
  };
  client.status = 'ready';
  client.quit = vi.fn(never);
  client.disconnect = vi.fn();
  return client;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('InfraModule shutdown', () => {
  it('forces progress through every resource and shares one shutdown sequence', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const store = fakeRedis();
    const limiter = fakeRedis();
    const queue = {
      close: vi.fn(never),
    } as unknown as OrdersQueueService;
    const observer = { close: vi.fn().mockResolvedValue(undefined) } as unknown as QueueDepthProbe;
    const pool = { end: vi.fn(never) } as unknown as Pool;
    const lifecycle = new InfraModule(
      store as unknown as Redis,
      limiter as unknown as Redis,
      pool,
      queue,
      observer,
    );

    const first = lifecycle.onApplicationShutdown();
    const second = lifecycle.onApplicationShutdown();
    expect(first).toBe(second);

    await vi.advanceTimersByTimeAsync(1000);
    expect(observer.close).toHaveBeenCalledTimes(1);
    expect(store.quit).toHaveBeenCalledTimes(1);
    expect(limiter.quit).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1000);
    expect(store.disconnect).toHaveBeenCalledWith(false);
    expect(limiter.disconnect).toHaveBeenCalledWith(false);
    expect(pool.end).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(3000);
    await expect(first).resolves.toBeUndefined();
    expect(queue.close).toHaveBeenCalledTimes(1);
    expect(pool.end).toHaveBeenCalledTimes(1);
  });

  it('does not let a never-settling observer close starve Redis or Postgres', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const observerClose = new Promise<void>(() => undefined);
    const makeGracefulRedis = () => {
      const client = fakeRedis();
      client.quit.mockImplementation(async () => {
        client.status = 'end';
        client.emit('end');
        return 'OK';
      });
      return client;
    };
    const store = makeGracefulRedis();
    const limiter = makeGracefulRedis();
    const queue = {
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as OrdersQueueService;
    const observer = { close: vi.fn(() => observerClose) } as unknown as QueueDepthProbe;
    const pool = { end: vi.fn().mockResolvedValue(undefined) } as unknown as Pool;
    const lifecycle = new InfraModule(
      store as unknown as Redis,
      limiter as unknown as Redis,
      pool,
      queue,
      observer,
    );

    const shutdown = lifecycle.onApplicationShutdown();
    await vi.advanceTimersByTimeAsync(999);
    expect(store.quit).not.toHaveBeenCalled();
    expect(pool.end).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await expect(shutdown).resolves.toBeUndefined();
    expect(store.quit).toHaveBeenCalledTimes(1);
    expect(limiter.quit).toHaveBeenCalledTimes(1);
    expect(pool.end).toHaveBeenCalledTimes(1);
  });
});
