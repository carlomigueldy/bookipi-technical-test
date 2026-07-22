import { Queue } from 'bullmq';
import {
  ORDERS_QUEUE_PREFIX,
  PERSIST_ORDER_JOB_NAME,
  type OrdersQueueJobPayload,
} from '@flash/shared';
import Redis from 'ioredis';

export type ObservedQueueState = 'waiting' | 'active' | 'delayed' | 'failed';

export interface ObservedOrderJob {
  id: string;
  name: typeof PERSIST_ORDER_JOB_NAME;
  data: OrdersQueueJobPayload;
}

export interface OrdersQueueDepth {
  waiting: number;
  active: number;
  delayed: number;
  failed: number;
}

export interface QueueTestObserver {
  getJob(jobId: string): Promise<ObservedOrderJob | null>;
  listJobIds(states: readonly ObservedQueueState[]): Promise<string[]>;
  getJobCounts(): Promise<OrdersQueueDepth>;
  close(): Promise<void>;
}

const OBSERVER_CLOSE_TIMEOUT_MS = 1000;

async function withinCloseBudget(
  operation: Promise<unknown>,
  onTimeout: () => void,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      onTimeout();
      resolve();
    }, OBSERVER_CLOSE_TIMEOUT_MS);
    timer.unref?.();
  });
  await Promise.race([
    operation.then(
      () => undefined,
      () => undefined,
    ),
    deadline,
  ]);
  if (timer !== undefined) clearTimeout(timer);
}

export function createQueueTestObserver(options: {
  redisUrl: string;
  queueName: string;
}): QueueTestObserver {
  const errorListener = (): void => {
    // The listener is intentionally explicit: an EventEmitter `error` event must
    // never become an uncaught exception while a test is inspecting Redis state.
  };
  let redis: Redis | null = null;
  let queue: Queue<OrdersQueueJobPayload> | null = null;
  let closePromise: Promise<void> | null = null;
  let closing = false;

  function getQueue(): Queue<OrdersQueueJobPayload> {
    if (closing) throw new Error('queue test observer is closing');
    if (queue !== null) return queue;

    redis = new Redis(options.redisUrl, {
      connectionName: 'flash-api-test-queue-observer',
      maxRetriesPerRequest: 1,
      commandTimeout: 1000,
      connectTimeout: 1000,
      enableOfflineQueue: false,
      retryStrategy: () => null,
    });
    queue = new Queue<OrdersQueueJobPayload>(options.queueName, {
      connection: redis,
      prefix: ORDERS_QUEUE_PREFIX,
    });
    queue.on('error', errorListener);
    return queue;
  }

  return {
    async getJob(jobId) {
      const job = await getQueue().getJob(jobId);
      if (job === undefined) return null;
      return {
        id: String(job.id),
        name: job.name as typeof PERSIST_ORDER_JOB_NAME,
        data: job.data,
      };
    },

    async listJobIds(states) {
      const jobs = await getQueue().getJobs([...states]);
      return jobs
        .map((job) => job.id)
        .filter((id): id is string => typeof id === 'string')
        .sort();
    },

    async getJobCounts() {
      const counts = await getQueue().getJobCounts('waiting', 'active', 'delayed', 'failed');
      return {
        waiting: counts.waiting ?? 0,
        active: counts.active ?? 0,
        delayed: counts.delayed ?? 0,
        failed: counts.failed ?? 0,
      };
    },

    close() {
      closePromise ??= (async () => {
        closing = true;
        if (queue === null || redis === null) return;
        const ownedQueue = queue;
        const ownedRedis = redis;
        await withinCloseBudget(ownedQueue.close(), () => ownedRedis.disconnect(false));
        ownedQueue.removeListener('error', errorListener);
        if (ownedRedis.status !== 'end') {
          await withinCloseBudget(ownedRedis.quit(), () => ownedRedis.disconnect(false));
        }
        ownedRedis.disconnect(false);
      })();
      return closePromise;
    },
  };
}
