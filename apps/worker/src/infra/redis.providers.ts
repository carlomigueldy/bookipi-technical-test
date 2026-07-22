import type { Provider } from '@nestjs/common';
import { createRedisClient, SaleRedisStore } from '@flash/redis';
import { ORDERS_QUEUE_PREFIX } from '@flash/shared';
import { Queue } from 'bullmq';
import type { Redis } from 'ioredis';

import {
  ORDERS_QUEUE_ADMIN,
  WORKER_ENV,
  WORKER_REDIS_QUEUE_CLIENT,
  WORKER_REDIS_STORE_CLIENT,
  WORKER_SALE_STORE,
} from '../common/tokens.js';
import type { WorkerEnv } from '../config/env.js';

const logRedisError =
  (scope: string) =>
  (error: Error): void => {
    console.error(JSON.stringify({ event: 'redis.error', scope, message: error.message }));
  };

export const redisProviders: Provider[] = [
  {
    provide: WORKER_REDIS_STORE_CLIENT,
    useFactory: (workerEnv: WorkerEnv): Redis => {
      const client = createRedisClient({
        url: workerEnv.REDIS_URL,
        connectionName: 'flash-worker-store',
      });
      client.on('error', logRedisError('store'));
      return client;
    },
    inject: [WORKER_ENV],
  },
  {
    provide: WORKER_REDIS_QUEUE_CLIENT,
    useFactory: (workerEnv: WorkerEnv): Redis => {
      const client = createRedisClient({
        url: workerEnv.REDIS_URL,
        connectionName: 'flash-worker-admin',
        overrides: {
          maxRetriesPerRequest: 2,
          commandTimeout: 2000,
          connectTimeout: 2000,
          enableReadyCheck: false,
        },
      });
      client.on('error', logRedisError('admin'));
      return client;
    },
    inject: [WORKER_ENV],
  },
  {
    provide: WORKER_SALE_STORE,
    useFactory: (client: Redis) => new SaleRedisStore(client),
    inject: [WORKER_REDIS_STORE_CLIENT],
  },
  {
    provide: ORDERS_QUEUE_ADMIN,
    useFactory: (workerEnv: WorkerEnv, client: Redis): Queue => {
      const queue = new Queue(workerEnv.ORDERS_QUEUE_NAME, {
        connection: client,
        prefix: ORDERS_QUEUE_PREFIX,
      });
      queue.on('error', logRedisError('queue-admin'));
      return queue;
    },
    inject: [WORKER_ENV, WORKER_REDIS_QUEUE_CLIENT],
  },
];
