import { afterEach, describe, expect, it, vi } from 'vitest';
import { BULLMQ_MAX_STALLED_FAILED_REASON } from '../orders/orders.consumer.js';
import {
  createReconciliationState,
  isTerminalFailedJobEligible,
  ReconciliationService,
  WorkerLifecycleAbortError,
} from './reconciliation.service.js';

const R1 = '11111111-1111-4111-8111-111111111111';
const R2 = '22222222-2222-4222-8222-222222222222';
const payload = {
  saleId: 'flash-2026',
  userId: 'user-001',
  reservationId: R1,
  reservedAtMs: 123,
  requestId: 'req-1',
};

function queueJob(reservationId = R1, state = 'failed', overrides: Record<string, unknown> = {}) {
  return {
    name: 'persist-order',
    data: { ...payload, reservationId },
    id: 'flash-2026-user-001',
    opts: { attempts: 5 },
    attemptsMade: 5,
    stalledCounter: 0,
    failedReason: 'ordinary PG error',
    getState: vi.fn(async () => state),
    remove: vi.fn(async () => undefined),
    ...overrides,
  };
}

function makeService() {
  const env = {
    SALE_ID: 'flash-2026',
    SALE_NAME: 'Sale',
    SALE_TOTAL_STOCK: 10,
    SALE_STARTS_AT: '2026-07-22T12:00:00.000Z',
    SALE_ENDS_AT: '2026-07-22T13:00:00.000Z',
    WORKER_RECONCILE_SCAN_COUNT: 2,
    WORKER_DLQ_SCAN_COUNT: 2,
    WORKER_RECONCILE_INTERVAL_MS: 1000,
    WORKER_DLQ_SWEEP_INTERVAL_MS: 1000,
  };
  const store = {
    status: vi.fn(async () => ({
      initialized: true,
      name: 'Sale',
      totalStock: 10,
      startsAtMs: Date.parse(env.SALE_STARTS_AT),
      endsAtMs: Date.parse(env.SALE_ENDS_AT),
    })),
    seed: vi.fn(),
    compensate: vi.fn(async () => ({ outcome: 'COMPENSATED', stockRemaining: 1 })),
    compareAndRestoreReservation: vi.fn(async (_saleId: string, candidate: unknown) => ({
      outcome: 'ALREADY_MATCHED',
      current: candidate,
    })),
    scanReservations: vi.fn(async () => ({ cursor: '0', entries: [] })),
    scanBuyers: vi.fn(async () => ({ cursor: '0', userIds: [] })),
    reconcileBuyerMembership: vi.fn(async () => 'PRESENT'),
    reconcileStockFromReservations: vi.fn(async () => ({ outcome: 'RECONCILED' })),
  };
  const getJobs = vi.fn(async (..._args: unknown[]): Promise<unknown[]> => []);
  const getJob = vi.fn(async (..._args: unknown[]): Promise<unknown | null> => null);
  let paused = false;
  const queue = {
    pause: vi.fn(async () => {
      paused = true;
    }),
    resume: vi.fn(async () => {
      paused = false;
    }),
    isPaused: vi.fn(async () => paused),
    getActiveCount: vi.fn(async () => 0),
    getJobs,
    getJob,
    getFailedCount: vi.fn(async () => 0),
    getJobCounts: vi.fn(async () => ({ active: 0, failed: 0 })),
    add: vi.fn(async (_name: string, data: unknown) =>
      queueJob((data as typeof payload).reservationId, 'waiting', { data }),
    ),
  };
  const repository = {
    withSessionReconciliationLock: vi.fn(
      async (work: () => Promise<unknown>, _signal?: AbortSignal) => work(),
    ),
    ensureSale: vi.fn(async () => undefined),
    listSaleOrders: vi.fn(async (): Promise<Array<Record<string, unknown>>> => []),
    resolveFailed: vi.fn(async () => 'persisted'),
    getByUser: vi.fn(async () => null),
  };
  const consumer = {
    ready: true,
    prepareForBootstrapRecovery: vi.fn(async () => undefined),
    start: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    onFailedHint: vi.fn(() => vi.fn()),
    onUnexpectedRunTermination: vi.fn((_listener: (...args: unknown[]) => void) => vi.fn()),
  };
  const state = createReconciliationState();
  return {
    service: new ReconciliationService(
      env as never,
      store as never,
      queue as never,
      state,
      repository as never,
      consumer as never,
    ),
    env,
    store,
    queue,
    repository,
    consumer,
    state,
  };
}

