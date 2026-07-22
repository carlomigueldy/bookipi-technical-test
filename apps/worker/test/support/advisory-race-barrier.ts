import type { OrdersQueueJobPayload } from '@flash/shared';

import type { AdvisoryRaceHooks } from '../../src/orders/order.repository.js';
import { orderRow, stock, yieldTurn, type WorkerHarness } from './harness.js';

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

export type AdvisoryRaceResolver = (hooks: AdvisoryRaceHooks) => Promise<unknown>;

export interface AdvisoryRaceResult {
  firstObservation: 'persister_committed' | 'persister_waiting_advisory';
  order: Awaited<ReturnType<typeof orderRow>>;
  stock: number;
}

export async function runAdvisoryRace(
  harness: WorkerHarness,
  payload: OrdersQueueJobPayload,
  resolver: AdvisoryRaceResolver,
): Promise<AdvisoryRaceResult> {
  const resolverAbsent = deferred<void>();
  const releaseResolver = deferred<void>();
  const persisterPid = deferred<number>();
  let persisterCommitted = false;

  const hooks: AdvisoryRaceHooks = {
    afterResolverAbsentRead: async () => {
      resolverAbsent.resolve();
      await releaseResolver.promise;
    },
    beforePersisterAdvisoryLock: async (pid) => {
      persisterPid.resolve(pid);
    },
    afterPersisterCommit: async () => {
      persisterCommitted = true;
    },
  };

  const resolverPromise = resolver(hooks);
  await resolverAbsent.promise;
  const persisterPromise = harness.repository.persist(payload, hooks);
  const pid = await persisterPid.promise;

  const deadline = Date.now() + 10_000;
  let firstObservation: AdvisoryRaceResult['firstObservation'] | undefined;
  while (!firstObservation && Date.now() < deadline) {
    if (persisterCommitted) {
      firstObservation = 'persister_committed';
      break;
    }
    const activity = await harness.pool.query<{
      wait_event_type: string | null;
      wait_event: string | null;
    }>('SELECT wait_event_type,wait_event FROM pg_stat_activity WHERE pid=$1', [pid]);
    const row = activity.rows[0];
    if (row?.wait_event_type === 'Lock' && row.wait_event === 'advisory') {
      firstObservation = 'persister_waiting_advisory';
      break;
    }
    await yieldTurn();
  }
  if (!firstObservation) throw new Error('advisory race reached neither deterministic condition');

  releaseResolver.resolve();
  await Promise.all([resolverPromise, persisterPromise]);
  return {
    firstObservation,
    order: await orderRow(harness, payload.userId),
    stock: await stock(harness),
  };
}
