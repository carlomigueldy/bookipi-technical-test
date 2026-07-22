import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { installProcessHandlers, superviseWorkerLifecycle } from './main.js';

const processEvents = ['SIGTERM', 'SIGINT', 'unhandledRejection', 'uncaughtException'] as const;

function snapshotProcessListeners(): () => void {
  const emitter = process as import('node:events').EventEmitter;
  const before = new Map(
    processEvents.map((event) => [
      event,
      new Set(emitter.listeners(event) as Array<(...args: unknown[]) => void>),
    ]),
  );
  return () => {
    for (const event of processEvents) {
      for (const listener of emitter.listeners(event) as Array<(...args: unknown[]) => void>) {
        if (!before.get(event)?.has(listener)) emitter.removeListener(event, listener);
      }
    }
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('superviseWorkerLifecycle', () => {
  it('starts once and propagates fatal-channel rejection', async () => {
    const fatal = new Error('consumer terminated');
    const reconciliation = {
      start: vi.fn(async () => undefined),
      waitForFatal: vi.fn(async (): Promise<never> => {
        throw fatal;
      }),
    };
    await expect(superviseWorkerLifecycle(reconciliation)).rejects.toBe(fatal);
    expect(reconciliation.start).toHaveBeenCalledOnce();
    expect(reconciliation.waitForFatal).toHaveBeenCalledOnce();
  });

  it('rejects an impossible fatal-channel resolution', async () => {
    const reconciliation = {
      start: vi.fn(async () => undefined),
      waitForFatal: vi.fn(async () => undefined as never),
    };
    await expect(superviseWorkerLifecycle(reconciliation)).rejects.toThrow(
      'worker fatal channel resolved unexpectedly',
    );
  });

  it('takes the exit-1 branch without a shutdown-completed log when shutdown rejects', async () => {
    vi.useFakeTimers();
    const cleanupListeners = snapshotProcessListeners();
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const log = vi.spyOn(Logger, 'log');
    const shutdownFn = vi.fn(async () => {
      throw new Error('reconciliation shutdown failed');
    });
    try {
      installProcessHandlers({ shutdownFn, watchdogMs: 1000 });
      process.emit('SIGTERM');
      await Promise.resolve();
      await Promise.resolve();
      expect(shutdownFn).toHaveBeenCalledWith(0);
      expect(exit).toHaveBeenCalledWith(1);
      expect(log).not.toHaveBeenCalledWith(
        expect.objectContaining({ event: 'worker.shutdown_completed' }),
        'Bootstrap',
      );
    } finally {
      cleanupListeners();
    }
  });

  it('keeps the clean signal path at exit 0', async () => {
    vi.useFakeTimers();
    const cleanupListeners = snapshotProcessListeners();
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const shutdownFn = vi.fn(async () => undefined);
    try {
      installProcessHandlers({ shutdownFn, watchdogMs: 1000 });
      process.emit('SIGINT');
      await Promise.resolve();
      await Promise.resolve();
      expect(shutdownFn).toHaveBeenCalledWith(0);
      expect(exit).not.toHaveBeenCalled();
    } finally {
      cleanupListeners();
    }
  });
});