afterEach(() => vi.useRealTimers());

describe('ReconciliationService', () => {
  it('coalesces concurrent triggers into a single flight', async () => {
    const { service } = makeService();
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const run = vi
      .spyOn(service as unknown as { runContinuousPass(): Promise<void> }, 'runContinuousPass')
      .mockImplementation(async () => barrier);
    const first = service.triggerPass();
    expect(service.triggerPass()).toBe(first);
    release();
    await first;
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('classifies invalid entries independently and continues later pages and states', async () => {
    const { service, queue } = makeService();
    const badName = queueJob(R1, 'waiting', { name: 'wrong', id: 'bad-name' });
    const badPayload = queueJob(R1, 'waiting', { data: { invalid: true }, id: 'bad-payload' });
    const badId = queueJob(R1, 'waiting', { id: 'wrong-id' });
    const valid = queueJob(R1, 'waiting');
    queue.getJobs.mockImplementation(async (states, start) => {
      if ((states as string[])[0] !== 'waiting') return [];
      if (start === 0) return [badName, badPayload];
      if (start === 2) return [badId, valid];
      return [];
    });
    const result = await (
      service as unknown as {
        scanJobs(): Promise<{ jobs: unknown[]; issues: Array<{ code: string }> }>;
      }
    ).scanJobs();
    expect(result.jobs).toHaveLength(1);
    expect(result.issues.map((issue) => issue.code)).toEqual([
      'UNEXPECTED_NAME',
      'INVALID_PAYLOAD',
      'JOB_ID_MISMATCH',
    ]);
    expect(
      queue.getJobs.mock.calls.some(([states]) => (states as string[])[0] === 'completed'),
    ).toBe(true);
    expect(
      queue.getJobs.mock.calls.every((call) => (call[2] as number) - (call[1] as number) + 1 <= 2),
    ).toBe(true);
  });

  it('keeps a BullMQ page-read failure operational', async () => {
    const { service, queue } = makeService();
    queue.getJobs.mockRejectedValue(new Error('redis down'));
    await expect(
      (service as unknown as { scanJobs(): Promise<unknown> }).scanJobs(),
    ).rejects.toThrow('redis down');
  });

  it.each([
    ['failed', 5, 0, 'ordinary PG error', 5, true],
    ['failed', 7, 0, 'ordinary PG error', 5, true],
    ['failed', 0, 3, BULLMQ_MAX_STALLED_FAILED_REASON, 5, true],
    ['failed', 4, 2, BULLMQ_MAX_STALLED_FAILED_REASON, 5, false],
    ['failed', 4, 3, `prefix ${BULLMQ_MAX_STALLED_FAILED_REASON}`, 5, false],
    ['waiting', 5, 3, BULLMQ_MAX_STALLED_FAILED_REASON, 5, false],
    ['failed', 5, 3, BULLMQ_MAX_STALLED_FAILED_REASON, 4, false],
  ])(
    'applies the exact terminal matrix %#',
    async (state, attemptsMade, stalledCounter, failedReason, attempts, eligible) => {
      const job = queueJob(R1, state as string, {
        attemptsMade,
        stalledCounter,
        failedReason,
        opts: { attempts },
      });
      await expect(isTerminalFailedJobEligible(job as never)).resolves.toBe(eligible);
    },
  );

  it('retains unsafe failed entries, resolves valid neighbors, and advances without throwing', async () => {
    const { service, queue, repository } = makeService();
    const malformed = queueJob(R1, 'failed', { name: 'bad', id: 'malformed' });
    const nonterminal = queueJob(R1, 'failed', { attemptsMade: 1 });
    const valid = queueJob(R1, 'failed', {
      id: 'flash-2026-user-002',
      data: { ...payload, userId: 'user-002' },
    });
    queue.getFailedCount.mockResolvedValue(3);
    queue.getJobs.mockResolvedValue([malformed, valid]);
    const first = await (
      service as unknown as {
        sweepFailed(): Promise<{ retainedUnsafeCount: number; removedCount: number }>;
      }
    ).sweepFailed();
    expect(first).toEqual({ retainedUnsafeCount: 1, removedCount: 1 });
    expect(repository.resolveFailed).toHaveBeenCalledOnce();
    queue.getJobs.mockResolvedValue([nonterminal]);
    const second = await (
      service as unknown as { sweepFailed(): Promise<{ retainedUnsafeCount: number }> }
    ).sweepFailed();
    expect(second.retainedUnsafeCount).toBe(1);
  });

  it('attempts the rest of a failed page before throwing an operational resolution error', async () => {
    const { service, queue, repository } = makeService();
    const first = queueJob(R1);
    const second = queueJob(R1, 'failed', {
      id: 'flash-2026-user-002',
      data: { ...payload, userId: 'user-002' },
    });
    queue.getFailedCount.mockResolvedValue(2);
    queue.getJobs.mockResolvedValue([first, second]);
    repository.resolveFailed
      .mockRejectedValueOnce(new Error('pg down'))
      .mockResolvedValueOnce('persisted');
    await expect(
      (service as unknown as { sweepFailed(): Promise<unknown> }).sweepFailed(),
    ).rejects.toThrow('terminal jobs failed resolution');
    expect(repository.resolveFailed).toHaveBeenCalledTimes(2);
  });

  it('boots and starts the consumer while retained malformed jobs keep readiness degraded', async () => {
    const { service, queue, consumer, state } = makeService();
    const malformed = queueJob(R1, 'failed', { name: 'bad', id: 'malformed' });
    queue.getJobs.mockImplementation(async (states) =>
      (states as string[])[0] === 'failed' ? [malformed] : [],
    );
    queue.getFailedCount.mockResolvedValue(1);
    await service.start();
    expect(state.bootstrapReconciled).toBe(true);
    expect(state.consumerReady).toBe(true);
    expect(state.reconciliationHealthy).toBe(false);
    expect(state.retainedQueueEntries).toBeGreaterThan(0);
    expect(consumer.start).toHaveBeenCalledOnce();
    expect(queue.resume).toHaveBeenCalledOnce();
    expect(consumer.onFailedHint).toHaveBeenCalledOnce();
    await service.stop();
  });

  it('pauses and verifies before recovery, then starts processing and installs lifecycle before resume', async () => {
    vi.useFakeTimers();
    const { service, queue, consumer, repository, state } = makeService();
    const order: string[] = [];
    repository.withSessionReconciliationLock.mockImplementation(
      async (work: () => Promise<unknown>) => {
        order.push('lock');
        const result = await work();
        order.push(
          state.bootstrapReconciled && state.consumerReady
            ? 'state-commit-before-unlock'
            : 'unlock-before-commit',
        );
        order.push('unlock');
        return result;
      },
    );
    queue.pause.mockImplementation(async () => {
      order.push('pause');
    });
    queue.isPaused.mockResolvedValueOnce(true).mockImplementationOnce(async () => {
      order.push('resume-verified');
      return false;
    });
    consumer.prepareForBootstrapRecovery.mockImplementation(async () => {
      order.push('prepare');
    });
    consumer.onUnexpectedRunTermination.mockImplementation(() => {
      order.push('termination-listener');
      return vi.fn();
    });
    queue.getActiveCount.mockImplementation(async () => {
      order.push('active-zero');
      return 0;
    });
    vi.spyOn(
      service as unknown as {
        runDiff(): Promise<{ degraded: boolean; queueIssueCount: number }>;
      },
      'runDiff',
    ).mockImplementation(async () => {
      order.push('diff');
      return { degraded: false, queueIssueCount: 0 };
    });
    consumer.start.mockImplementation(async () => {
      order.push('consumer-start');
    });
    consumer.onFailedHint.mockImplementation(() => {
      order.push('hint');
      return vi.fn();
    });
    queue.resume.mockImplementation(async () => {
      order.push('resume');
    });

    await service.start();
    expect(order).toEqual([
      'lock',
      'pause',
      'prepare',
      'active-zero',
      'diff',
      'termination-listener',
      'consumer-start',
      'hint',
      'resume',
      'resume-verified',
      'state-commit-before-unlock',
      'unlock',
    ]);
    expect(state.bootstrapReconciled).toBe(true);
    expect(state.consumerReady).toBe(true);
    expect(state.reconciliationHealthy).toBe(true);
    await service.stop();
  });

  it('reuses recovery preparation across a bounded active-drain retry', async () => {
    vi.useFakeTimers();
    const { service, queue, consumer } = makeService();
    let activeReads = 0;
    queue.getActiveCount.mockImplementation(async () => {
      activeReads += 1;
      return activeReads <= 301 ? 1 : 0;
    });
    const diff = vi
      .spyOn(
        service as unknown as {
          runDiff(): Promise<{ degraded: boolean; queueIssueCount: number }>;
        },
        'runDiff',
      )
      .mockResolvedValue({ degraded: false, queueIssueCount: 0 });
    const starting = service.start();
    await vi.advanceTimersByTimeAsync(30_100);
    await starting;
    expect(queue.pause).toHaveBeenCalledTimes(2);
    expect(consumer.prepareForBootstrapRecovery).toHaveBeenCalledTimes(2);
    expect(diff).toHaveBeenCalledOnce();
    expect(consumer.start).toHaveBeenCalledOnce();
    expect(queue.resume).toHaveBeenCalledOnce();
    await service.stop();
  });

  it('does not prepare when the global pause cannot be verified', async () => {
    vi.useFakeTimers();
    const { service, queue, consumer } = makeService();
    queue.isPaused.mockResolvedValue(false);
    const starting = service.start();
    await vi.advanceTimersByTimeAsync(100);
    await service.stop();
    await vi.runAllTimersAsync();
    await expect(starting).rejects.toThrow('worker lifecycle stopped');
    expect(consumer.prepareForBootstrapRecovery).not.toHaveBeenCalled();
    expect(consumer.start).not.toHaveBeenCalled();
    expect(queue.resume).not.toHaveBeenCalled();
  });

  it('keeps readiness false when resume fails after one processing lifecycle', async () => {
    vi.useFakeTimers();
    const { service, queue, consumer, state } = makeService();
    queue.resume.mockRejectedValue(new Error('resume failed'));
    await expect(service.start()).rejects.toThrow('resume failed');
    expect(consumer.start).toHaveBeenCalledOnce();
    expect(consumer.onFailedHint).toHaveBeenCalledOnce();
    expect(state.bootstrapReconciled).toBe(false);
    expect(state.consumerReady).toBe(false);
    expect(state.reconciliationHealthy).toBe(false);
    expect(queue.pause).toHaveBeenCalledTimes(2);
    expect(consumer.close).toHaveBeenCalledOnce();
    await expect(service.stop()).rejects.toThrow('reconciliation shutdown failed');
  });

  it('keeps readiness false when resume returns but the queue is still paused', async () => {
    vi.useFakeTimers();
    const { service, queue, consumer, state } = makeService();
    queue.isPaused.mockResolvedValue(true);
    await expect(service.start()).rejects.toThrow('orders queue remained paused after resume');
    expect(consumer.start).toHaveBeenCalledOnce();
    expect(queue.resume).toHaveBeenCalledOnce();
    expect(state.consumerReady).toBe(false);
    expect(state.reconciliationHealthy).toBe(false);
    await expect(service.stop()).rejects.toThrow('reconciliation shutdown failed');
  });

  it('cleans the committed transition when the session fence fails to release', async () => {
    vi.useFakeTimers();
    const { service, repository, queue, consumer, state } = makeService();
    repository.withSessionReconciliationLock.mockImplementation(
      async (work: () => Promise<unknown>) => {
        await work();
        throw new Error('session unlock failed');
      },
    );
    await expect(service.start()).rejects.toThrow('session unlock failed');
    expect(state.bootstrapReconciled).toBe(false);
    expect(state.consumerReady).toBe(false);
    expect(state.reconciliationHealthy).toBe(false);
    expect(queue.pause).toHaveBeenCalledTimes(2);
    expect(consumer.start).toHaveBeenCalledOnce();
    expect(consumer.close).toHaveBeenCalledOnce();
    await expect(service.stop()).rejects.toThrow('reconciliation shutdown failed');
  });

  it.each([
    [{ kind: 'resolved' }],
    [{ kind: 'rejected', error: new Error('run crashed') }],
  ] as const)(
    'fails shared readiness and the handled fatal channel for termination %#',
    async (termination) => {
      vi.useFakeTimers();
      const { service, consumer, state } = makeService();
      const hintDisposer = vi.fn();
      const terminationDisposer = vi.fn();
      consumer.onFailedHint.mockReturnValue(hintDisposer);
      consumer.onUnexpectedRunTermination.mockReturnValue(terminationDisposer);
      const first = service.start();
      expect(service.start()).toBe(first);
      await first;
      const listener = consumer.onUnexpectedRunTermination.mock.calls[0]?.[0] as unknown as (
        value: typeof termination,
      ) => void;
      listener(termination);
      listener(termination);
      expect(state.consumerReady).toBe(false);
      expect(state.reconciliationHealthy).toBe(false);
      expect(hintDisposer).toHaveBeenCalledOnce();
      await expect(service.waitForFatal()).rejects.toMatchObject({
        name: 'ConsumerRunTerminatedError',
      });
      await service.stop();
      expect(terminationDisposer).toHaveBeenCalledOnce();
    },
  );

  it('aborts advisory polling, closes the consumer, and awaits startup during stop', async () => {
    const { service, repository, consumer, state } = makeService();
    const order: string[] = [];
    repository.withSessionReconciliationLock.mockImplementation(
      async (_work: () => Promise<unknown>, signal?: AbortSignal) => {
        if (!signal) throw new Error('test expected an abort signal');
        return new Promise((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => {
              order.push('startup-aborted');
              reject(signal.reason);
            },
            { once: true },
          );
        });
      },
    );
    consumer.close.mockImplementation(async () => {
      order.push('consumer-close');
    });
    const starting = service.start();
    await vi.waitFor(() => expect(repository.withSessionReconciliationLock).toHaveBeenCalledOnce());
    await service.stop();
    await expect(starting).rejects.toThrow('worker lifecycle stopped');
    expect(order).toEqual(['startup-aborted', 'consumer-close']);
    expect(state.bootstrapReconciled).toBe(false);
    expect(state.consumerReady).toBe(false);
    expect(state.reconciliationHealthy).toBe(false);
  });

  it('lets the exact abort reason win when close breaks pending consumer preparation', async () => {
    const { service, consumer, state } = makeService();
    let rejectPreparation!: (error: unknown) => void;
    consumer.prepareForBootstrapRecovery.mockReturnValue(
      new Promise<void>((_resolve, reject) => {
        rejectPreparation = reject;
      }) as never,
    );
    consumer.close.mockImplementation(async () => {
      rejectPreparation(new Error('Connection is closed.'));
    });
    const starting = service.start();
    await vi.waitFor(() => expect(consumer.prepareForBootstrapRecovery).toHaveBeenCalledOnce());
    await expect(service.stop()).resolves.toBeUndefined();
    await expect(starting).rejects.toBeInstanceOf(WorkerLifecycleAbortError);
    expect(state.bootstrapReconciled).toBe(false);
    expect(state.consumerReady).toBe(false);
    expect(state.reconciliationHealthy).toBe(false);
  });

  it('preserves a pre-consumer abort plus unlock aggregate through startup and stop', async () => {
    const { service, repository, consumer, state } = makeService();
    let combined!: AggregateError;
    repository.withSessionReconciliationLock.mockImplementation(
      async (_work: () => Promise<unknown>, signal?: AbortSignal) => {
        if (!signal) throw new Error('test expected an abort signal');
        return new Promise((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => {
              combined = new AggregateError(
                [signal.reason, new Error('unlock failed')],
                'abort and unlock failed',
              );
              reject(combined);
            },
            { once: true },
          );
        });
      },
    );
    const starting = service.start();
    await vi.waitFor(() => expect(repository.withSessionReconciliationLock).toHaveBeenCalledOnce());
    const stopping = service.stop();
    await expect(stopping).rejects.toMatchObject({
      message: 'reconciliation shutdown failed',
      errors: expect.arrayContaining([combined]),
    });
    await expect(starting).rejects.toBe(combined);
    expect(repository.withSessionReconciliationLock).toHaveBeenCalledOnce();
    expect(consumer.start).not.toHaveBeenCalled();
    expect(state.bootstrapReconciled).toBe(false);
    expect(state.consumerReady).toBe(false);
    expect(state.reconciliationHealthy).toBe(false);
  });

  it.each([
    ['distinct abort instance', (_reason: unknown) => new WorkerLifecycleAbortError()],
    ['aggregate abort', (reason: unknown) => new AggregateError([reason], 'wrapped abort')],
    ['abort cause', (reason: unknown) => new Error('wrapped abort', { cause: reason })],
  ] as const)('does not filter %s during shutdown', async (_label, makeFailure) => {
    const { service, repository } = makeService();
    repository.withSessionReconciliationLock.mockImplementation(
      async (_work: () => Promise<unknown>, signal?: AbortSignal) => {
        if (!signal) throw new Error('test expected an abort signal');
        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(makeFailure(signal.reason)), {
            once: true,
          });
        });
      },
    );
    const starting = service.start();
    await vi.waitFor(() => expect(repository.withSessionReconciliationLock).toHaveBeenCalledOnce());
    await expect(service.stop()).rejects.toThrow('reconciliation shutdown failed');
    await expect(starting).rejects.toBeDefined();
  });

  it('preserves post-start abort plus unlock failure after transition cleanup', async () => {
    vi.useFakeTimers();
    const { service, repository, queue, consumer, state } = makeService();
    let releaseBarrier!: () => void;
    const barrier = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });
    vi.spyOn(
      service as unknown as { afterQueueResumeVerified(): Promise<void> },
      'afterQueueResumeVerified',
    ).mockReturnValue(barrier);
    let combined!: AggregateError;
    repository.withSessionReconciliationLock.mockImplementation(
      async (work: () => Promise<unknown>) => {
        try {
          return await work();
        } catch (error) {
          combined = new AggregateError(
            [error, new Error('unlock failed after start')],
            'transition abort and unlock failed',
          );
          throw combined;
        }
      },
    );
    const starting = service.start();
    await vi.waitFor(() => expect(queue.resume).toHaveBeenCalledOnce());
    const stopping = service.stop();
    releaseBarrier();
    const stopError = await stopping.catch((error: unknown) => error);
    expect(stopError).toMatchObject({ message: 'reconciliation shutdown failed' });
    expect((stopError as AggregateError).errors).toContain(combined);
    await expect(starting).rejects.toBe(combined);
    expect(queue.pause).toHaveBeenCalledTimes(2);
    expect(consumer.start).toHaveBeenCalledOnce();
    expect(state.bootstrapReconciled).toBe(false);
    expect(state.consumerReady).toBe(false);
    expect(state.reconciliationHealthy).toBe(false);
  });

  it('aborts promptly while active jobs are draining', async () => {
    vi.useFakeTimers();
    const { service, queue, consumer } = makeService();
    queue.getActiveCount.mockResolvedValue(1);
    const starting = service.start();
    await vi.waitFor(() => expect(queue.getActiveCount).toHaveBeenCalledOnce());
    await service.stop();
    await expect(starting).rejects.toThrow('worker lifecycle stopped');
    expect(consumer.close).toHaveBeenCalledOnce();
    expect(consumer.start).not.toHaveBeenCalled();
  });

  it('keeps a second bootstrap outside the fence until resume verification releases it', async () => {
    vi.useFakeTimers();
    const first = makeService();
    const second = makeService();
    let fenceTail = Promise.resolve();
    const fenced = vi.fn(async (work: () => Promise<unknown>) => {
      const previous = fenceTail;
      let release!: () => void;
      fenceTail = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      try {
        return await work();
      } finally {
        release();
      }
    });
    first.repository.withSessionReconciliationLock.mockImplementation(fenced);
    second.repository.withSessionReconciliationLock.mockImplementation(fenced);
    let releaseResumeBarrier!: () => void;
    const resumeBarrier = new Promise<void>((resolve) => {
      releaseResumeBarrier = resolve;
    });
    const firstAfterResume = vi
      .spyOn(
        first.service as unknown as { afterQueueResumeVerified(): Promise<void> },
        'afterQueueResumeVerified',
      )
      .mockReturnValue(resumeBarrier);

    const firstStart = first.service.start();
    await vi.waitFor(() => expect(firstAfterResume).toHaveBeenCalledOnce());
    const secondStart = second.service.start();
    await Promise.resolve();
    expect(second.queue.pause).not.toHaveBeenCalled();
    releaseResumeBarrier();
    await firstStart;
    await secondStart;
    expect(second.queue.pause).toHaveBeenCalledOnce();
    await Promise.all([first.service.stop(), second.service.stop()]);
  });

  it('closes first and aborts after an in-flight paginated boot query settles', async () => {
    const { service, repository, consumer } = makeService();
    let resolveSecondPage!: (orders: Array<Record<string, unknown>>) => void;
    repository.listSaleOrders
      .mockResolvedValueOnce([
        { userId: 'a', id: R1, status: 'persisted', createdAtMs: 1, requestId: 'r' },
        { userId: 'b', id: R2, status: 'persisted', createdAtMs: 2, requestId: 'r' },
      ])
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveSecondPage = resolve;
        }),
      );
    const starting = service.start();
    await vi.waitFor(() => expect(repository.listSaleOrders).toHaveBeenCalledTimes(2));
    const stopping = service.stop();
    await vi.waitFor(() => expect(consumer.close).toHaveBeenCalledOnce());
    resolveSecondPage([]);
    await stopping;
    await expect(starting).rejects.toThrow('worker lifecycle stopped');
  });

  it('closes before awaiting and settles in-flight pass and sweep during stop', async () => {
    const { service, consumer } = makeService();
    let releasePass!: () => void;
    let releaseSweep!: () => void;
    const passBarrier = new Promise<void>((resolve) => {
      releasePass = resolve;
    });
    const sweepBarrier = new Promise<{ retainedUnsafeCount: number; removedCount: number }>(
      (resolve) => {
        releaseSweep = () => resolve({ retainedUnsafeCount: 0, removedCount: 0 });
      },
    );
    vi.spyOn(
      service as unknown as { runContinuousPass(): Promise<void> },
      'runContinuousPass',
    ).mockReturnValue(passBarrier);
    vi.spyOn(
      service as unknown as {
        sweepFailed(): Promise<{ retainedUnsafeCount: number; removedCount: number }>;
      },
      'sweepFailed',
    ).mockReturnValue(sweepBarrier);
    void service.triggerPass();
    void service.triggerDlqSweep();
    const stopping = service.stop();
    await vi.waitFor(() => expect(consumer.close).toHaveBeenCalledOnce());
    let stopped = false;
    void stopping.then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    releasePass();
    releaseSweep();
    await stopping;
  });

  it.each([
    'configuration drift',
    'OVERCOMMITTED',
    'unrecoverable buyer-only identity',
    'redis down',
  ])('retries fatal boot failure %s and never starts the consumer', async (message) => {
    vi.useFakeTimers();
    const { service, repository, consumer, state } = makeService();
    repository.ensureSale.mockRejectedValue(new Error(message));
    const starting = service.start();
    await vi.advanceTimersByTimeAsync(100);
    await service.stop();
    await vi.runAllTimersAsync();
    await expect(starting).rejects.toThrow('worker lifecycle stopped');
    expect(repository.ensureSale.mock.calls.length).toBeGreaterThan(0);
    expect(state.bootstrapReconciled).toBe(false);
    expect(consumer.start).not.toHaveBeenCalled();
  });

  it('only a complete clean pass clears retained readiness incidents', async () => {
    const { service, state } = makeService();
    state.retainedQueueEntries = 2;
    state.reconciliationHealthy = false;
    await service.triggerDlqSweep();
    expect(state.retainedQueueEntries).toBe(2);
    const runDiff = vi
      .spyOn(
        service as unknown as {
          runDiff(): Promise<{ degraded: boolean; queueIssueCount: number }>;
        },
        'runDiff',
      )
      .mockResolvedValue({ degraded: false, queueIssueCount: 0 });
    await service.triggerPass();
    expect(runDiff).toHaveBeenCalledOnce();
    expect(state.retainedQueueEntries).toBe(0);
    expect(state.reconciliationHealthy).toBe(true);
  });

  it.each([
    ['none', undefined, undefined, 'ENQUEUED', 1, 0],
    ['same waiting', R2, 'waiting', 'ALREADY_COVERED', 0, 0],
    ['same completed durable', R2, 'completed', 'DURABLY_SATISFIED', 0, 0],
    ['same completed absent', R2, 'completed', 'ENQUEUED', 1, 1],
    ['same completed different durable', R2, 'completed', 'ENQUEUED', 1, 1],
    ['different active', R1, 'active', 'RETAINED_COLLISION', 0, 0],
    ['different waiting terminal', R1, 'waiting', 'ENQUEUED', 1, 1],
    ['different delayed terminal', R1, 'delayed', 'ENQUEUED', 1, 1],
    ['different failed terminal', R1, 'failed', 'ENQUEUED', 1, 1],
    ['different completed terminal', R1, 'completed', 'ENQUEUED', 1, 1],
    ['different completed unknown', R1, 'completed', 'RETAINED_COLLISION', 0, 0],
  ])(
    'applies live queue decision: %s',
    async (_label, identity, jobState, expected, adds, removals) => {
      const { service, queue } = makeService();
      const current = identity ? queueJob(identity, jobState) : undefined;
      queue.getJob.mockResolvedValueOnce(current).mockResolvedValueOnce(null);
      const durable =
        _label === 'same completed durable'
          ? { id: R2, status: 'persisted' }
          : _label === 'same completed different durable'
            ? { id: R1, status: 'persisted' }
            : _label.includes('terminal')
              ? { id: R1, status: 'compensated' }
              : undefined;
      const result = await (
        service as unknown as {
          ensureLiveReservationQueued(live: unknown, durable: unknown): Promise<string>;
        }
      ).ensureLiveReservationQueued(
        { userId: payload.userId, reservationId: R2, reservedAtMs: 456 },
        durable,
      );
      expect(result).toBe(expected);
      expect(queue.add).toHaveBeenCalledTimes(adds);
      if (current) expect(current.remove).toHaveBeenCalledTimes(removals);
    },
  );

  it('retains invalid authoritative collisions and queue-add identity races', async () => {
    const { service, queue } = makeService();
    queue.getJob.mockResolvedValueOnce(queueJob(R1, 'waiting', { name: 'bad' }));
    const helper = service as unknown as {
      ensureLiveReservationQueued(live: unknown, durable: unknown): Promise<string>;
    };
    await expect(
      helper.ensureLiveReservationQueued(
        { userId: payload.userId, reservationId: R2, reservedAtMs: 456 },
        undefined,
      ),
    ).resolves.toBe('RETAINED_COLLISION');
    queue.getJob.mockResolvedValueOnce(null);
    queue.add.mockResolvedValueOnce(queueJob(R1, 'waiting'));
    await expect(
      helper.ensureLiveReservationQueued(
        { userId: payload.userId, reservationId: R2, reservedAtMs: 456 },
        undefined,
      ),
    ).resolves.toBe('RETAINED_COLLISION');
  });

  it('removes proven completed R1 and enqueues live R2 exactly once', async () => {
    const { service, store, queue } = makeService();
    const completedR1 = queueJob(R1, 'completed');
    queue.getJob.mockResolvedValueOnce(completedR1).mockResolvedValueOnce(null);
    store.compareAndRestoreReservation.mockResolvedValue({
      outcome: 'CONFLICT',
      current: { userId: payload.userId, reservationId: R2, reservedAtMs: 456 },
    });
    const incidents: string[] = [];
    await (
      service as unknown as {
        applyRecoveryCandidate(
          candidate: unknown,
          source: string,
          orders: Map<string, unknown>,
          incidents: string[],
        ): Promise<void>;
      }
    ).applyRecoveryCandidate(
      payload,
      'persisted',
      new Map([[payload.userId, { id: R1, status: 'persisted' }]]),
      incidents,
    );
    expect(completedR1.remove).toHaveBeenCalledOnce();
    expect(queue.add).toHaveBeenCalledOnce();
    expect(queue.add.mock.calls[0]?.[1]).toEqual(expect.objectContaining({ reservationId: R2 }));
    expect(incidents).toContain(
      `persisted identity conflicts with live reservation for ${payload.userId}`,
    );
  });

  it('refuses new reconciliation after shutdown', async () => {
    const { service } = makeService();
    await service.stop();
    await expect(service.triggerPass()).rejects.toThrow('closing');
  });
});
