/**
 * Two singleton ioredis clients — frozen contract §4.2 / Amendment A4 §18.4.
 * Created once at
 * `InfraModule` init via `@flash/redis`'s `createRedisClient(...)`; never a
 * connection per request. Separate, not shared, because their required
 * options are mutually incompatible and their failure domains must not
 * head-of-line-block each other:
 *
 * | Token               | connectionName          | Why separate |
 * |----------------------|--------------------------|--------------|
 * | REDIS_STORE_CLIENT   | flash-api-store          | the hot path; must never queue behind limiter/queue traffic |
 * | REDIS_LIMIT_CLIENT   | flash-api-ratelimit      | a slow limiter must fail fast and fail open (§7.4/§7.6) |
 *
 * The HTTP-facing BullMQ producer is deliberately absent. `OrdersQueueService`
 * owns its finite, lazily-created producer generations so it can hard-cancel
 * them without affecting either application Redis client.
 */
import type { Provider } from '@nestjs/common';
import { createRedisClient, SaleRedisStore } from '@flash/redis';
import type { Redis } from 'ioredis';

import {
  API_ENV,
  REDIS_LIMIT_CLIENT,
  REDIS_STORE_CLIENT,
  SALE_REDIS_STORE,
} from '../common/tokens.js';
import type { ApiEnv } from '../config/env.js';

export const redisProviders: Provider[] = [
  {
    provide: REDIS_STORE_CLIENT,
    useFactory: (env: ApiEnv): Redis =>
      createRedisClient({ url: env.REDIS_URL, connectionName: 'flash-api-store' }),
    inject: [API_ENV],
  },
  {
    provide: REDIS_LIMIT_CLIENT,
    useFactory: (env: ApiEnv): Redis =>
      createRedisClient({
        url: env.REDIS_URL,
        connectionName: 'flash-api-ratelimit',
        overrides: { commandTimeout: 250, maxRetriesPerRequest: 1 },
      }),
    inject: [API_ENV],
  },
  {
    provide: SALE_REDIS_STORE,
    useFactory: (client: Redis): SaleRedisStore => new SaleRedisStore(client),
    inject: [REDIS_STORE_CLIENT],
  },
];
