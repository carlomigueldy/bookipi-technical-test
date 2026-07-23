import { Inject, Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import type {
  ReservationEntry,
  ReservationMembershipInspection,
  SaleRedisStore,
} from '@flash/redis';
import {
  ORDERS_JOB_ATTEMPTS,
  ORDERS_JOB_BACKOFF_DELAY_MS,
  PERSIST_ORDER_JOB_NAME,
  assertOrdersQueueJobPayload,
  buildOrdersJobId,
  type OrdersQueueJobPayload,
} from '@flash/shared';
import type { Job, JobType, Queue } from 'bullmq';

import {
  ORDERS_QUEUE_ADMIN,
  RECONCILIATION_STATE,
  WORKER_ENV,
  WORKER_SALE_STORE,
} from '../common/tokens.js';
import type { WorkerEnv } from '../config/env.js';
import { OrderRepository, type DurableOrder } from '../orders/order.repository.js';
import { OrdersConsumer, type ConsumerRunTermination } from '../orders/orders.consumer.js';
import {
  BULLMQ_MAX_STALLED_FAILED_REASON,
  ORDERS_MAX_STALLED_COUNT,
} from '../orders/orders.consumer.js';

export interface ReconciliationState {
  bootstrapReconciled: boolean;
  consumerReady: boolean;
  reconciliationHealthy: boolean;
  lastReconciledAt: string | null;
  lastDlqSweepAt: string | null;
  activeJobs: number;
  failedJobs: number;
  retainedQueueEntries?: number;
}

export const createReconciliationState = (): ReconciliationState => {
  const state = {
    bootstrapReconciled: false,
    consumerReady: false,
    reconciliationHealthy: false,
    lastReconciledAt: null,
    lastDlqSweepAt: null,
    activeJobs: 0,
    failedJobs: 0,
  } as ReconciliationState;
  Object.defineProperty(state, 'retainedQueueEntries', {
    value: 0,
    writable: true,
    enumerable: false,
  });
  return state;
};

type ScannedJob = { job: Job; state: JobType; payload: OrdersQueueJobPayload };
type QueueEntryIssueCode = 'UNEXPECTED_NAME' | 'INVALID_PAYLOAD' | 'JOB_ID_MISMATCH';
interface QueueEntryIssue {
  jobId: string | null;
  state: JobType;
  code: QueueEntryIssueCode;
  message: string;
}
interface QueueScanResult {
  jobs: ScannedJob[];
  issues: QueueEntryIssue[];
}
interface DlqSweepResult {
  retainedUnsafeCount: number;
  removedCount: number;
}
interface ReconciliationPassResult {
  degraded: boolean;
  queueIssueCount: number;
}
type EnsureLiveQueueResult =
  'ENQUEUED' | 'ALREADY_COVERED' | 'DURABLY_SATISFIED' | 'RETAINED_COLLISION';
const QUEUE_STATES: JobType[] = ['waiting', 'active', 'delayed', 'failed', 'completed'];

export class WorkerLifecycleAbortError extends Error {
  constructor() {
    super('worker lifecycle stopped');
    this.name = 'WorkerLifecycleAbortError';
  }
}

export class ConsumerRunTerminatedError extends Error {
  constructor(termination: ConsumerRunTermination) {
    super(
      termination.kind === 'rejected'
        ? 'worker run loop rejected unexpectedly'
        : 'worker run loop resolved unexpectedly',
      termination.kind === 'rejected' ? { cause: termination.error } : undefined,
    );
    this.name = 'ConsumerRunTerminatedError';
  }
}

export async function isTerminalFailedJobEligible(job: Job): Promise<boolean> {
  if ((await job.getState()) !== 'failed') return false;
  if (job.name !== PERSIST_ORDER_JOB_NAME) return false;
  try {
    assertOrdersQueueJobPayload(job.data);
  } catch {
    return false;
  }
  if (job.id !== buildOrdersJobId(job.data.saleId, job.data.userId)) return false;
  if (job.opts.attempts !== ORDERS_JOB_ATTEMPTS) return false;
  const retryExhausted = job.attemptsMade >= ORDERS_JOB_ATTEMPTS;
  const maxStalled =
    job.failedReason === BULLMQ_MAX_STALLED_FAILED_REASON &&
    job.stalledCounter > ORDERS_MAX_STALLED_COUNT;
  return retryExhausted || maxStalled;
}

@Injectable()
export class ReconciliationService implements OnApplicationShutdown {
  private readonly logger = new Logger(ReconciliationService.name);
  private closing = false;
  private passPromise: Promise<void> | null = null;
  private passCoalesced = false;
  private dlqPromise: Promise<void> | null = null;
  private failedScanOffset = 0;
  private readonly bootController = new AbortController();
  private startPromise: Promise<void> | null = null;
  private stopPromise: Promise<void> | null = null;
  private lifecycleDisposer: (() => void) | null = null;
  private terminationDisposer: (() => void) | null = null;
  private fatalError: ConsumerRunTerminatedError | null = null;
  private fatalRejected = false;
  private readonly fatalPromise: Promise<never>;
  private rejectFatal!: (error: unknown) => void;

  constructor(
    @Inject(WORKER_ENV) private readonly env: WorkerEnv,
    @Inject(WORKER_SALE_STORE) private readonly store: SaleRedisStore,
    @Inject(ORDERS_QUEUE_ADMIN) private readonly queue: Queue,
    @Inject(RECONCILIATION_STATE) private readonly state: ReconciliationState,
    private readonly repository: OrderRepository,
    private readonly consumer: OrdersConsumer,
  ) {
    this.fatalPromise = new Promise<never>((_resolve, reject) => {
      this.rejectFatal = reject;
    });
    void this.fatalPromise.catch(() => undefined);
  }

  start(): Promise<void> {
    this.startPromise ??= this.startLifecycle();
    return this.startPromise;
  }

  waitForFatal(): Promise<never> {
    return this.fatalPromise;
  }

  private async startLifecycle(): Promise<void> {
    const signal = this.bootController.signal;
    let delayMs = 100;
    while (!this.closing) {
      let processingStarted = false;
      let transitionCleaned = false;
      try {
        await this.repository.withSessionReconciliationLock(async () => {
          const bootResult = await this.bootPass(signal);
          this.checkpoint(signal);
          this.state.retainedQueueEntries = bootResult.queueIssueCount;
          this.state.bootstrapReconciled = false;
          this.state.consumerReady = false;
          this.state.reconciliationHealthy = false;
          this.terminationDisposer = this.consumer.onUnexpectedRunTermination((termination) =>
            this.handleUnexpectedConsumerTermination(termination),
          );
          try {
            await this.afterBootDiffBeforeConsumerStart();
            this.checkpoint(signal);
            processingStarted = true;
            await this.consumer.start();
            this.checkpoint(signal);
            this.throwIfConsumerTerminated();
            if (!this.consumer.ready) throw new Error('orders consumer did not become ready');
            this.installContinuousLifecycle();
            this.checkpoint(signal);
            this.throwIfConsumerTerminated();
            await this.queue.resume();
            this.checkpoint(signal);
            if (await this.queue.isPaused()) {
              throw new Error('orders queue remained paused after resume');
            }
            this.checkpoint(signal);
            this.throwIfConsumerTerminated();
            await this.afterQueueResumeVerified();
            this.checkpoint(signal);
            this.throwIfConsumerTerminated();
            this.state.bootstrapReconciled = true;
            this.state.consumerReady = true;
            this.state.reconciliationHealthy = !bootResult.degraded;
          } catch (error) {
            if (!processingStarted) {
              this.disposeTerminationSubscription();
              throw error;
            }
            transitionCleaned = true;
            throw await this.cleanupHalfTransition(error);
          }
        }, signal);
        return;
      } catch (error) {
        if (this.isPurePlannedCancellation(error)) throw error;
        let failure = error;
        if (processingStarted) {
          if (!transitionCleaned) failure = await this.cleanupHalfTransition(failure);
          if (!this.isPurePlannedCancellation(failure) && signal.aborted) {
            this.fail(failure);
          }
          throw failure;
        }
        if (signal.aborted) {
          this.fail(failure);
          throw failure;
        }
        this.fail(failure);
        await this.delay(delayMs, signal);
        delayMs = Math.min(delayMs * 2, 5000);
      }
    }
    throw signal.reason ?? new WorkerLifecycleAbortError();
  }

  triggerPass(): Promise<void> {
    if (this.closing) return Promise.reject(new Error('reconciliation is closing'));
    if (this.passPromise) {
      this.passCoalesced = true;
      return this.passPromise;
    }
    this.passPromise = this.runContinuousPass().finally(async () => {
      this.passPromise = null;
      if (this.passCoalesced && !this.closing) {
        this.passCoalesced = false;
        await this.triggerPass();
      }
    });
    return this.passPromise;
  }

  triggerDlqSweep(): Promise<void> {
    if (this.closing) return Promise.resolve();
    this.dlqPromise ??= this.sweepFailed(this.bootController.signal)
      .then((result) => {
        if (result.retainedUnsafeCount > 0) {
          this.state.retainedQueueEntries = Math.max(
            this.state.retainedQueueEntries ?? 0,
            result.retainedUnsafeCount,
          );
          this.state.reconciliationHealthy = false;
        }
      })
      .finally(() => {
        this.dlqPromise = null;
      });
    return this.dlqPromise;
  }

  async onApplicationShutdown(): Promise<void> {
    await this.stop();
  }
  stop(): Promise<void> {
    this.stopPromise ??= this.stopLifecycle();
    return this.stopPromise;
  }

  private async stopLifecycle(): Promise<void> {
    this.closing = true;
    this.state.bootstrapReconciled = false;
    this.state.consumerReady = false;
    this.state.reconciliationHealthy = false;
    this.bootController.abort(new WorkerLifecycleAbortError());
    const disposalErrors: unknown[] = [];
    try {
      this.disposeContinuousLifecycle();
    } catch (error) {
      disposalErrors.push(error);
    }
    try {
      this.disposeTerminationSubscription();
    } catch (error) {
      disposalErrors.push(error);
    }
    const consumerClose = this.consumer.close();
    const results = await Promise.allSettled(
      [consumerClose, this.startPromise, this.passPromise, this.dlqPromise].filter(
        (value): value is Promise<void> => value !== null,
      ),
    );
    const errors = disposalErrors.concat(
      results
        .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
        .map((result) => result.reason)
        .filter((error) => !this.isPurePlannedCancellation(error)),
    );
    if (errors.length > 0) throw new AggregateError(errors, 'reconciliation shutdown failed');
  }

  private async bootPass(signal: AbortSignal): Promise<ReconciliationPassResult> {
    this.checkpoint(signal);
    await this.queue.pause();
    this.checkpoint(signal);
    if (!(await this.queue.isPaused())) throw new Error('orders queue did not enter paused state');
    this.checkpoint(signal);
    await this.prepareConsumerForBootstrap(signal);
    this.checkpoint(signal);
    const deadline = Date.now() + 30000;
    while (true) {
      this.checkpoint(signal);
      if ((await this.queue.getActiveCount()) === 0) break;
      if (Date.now() >= deadline) throw new Error('active jobs did not drain within 30 seconds');
      await this.delay(100, signal);
      this.checkpoint(signal);
    }
    this.checkpoint(signal);
    await this.repository.ensureSale();
    this.checkpoint(signal);
    const snapshot = await this.store.status(this.env.SALE_ID);
    this.checkpoint(signal);
    if (!snapshot.initialized) {
      const seed = await this.store.seed({
        saleId: this.env.SALE_ID,
        name: this.env.SALE_NAME,
        startsAt: this.env.SALE_STARTS_AT,
        endsAt: this.env.SALE_ENDS_AT,
        totalStock: this.env.SALE_TOTAL_STOCK,
      });
      this.checkpoint(signal);
      if (seed.outcome === 'CONFIG_DRIFT') throw new Error('redis sale configuration drift');
    } else if (
      snapshot.name !== this.env.SALE_NAME ||
      snapshot.totalStock !== this.env.SALE_TOTAL_STOCK ||
      snapshot.startsAtMs !== Date.parse(this.env.SALE_STARTS_AT) ||
      snapshot.endsAtMs !== Date.parse(this.env.SALE_ENDS_AT)
    ) {
      throw new Error('redis sale configuration drift');
    }
    this.checkpoint(signal);
    const result = await this.runDiff(signal);
    this.checkpoint(signal);
    return result;
  }

  private installContinuousLifecycle(): void {
    if (this.lifecycleDisposer) return;
    let unsubscribe: () => void = () => undefined;
    let reconcileTimer: ReturnType<typeof setInterval> | null = null;
    let dlqTimer: ReturnType<typeof setInterval> | null = null;
    try {
      unsubscribe = this.consumer.onFailedHint(() => {
        this.triggerDlqSweep().catch((error) => this.fail(error));
      });
      reconcileTimer = setInterval(() => {
        this.triggerPass().catch(() => undefined);
      }, this.env.WORKER_RECONCILE_INTERVAL_MS);
      dlqTimer = setInterval(() => {
        this.triggerDlqSweep().catch((error) => this.fail(error));
      }, this.env.WORKER_DLQ_SWEEP_INTERVAL_MS);
      reconcileTimer.unref?.();
      dlqTimer.unref?.();
    } catch (error) {
      if (reconcileTimer) clearInterval(reconcileTimer);
      if (dlqTimer) clearInterval(dlqTimer);
      unsubscribe();
      throw error;
    }
    let disposed = false;
    this.lifecycleDisposer = () => {
      if (disposed) return;
      disposed = true;
      if (reconcileTimer) clearInterval(reconcileTimer);
      if (dlqTimer) clearInterval(dlqTimer);
      this.lifecycleDisposer = null;
      unsubscribe();
    };
  }

  private async runContinuousPass(): Promise<void> {
    this.logger.log({ event: 'reconciliation.started' });
    try {
      const signal = this.bootController.signal;
      const result = await this.repository.withSessionReconciliationLock(
        () => this.runDiff(signal),
        signal,
      );
      this.state.retainedQueueEntries = result.queueIssueCount;
      this.state.reconciliationHealthy = !result.degraded;
      this.state.lastReconciledAt = new Date().toISOString();
      this.logger.log({ event: 'reconciliation.completed' });
    } catch (error) {
      this.fail(error);
      throw error;
    }
  }

  private async runDiff(
    signal: AbortSignal = this.bootController.signal,
  ): Promise<ReconciliationPassResult> {
    this.checkpoint(signal);
    const orders = await this.scanOrders(signal);
    const byUser = new Map(orders.map((order) => [order.userId, order]));
    this.checkpoint(signal);
    const scan = await this.scanJobs(signal);
    const jobs = scan.jobs;

    const recoveryIncidents: string[] = [];
    for (const order of orders) {
      this.checkpoint(signal);
      if (order.status !== 'persisted') continue;
      await this.applyRecoveryCandidate(
        { userId: order.userId, reservationId: order.id, reservedAtMs: order.createdAtMs },
        'persisted',
        byUser,
        recoveryIncidents,
      );
    }
    for (const item of jobs) {
      this.checkpoint(signal);
      if (!['waiting', 'active', 'delayed', 'failed'].includes(item.state)) continue;
      const row = byUser.get(item.payload.userId);
      if (row?.status === 'compensated' && row.id === item.payload.reservationId) continue;
      await this.applyRecoveryCandidate(
        {
          userId: item.payload.userId,
          reservationId: item.payload.reservationId,
          reservedAtMs: item.payload.reservedAtMs,
        },
        'queue',
        byUser,
        recoveryIncidents,
      );
    }

    this.checkpoint(signal);
    const ledger = await this.scanLedger(signal);
    const ledgerByUser = new Map(ledger.map((entry) => [entry.userId, entry]));
    for (const entry of ledger) {
      this.checkpoint(signal);
      const row = byUser.get(entry.userId);
      if (row?.status === 'persisted' && row.id === entry.reservationId) {
        await this.store.reconcileBuyerMembership(this.env.SALE_ID, entry.userId);
        continue;
      }
      const coverage = await this.ensureLiveReservationQueued(entry, row);
      if (coverage === 'RETAINED_COLLISION') {
        recoveryIncidents.push(`retained queue collision for ${entry.userId}`);
      }
      await this.store.reconcileBuyerMembership(this.env.SALE_ID, entry.userId);
    }

    let buyerCursor = '0';
    do {
      this.checkpoint(signal);
      const page = await this.store.scanBuyers(
        this.env.SALE_ID,
        buyerCursor,
        this.env.WORKER_RECONCILE_SCAN_COUNT,
      );
      this.checkpoint(signal);
      buyerCursor = page.cursor;
      for (const userId of page.userIds) {
        this.checkpoint(signal);
        if (ledgerByUser.has(userId)) continue;
        const inspection = await this.store.inspectReservationMembership(this.env.SALE_ID, userId);
        if (inspection.outcome !== 'BUYER_ONLY') {
          await this.resolveBuyerInspection(
            userId,
            inspection,
            ledgerByUser,
            byUser.get(userId),
            recoveryIncidents,
          );
          continue;
        }
        await this.adjudicateBuyerOnly(userId, ledgerByUser, byUser, recoveryIncidents);
      }
    } while (buyerCursor !== '0');

    this.checkpoint(signal);
    const stock = await this.store.reconcileStockFromReservations(this.env.SALE_ID);
    this.checkpoint(signal);
    if (stock.outcome !== 'RECONCILED') {
      if (stock.outcome === 'OVERCOMMITTED')
        this.logger.error({
          event: 'reconciliation.overcommitted',
          reservationCount: stock.reservationCount,
          totalStock: stock.totalStock,
        });
      throw new Error(`stock reconciliation failed: ${stock.outcome}`);
    }
    const dlq = await this.sweepFailed(signal);
    this.checkpoint(signal);
    const counts = await this.queue.getJobCounts('active', 'failed');
    this.checkpoint(signal);
    this.state.activeJobs = counts.active ?? 0;
    this.state.failedJobs = counts.failed ?? 0;
    this.state.lastReconciledAt = new Date().toISOString();
    const queueIssueCount = scan.issues.length + dlq.retainedUnsafeCount;
    return { degraded: queueIssueCount > 0 || recoveryIncidents.length > 0, queueIssueCount };
  }

  private async resolveBuyerInspection(
    userId: string,
    inspection: ReservationMembershipInspection,
    ledgerByUser: Map<string, ReservationEntry>,
    durable: DurableOrder | undefined,
    incidents: string[],
    targetedJob?: Job | null,
  ): Promise<void> {
    if (inspection.outcome === 'NEITHER') return;
    if (inspection.outcome === 'BUYER_ONLY') {
      throw new Error(`unrecoverable buyer-only identity for ${userId}`);
    }
    const entry = inspection.reservation;
    if (!entry) throw new Error(`reservation-bearing inspection omitted identity for ${userId}`);
    if (inspection.outcome === 'BOTH') ledgerByUser.set(userId, entry);
    const coverage = await this.ensureLiveReservationQueued(entry, durable, targetedJob);
    if (coverage === 'RETAINED_COLLISION') {
      if (targetedJob !== undefined) {
        throw new Error(`unrecoverable buyer-only identity for ${userId}`);
      }
      incidents.push(`retained queue collision for ${userId}`);
    }
    if (inspection.outcome === 'RESERVATION_ONLY') {
      const membership = await this.store.reconcileBuyerMembership(this.env.SALE_ID, userId);
      if (membership !== 'PRESENT') {
        throw new Error(`buyer membership repair failed for ${userId}`);
      }
    }
    if (inspection.outcome === 'RESERVATION_ONLY') ledgerByUser.set(userId, entry);
  }

  private async adjudicateBuyerOnly(
    userId: string,
    ledgerByUser: Map<string, ReservationEntry>,
    byUser: Map<string, DurableOrder>,
    incidents: string[],
  ): Promise<void> {
    const fail = (): never => {
      throw new Error(`unrecoverable buyer-only identity for ${userId}`);
    };
    const row = await this.repository.getByUser(userId);
    const targeted = await this.queue.getJob(buildOrdersJobId(this.env.SALE_ID, userId));
    let classified: ScannedJob | null = null;
    if (targeted) {
      const result = this.classifyQueueEntry(targeted, (await targeted.getState()) as JobType);
      if ('issue' in result) {
        fail();
      } else {
        classified = result.job;
      }
    }
    const liveQueue =
      classified && ['waiting', 'active', 'delayed', 'failed'].includes(classified.state)
        ? classified
        : null;
    const persisted = row?.saleId === this.env.SALE_ID && row.status === 'persisted' ? row : null;
    const queueCandidate =
      liveQueue &&
      liveQueue.payload.saleId === this.env.SALE_ID &&
      liveQueue.payload.userId === userId
        ? liveQueue
        : null;
    if (row?.saleId === this.env.SALE_ID) byUser.set(userId, row);

    if (persisted && queueCandidate?.payload.reservationId !== undefined) {
      if (queueCandidate.payload.reservationId !== persisted.id) fail();
    }

    if (persisted) {
      byUser.set(userId, persisted);
      await this.applyRecoveryCandidate(
        { userId, reservationId: persisted.id, reservedAtMs: persisted.createdAtMs },
        'persisted',
        byUser,
        incidents,
        targeted,
      );
    } else if (queueCandidate) {
      await this.applyRecoveryCandidate(
        {
          userId,
          reservationId: queueCandidate.payload.reservationId,
          reservedAtMs: queueCandidate.payload.reservedAtMs,
        },
        'queue',
        byUser,
        incidents,
      );
    } else if (row?.saleId === this.env.SALE_ID && row.status === 'compensated') {
      const membership = await this.store.reconcileBuyerMembership(this.env.SALE_ID, userId);
      if (membership !== 'ABSENT') fail();
    } else {
      fail();
    }

    const finalInspection = await this.store.inspectReservationMembership(this.env.SALE_ID, userId);
    await this.resolveBuyerInspection(
      userId,
      finalInspection,
      ledgerByUser,
      byUser.get(userId),
      incidents,
      targeted,
    );
  }

  private async applyRecoveryCandidate(
    candidate: { userId: string; reservationId: string; reservedAtMs: number },
    source: 'persisted' | 'queue',
    byUser: Map<string, DurableOrder>,
    incidents: string[],
    targetedJob?: Job | null,
  ): Promise<void> {
    const result = await this.store.compareAndRestoreReservation(this.env.SALE_ID, candidate);
    if (result.outcome !== 'CONFLICT') return;
    const current = result.current;
    if (!current) throw new Error('reservation CAS conflict returned no current identity');

    if (source === 'queue') {
      const durable = byUser.get(candidate.userId);
      if (durable?.status === 'compensated' && durable.id === candidate.reservationId) return;
      incidents.push(`conflicting active queue identity for ${candidate.userId}`);
      return;
    }

    if (current.reservedAtMs !== null) {
      const coverage = await this.ensureLiveReservationQueued(
        current,
        byUser.get(candidate.userId),
        targetedJob,
      );
      if (coverage === 'RETAINED_COLLISION') {
        incidents.push(`retained queue collision for ${candidate.userId}`);
      }
    }
    incidents.push(`persisted identity conflicts with live reservation for ${candidate.userId}`);
  }

  private async ensureLiveReservationQueued(
    live: ReservationEntry,
    durable: DurableOrder | undefined,
    targetedJob?: Job | null,
  ): Promise<EnsureLiveQueueResult> {
    const jobId = buildOrdersJobId(this.env.SALE_ID, live.userId);
    const current = targetedJob === undefined ? await this.queue.getJob(jobId) : targetedJob;
    if (!current) return this.enqueueLiveReservation(live, jobId);

    const classified = this.classifyQueueEntry(current, (await current.getState()) as JobType);
    if ('issue' in classified) {
      this.logRetainedQueueEntry(classified.issue);
      return 'RETAINED_COLLISION';
    }
    const currentIdentity = classified.job.payload.reservationId;
    const state = classified.job.state;
    if (currentIdentity === live.reservationId) {
      if (['waiting', 'active', 'delayed', 'failed'].includes(state)) return 'ALREADY_COVERED';
      if (durable?.id === live.reservationId && durable.status === 'persisted') {
        return 'DURABLY_SATISFIED';
      }
      if (state !== 'completed') return this.retainIdentityCollision(live, current, state);
      await current.remove();
      return targetedJob === undefined
        ? this.enqueueAfterRemoval(live, jobId)
        : this.enqueueLiveReservation(live, jobId);
    }

    if (state === 'active') return this.retainIdentityCollision(live, current, state);
    if (
      !['waiting', 'delayed', 'failed', 'completed'].includes(state) ||
      durable?.id !== currentIdentity ||
      !['persisted', 'compensated'].includes(durable.status)
    ) {
      return this.retainIdentityCollision(live, current, state);
    }
    await current.remove();
    return targetedJob === undefined
      ? this.enqueueAfterRemoval(live, jobId)
      : this.enqueueLiveReservation(live, jobId);
  }

  private async enqueueAfterRemoval(
    live: ReservationEntry,
    jobId: string,
  ): Promise<EnsureLiveQueueResult> {
    const raced = await this.queue.getJob(jobId);
    if (raced) {
      const classified = this.classifyQueueEntry(raced, (await raced.getState()) as JobType);
      if ('issue' in classified) {
        this.logRetainedQueueEntry(classified.issue);
        return 'RETAINED_COLLISION';
      }
      return classified.job.payload.reservationId === live.reservationId
        ? 'ALREADY_COVERED'
        : this.retainIdentityCollision(live, raced, classified.job.state);
    }
    return this.enqueueLiveReservation(live, jobId);
  }

  private async enqueueLiveReservation(
    entry: ReservationEntry,
    jobId: string,
  ): Promise<EnsureLiveQueueResult> {
    const payload: OrdersQueueJobPayload = {
      saleId: this.env.SALE_ID,
      userId: entry.userId,
      reservationId: entry.reservationId,
      reservedAtMs: entry.reservedAtMs ?? 0,
      requestId: `reconcile-${entry.reservationId}`,
    };
    assertOrdersQueueJobPayload(payload);
    const repaired = await this.queue.add(PERSIST_ORDER_JOB_NAME, payload, {
      jobId,
      attempts: ORDERS_JOB_ATTEMPTS,
      backoff: { type: 'exponential', delay: ORDERS_JOB_BACKOFF_DELAY_MS },
      removeOnComplete: { count: 1000 },
      removeOnFail: false,
    });
    const classified = this.classifyQueueEntry(repaired, 'waiting');
    if ('issue' in classified) {
      this.logRetainedQueueEntry(classified.issue);
      return 'RETAINED_COLLISION';
    }
    if (classified.job.payload.reservationId !== payload.reservationId) {
      return this.retainIdentityCollision(entry, repaired, classified.job.state);
    }
    this.logger.log({
      event: 'reconciliation.enqueue_repaired',
      saleId: payload.saleId,
      userId: payload.userId,
      reservationId: payload.reservationId,
      jobId,
      requestId: payload.requestId,
      attempt: 0,
    });
    return 'ENQUEUED';
  }

  private retainIdentityCollision(
    live: ReservationEntry,
    job: Job,
    state: JobType,
  ): 'RETAINED_COLLISION' {
    this.logger.error({
      event: 'reconciliation.identity_conflict',
      saleId: this.env.SALE_ID,
      userId: live.userId,
      reservationId: live.reservationId,
      jobId: job.id ?? null,
      state,
    });
    return 'RETAINED_COLLISION';
  }

  private async sweepFailed(
    signal: AbortSignal = this.bootController.signal,
  ): Promise<DlqSweepResult> {
    this.checkpoint(signal);
    const totalBefore = await this.queue.getFailedCount();
    this.checkpoint(signal);
    if (totalBefore === 0) {
      this.failedScanOffset = 0;
      this.state.failedJobs = 0;
      this.state.lastDlqSweepAt = new Date().toISOString();
      return { retainedUnsafeCount: 0, removedCount: 0 };
    }
    let start = this.failedScanOffset % totalBefore;
    let failed = await this.queue.getJobs(
      ['failed'],
      start,
      start + this.env.WORKER_DLQ_SCAN_COUNT - 1,
      true,
    );
    this.checkpoint(signal);
    if (failed.length === 0) {
      start = 0;
      failed = await this.queue.getJobs(['failed'], 0, this.env.WORKER_DLQ_SCAN_COUNT - 1, true);
      this.checkpoint(signal);
    }
    let retainedUnsafeCount = 0;
    let removedCount = 0;
    const operationalErrors: unknown[] = [];
    for (const job of failed) {
      this.checkpoint(signal);
      const classified = this.classifyQueueEntry(job, 'failed');
      if ('issue' in classified) {
        retainedUnsafeCount += 1;
        this.logRetainedQueueEntry(classified.issue);
        continue;
      }
      try {
        const actualState = await job.getState();
        const retryExhausted = job.attemptsMade >= ORDERS_JOB_ATTEMPTS;
        const maxStalled =
          job.failedReason === BULLMQ_MAX_STALLED_FAILED_REASON &&
          job.stalledCounter > ORDERS_MAX_STALLED_COUNT;
        if (
          actualState !== 'failed' ||
          job.opts.attempts !== ORDERS_JOB_ATTEMPTS ||
          (!retryExhausted && !maxStalled)
        ) {
          retainedUnsafeCount += 1;
          this.logRetainedQueueEntry({
            jobId: job.id ?? null,
            state: 'failed',
            code: 'INVALID_PAYLOAD',
            message: 'failed job is not terminally eligible under the frozen retry policy',
          });
          continue;
        }
        const payload = classified.job.payload;
        const outcome = await this.repository.resolveFailed(payload, () =>
          this.store.compensate(payload.saleId, payload.userId, payload.reservationId),
        );
        await job.remove();
        removedCount += 1;
        this.logger.log({
          event:
            outcome === 'compensated'
              ? 'order.compensated'
              : outcome === 'compensation_noop'
                ? 'order.compensation_noop'
                : 'order.idempotent',
          saleId: payload.saleId,
          userId: payload.userId,
          reservationId: payload.reservationId,
          jobId: job.id,
          requestId: payload.requestId,
          attempt: job.attemptsMade,
        });
      } catch (error) {
        operationalErrors.push(error);
        this.logger.error({
          event: 'order.failed',
          jobId: job.id,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    this.state.lastDlqSweepAt = new Date().toISOString();
    this.checkpoint(signal);
    const totalAfter = await this.queue.getFailedCount();
    this.checkpoint(signal);
    this.state.failedJobs = totalAfter;
    if (totalAfter === 0) this.failedScanOffset = 0;
    else if (removedCount > 0) this.failedScanOffset = Math.min(start, totalAfter - 1);
    else this.failedScanOffset = (start + failed.length) % totalAfter;
    if (operationalErrors.length > 0) {
      throw new AggregateError(operationalErrors, 'one or more terminal jobs failed resolution');
    }
    return { retainedUnsafeCount, removedCount };
  }

  private async scanOrders(
    signal: AbortSignal = this.bootController.signal,
  ): Promise<DurableOrder[]> {
    const rows: DurableOrder[] = [];
    for (let offset = 0; ; offset += this.env.WORKER_RECONCILE_SCAN_COUNT) {
      this.checkpoint(signal);
      const page = await this.repository.listSaleOrders(
        offset,
        this.env.WORKER_RECONCILE_SCAN_COUNT,
      );
      this.checkpoint(signal);
      rows.push(...page);
      if (page.length < this.env.WORKER_RECONCILE_SCAN_COUNT) return rows;
    }
  }

  private async scanJobs(
    signal: AbortSignal = this.bootController.signal,
  ): Promise<QueueScanResult> {
    const jobs: ScannedJob[] = [];
    const issues: QueueEntryIssue[] = [];
    for (const state of QUEUE_STATES) {
      for (let start = 0; ; start += this.env.WORKER_RECONCILE_SCAN_COUNT) {
        this.checkpoint(signal);
        const page = await this.queue.getJobs(
          [state],
          start,
          start + this.env.WORKER_RECONCILE_SCAN_COUNT - 1,
          true,
        );
        this.checkpoint(signal);
        for (const job of page) {
          this.checkpoint(signal);
          const classified = this.classifyQueueEntry(job, state);
          if ('issue' in classified) {
            issues.push(classified.issue);
            this.logRetainedQueueEntry(classified.issue);
          } else if (state === 'failed' && !(await isTerminalFailedJobEligible(job))) {
            const issue: QueueEntryIssue = {
              jobId: job.id ?? null,
              state,
              code: 'INVALID_PAYLOAD',
              message: 'failed job is not terminally eligible under the frozen retry policy',
            };
            issues.push(issue);
            this.logRetainedQueueEntry(issue);
          } else {
            jobs.push(classified.job);
          }
        }
        if (page.length < this.env.WORKER_RECONCILE_SCAN_COUNT) break;
      }
    }
    return { jobs, issues };
  }

  private classifyQueueEntry(
    job: Job,
    state: JobType,
  ): { job: ScannedJob } | { issue: QueueEntryIssue } {
    if (job.name !== PERSIST_ORDER_JOB_NAME) {
      return {
        issue: {
          jobId: job.id ?? null,
          state,
          code: 'UNEXPECTED_NAME',
          message: `unexpected job name '${job.name}'`,
        },
      };
    }
    try {
      assertOrdersQueueJobPayload(job.data);
    } catch (error) {
      return {
        issue: {
          jobId: job.id ?? null,
          state,
          code: 'INVALID_PAYLOAD',
          message: error instanceof Error ? error.message : 'invalid job payload',
        },
      };
    }
    const expectedId = buildOrdersJobId(job.data.saleId, job.data.userId);
    if (job.id !== expectedId) {
      return {
        issue: {
          jobId: job.id ?? null,
          state,
          code: 'JOB_ID_MISMATCH',
          message: `job ID does not match validated payload identity`,
        },
      };
    }
    if (job.opts.attempts !== ORDERS_JOB_ATTEMPTS) {
      return {
        issue: {
          jobId: job.id ?? null,
          state,
          code: 'INVALID_PAYLOAD',
          message: `job attempts must equal ${ORDERS_JOB_ATTEMPTS}`,
        },
      };
    }
    return { job: { job, state, payload: job.data } };
  }

  private logRetainedQueueEntry(issue: QueueEntryIssue): void {
    this.logger.error({ event: 'reconciliation.queue_entry_retained', ...issue });
  }

  private async scanLedger(
    signal: AbortSignal = this.bootController.signal,
  ): Promise<ReservationEntry[]> {
    const result: ReservationEntry[] = [];
    let cursor = '0';
    do {
      this.checkpoint(signal);
      const page = await this.store.scanReservations(
        this.env.SALE_ID,
        cursor,
        this.env.WORKER_RECONCILE_SCAN_COUNT,
      );
      this.checkpoint(signal);
      cursor = page.cursor;
      result.push(...page.entries);
    } while (cursor !== '0');
    return result;
  }

  protected afterBootDiffBeforeConsumerStart(): Promise<void> {
    return Promise.resolve();
  }

  protected afterQueueResumeVerified(): Promise<void> {
    return Promise.resolve();
  }

  private async prepareConsumerForBootstrap(signal: AbortSignal): Promise<void> {
    this.checkpoint(signal);
    const preparation = this.consumer.prepareForBootstrapRecovery();
    let onAbort: (() => void) | null = null;
    const cancellation = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(signal.reason);
      signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
      await Promise.race([preparation, cancellation]);
    } finally {
      if (onAbort) signal.removeEventListener('abort', onAbort);
    }
  }

  private handleUnexpectedConsumerTermination(termination: ConsumerRunTermination): void {
    this.state.consumerReady = false;
    this.state.reconciliationHealthy = false;
    try {
      this.disposeContinuousLifecycle();
    } catch (error) {
      this.logger.error({
        event: 'worker.lifecycle_dispose_failed',
        message: error instanceof Error ? error.message : String(error),
      });
    }
    this.logger.error({
      event: 'worker.consumer_terminated',
      kind: termination.kind,
      ...(termination.kind === 'rejected'
        ? {
            message:
              termination.error instanceof Error
                ? termination.error.message
                : String(termination.error),
          }
        : {}),
    });
    if (this.fatalRejected) return;
    this.fatalRejected = true;
    this.fatalError = new ConsumerRunTerminatedError(termination);
    this.rejectFatal(this.fatalError);
  }

  private throwIfConsumerTerminated(): void {
    if (this.fatalError) throw this.fatalError;
  }

  private async cleanupHalfTransition(originalError: unknown): Promise<unknown> {
    this.state.bootstrapReconciled = false;
    this.state.consumerReady = false;
    this.state.reconciliationHealthy = false;
    const cleanupErrors: unknown[] = [];
    try {
      this.disposeContinuousLifecycle();
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      this.disposeTerminationSubscription();
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      await this.queue.pause();
      if (!(await this.queue.isPaused())) {
        throw new Error('orders queue did not enter paused state during transition cleanup');
      }
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      await this.consumer.close();
    } catch (error) {
      cleanupErrors.push(error);
    }
    return cleanupErrors.length > 0
      ? new AggregateError(
          [originalError, ...cleanupErrors],
          'worker transition and cleanup failed',
        )
      : originalError;
  }

  private disposeContinuousLifecycle(): void {
    this.lifecycleDisposer?.();
  }

  private disposeTerminationSubscription(): void {
    const dispose = this.terminationDisposer;
    this.terminationDisposer = null;
    dispose?.();
  }

  private checkpoint(signal: AbortSignal): void {
    signal.throwIfAborted();
  }

  private isPurePlannedCancellation(error: unknown): boolean {
    const signal = this.bootController.signal;
    return (
      signal.aborted &&
      error === signal.reason &&
      signal.reason instanceof WorkerLifecycleAbortError
    );
  }

  private fail(error: unknown): void {
    this.state.reconciliationHealthy = false;
    this.logger.error({
      event: 'reconciliation.failed',
      message: error instanceof Error ? error.message : String(error),
    });
  }

  private delay(ms: number, signal: AbortSignal = this.bootController.signal): Promise<void> {
    this.checkpoint(signal);
    return new Promise((resolve, reject) => {
      const onAbort = (): void => {
        clearTimeout(timer);
        reject(signal.reason);
      };
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      timer.unref?.();
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }
}
