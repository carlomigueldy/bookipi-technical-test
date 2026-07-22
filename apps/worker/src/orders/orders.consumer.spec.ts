import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  workers: [] as Array<Record<string, ReturnType<typeof vi.fn>>>,
  events: [] as Array<Record<string, ReturnType<typeof vi.fn>>>,
  redis: [] as Array<{
    on: ReturnType<typeof vi.fn>;
    quit: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
  }>,
  workerArgs: [] as unknown[][],
  nextWorker: null as Record<string, ReturnType<typeof vi.fn>> | null,
}));

function makeWorker() {
  let finishRun!: () => void;
  let rejectRun!: (error: unknown) => void;
  const runLifetime = new Promise<void>((resolve, reject) => {
    finishRun = resolve;
    rejectRun = reject;
  });
  const worker = {
    on: vi.fn().mockReturnThis(),
    waitUntilReady: vi.fn(async () => undefined),
    startStalledCheckTimer: vi.fn(async () => undefined),
    run: vi.fn(() => runLifetime),
    isRunning: vi.fn(() => true),
    pause: vi.fn(async () => undefined),
    close: vi.fn(async () => finishRun()),
    removeAllListeners: vi.fn(),
    finishRun: vi.fn(() => finishRun()),
    rejectRun: vi.fn((error: unknown) => rejectRun(error)),
  };
  mocks.workers.push(worker);
  return worker;
}

function makeEvents() {
  const events = {
    on: vi.fn().mockReturnThis(),
    off: vi.fn().mockReturnThis(),
    waitUntilReady: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    removeAllListeners: vi.fn(),
  };
  mocks.events.push(events);
  return events;
}

vi.mock('bullmq', async () => {
  const actual = await vi.importActual<typeof import('bullmq')>('bullmq');
  return {
    ...actual,
    Worker: class {
      constructor(...args: unknown[]) {
        mocks.workerArgs.push(args);
        if (mocks.nextWorker) {
          const worker = mocks.nextWorker;
          mocks.nextWorker = null;
          mocks.workers.push(worker);
          return worker;
        }
        return makeWorker();
      }
    },
    QueueEvents: class {
      constructor() {
        return makeEvents();
      }
    },
  };
});

vi.mock('@flash/redis', () => ({
  createRedisClient: vi.fn(() => {
    const redis = {
      on: vi.fn().mockReturnThis(),
      quit: vi.fn(async () => 'OK'),
      disconnect: vi.fn(),
    };
    mocks.redis.push(redis);
    return redis;
  }),
}));

import {
  BULLMQ_MAX_STALLED_FAILED_REASON,
  ORDERS_LOCK_DURATION_MS,
  ORDERS_MAX_STALLED_COUNT,
  ORDERS_STALLED_INTERVAL_MS,
  OrdersConsumer,
} from './orders.consumer.js';

const env = {
  REDIS_URL: 'redis://localhost:6380',
  ORDERS_QUEUE_NAME: 'orders',
  WORKER_CONCURRENCY: 7,
};

beforeEach(() => {
  mocks.workers.length = 0;
  mocks.events.length = 0;
  mocks.redis.length = 0;
  mocks.workerArgs.length = 0;
  mocks.nextWorker = null;
});

describe('OrdersConsumer', () => {
  it('pins the installed BullMQ max-stalled terminal contract', () => {
    expect(ORDERS_MAX_STALLED_COUNT).toBe(2);
    expect(BULLMQ_MAX_STALLED_FAILED_REASON).toBe('job stalled more than allowable limit');
  });

  it('prepares exactly one recovery Worker with frozen options and no processing', async () => {
    const processor = { process: vi.fn() };
    const consumer = new OrdersConsumer(env as never, processor as never);
    const first = consumer.prepareForBootstrapRecovery();
    const second = consumer.prepareForBootstrapRecovery();
    expect(first).toBe(second);
    await first;

    expect(mocks.workers).toHaveLength(1);
    expect(mocks.workerArgs[0]?.[2]).toEqual(
      expect.objectContaining({
        concurrency: 7,
        autorun: false,
        lockDuration: ORDERS_LOCK_DURATION_MS,
        stalledInterval: ORDERS_STALLED_INTERVAL_MS,
        maxStalledCount: ORDERS_MAX_STALLED_COUNT,
      }),
    );
    expect(mocks.workers[0]?.startStalledCheckTimer).toHaveBeenCalledOnce();
    expect(mocks.workers[0]?.run).not.toHaveBeenCalled();
    expect(processor.process).not.toHaveBeenCalled();
    expect(consumer.ready).toBe(false);
    await consumer.close();
  });

  it('reuses the prepared Worker and starts one handled run lifetime', async () => {
    const consumer = new OrdersConsumer(env as never, { process: vi.fn() } as never);
    await consumer.prepareForBootstrapRecovery();
    await Promise.all([consumer.start(), consumer.start()]);
    expect(mocks.workers).toHaveLength(1);
    expect(mocks.workers[0]?.startStalledCheckTimer).toHaveBeenCalledOnce();
    expect(mocks.workers[0]?.run).toHaveBeenCalledOnce();
    expect(consumer.ready).toBe(true);
    await consumer.close();
    expect(mocks.workers[0]?.pause).toHaveBeenCalledWith(true);
    expect(mocks.workers[0]?.close).toHaveBeenCalledOnce();
    expect(consumer.ready).toBe(false);
  });

  it('cleans a partial preparation generation and permits one clean retry', async () => {
    const consumer = new OrdersConsumer(env as never, { process: vi.fn() } as never);
    const firstWorker = makeWorker();
    firstWorker.waitUntilReady.mockRejectedValueOnce(new Error('worker readiness failed'));
    mocks.workers.pop();
    mocks.nextWorker = firstWorker;
    await expect(consumer.prepareForBootstrapRecovery()).rejects.toThrow('worker readiness failed');
    expect(firstWorker.close).toHaveBeenCalledOnce();
    expect(mocks.events[0]?.close).toHaveBeenCalledOnce();
    expect(mocks.redis.slice(0, 2).every((redis) => redis.quit.mock.calls.length === 1)).toBe(true);

    await consumer.prepareForBootstrapRecovery();
    expect(mocks.workers).toHaveLength(2);
    expect(mocks.workers[1]?.startStalledCheckTimer).toHaveBeenCalledOnce();
    await consumer.close();
  });

  it('fully closes recovery-only resources through one idempotent close promise', async () => {
    const consumer = new OrdersConsumer(env as never, { process: vi.fn() } as never);
    await consumer.prepareForBootstrapRecovery();
    const first = consumer.close();
    expect(first).toBe(consumer.close());
    await first;
    expect(mocks.workers[0]?.pause).not.toHaveBeenCalled();
    expect(mocks.workers[0]?.close).toHaveBeenCalledOnce();
    expect(mocks.events[0]?.close).toHaveBeenCalledOnce();
    expect(mocks.redis.every((redis) => redis.quit.mock.calls.length === 1)).toBe(true);
  });

  it.each(['resolved', 'rejected'] as const)(
    'emits one typed unexpected %s termination and clears readiness',
    async (kind) => {
      const consumer = new OrdersConsumer(env as never, { process: vi.fn() } as never);
      const listener = vi.fn();
      consumer.onUnexpectedRunTermination(listener);
      await consumer.start();
      const worker = mocks.workers[0];
      if (kind === 'resolved') (worker?.finishRun as ReturnType<typeof vi.fn>)();
      else (worker?.rejectRun as ReturnType<typeof vi.fn>)(new Error('run failed'));
      await vi.waitFor(() => expect(listener).toHaveBeenCalledOnce());
      expect(consumer.ready).toBe(false);
      expect(listener).toHaveBeenCalledWith(
        kind === 'resolved'
          ? { kind: 'resolved' }
          : { kind: 'rejected', error: expect.objectContaining({ message: 'run failed' }) },
      );
      await consumer.close();
    },
  );

  it('isolates throwing termination listeners and supports idempotent unsubscribe', async () => {
    const consumer = new OrdersConsumer(env as never, { process: vi.fn() } as never);
    const observed = vi.fn();
    consumer.onUnexpectedRunTermination(() => {
      throw new Error('listener failed');
    });
    consumer.onUnexpectedRunTermination(observed);
    const removed = vi.fn();
    const unsubscribe = consumer.onUnexpectedRunTermination(removed);
    unsubscribe();
    unsubscribe();
    await consumer.start();
    (mocks.workers[0]?.finishRun as ReturnType<typeof vi.fn>)();
    await vi.waitFor(() => expect(observed).toHaveBeenCalledOnce());
    expect(removed).not.toHaveBeenCalled();
    await consumer.close();
  });

  it('does not emit termination when close settles the run loop', async () => {
    const consumer = new OrdersConsumer(env as never, { process: vi.fn() } as never);
    const observed = vi.fn();
    consumer.onUnexpectedRunTermination(observed);
    await consumer.start();
    await consumer.close();
    expect(observed).not.toHaveBeenCalled();
  });

  it('closes created resources before awaiting a pending preparation', async () => {
    const consumer = new OrdersConsumer(env as never, { process: vi.fn() } as never);
    let rejectReadiness!: (error: unknown) => void;
    const worker = makeWorker();
    worker.waitUntilReady.mockReturnValue(
      new Promise<void>((_resolve, reject) => {
        rejectReadiness = reject;
      }) as never,
    );
    worker.close.mockImplementation(async () => {
      rejectReadiness(new Error('closed while preparing'));
      worker.finishRun();
    });
    mocks.workers.pop();
    mocks.nextWorker = worker;
    const preparing = consumer.prepareForBootstrapRecovery();
    await vi.waitFor(() => expect(worker.waitUntilReady).toHaveBeenCalledOnce());
    await expect(consumer.close()).resolves.toBeUndefined();
    await expect(preparing).rejects.toThrow('closed while preparing');
    expect(worker.close).toHaveBeenCalledOnce();
  });
});
