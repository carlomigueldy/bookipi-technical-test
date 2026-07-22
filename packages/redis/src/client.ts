// packages/redis/src/client.ts
//
// The ioredis client factory. Frozen per .claude/contracts/phase-1.md §5.1 (redis-connections
// skill: multiplex, never a connection per request, explicit timeouts). Exactly one
// ioredis instance multiplexes all commands for a process; `SaleRedisStore` takes the
// client by injection and never constructs one itself.
//
// Phase 3 note (binding, from the frozen contract): BullMQ requires
// `maxRetriesPerRequest: null` on *its own* connection. Phase 3 MUST create a separate
// client for BullMQ and MUST NOT reuse or mutate this store's client — mutating shared
// options is how the hot path silently acquires unbounded retries.
import Redis, { type RedisOptions } from 'ioredis';

export interface CreateRedisClientOptions {
  /** REDIS_URL, e.g. redis://localhost:6379 */
  url: string;
  /** Appears in logs / CLIENT LIST. Default 'flash'. */
  connectionName?: string;
  /** ioredis escape hatch. MUST NOT be used to set keyPrefix (throws). */
  overrides?: Partial<RedisOptions>;
}

/**
 * ioredis applies `keyPrefix` to KEYS but not to ARGV, and it would sit *outside* our
 * `{hash tag}` — silently breaking Redis Cluster co-location of a sale's keys. Forbidden
 * unconditionally, not just discouraged.
 */
function assertNoKeyPrefixOverride(overrides: Partial<RedisOptions> | undefined): void {
  if (overrides && 'keyPrefix' in overrides && overrides.keyPrefix !== undefined) {
    throw new Error(
      'createRedisClient: overrides.keyPrefix is forbidden — it would apply outside the ' +
        '{saleId} hash tag and silently break Redis Cluster key co-location. See ' +
        '.claude/contracts/phase-1.md §5.1.',
    );
  }
}

export function createRedisClient(options: CreateRedisClientOptions): Redis {
  const { url, connectionName = 'flash', overrides } = options;
  assertNoKeyPrefixOverride(overrides);

  return new Redis(url, {
    connectionName,
    connectTimeout: 2000,
    commandTimeout: 1000,
    maxRetriesPerRequest: 2,
    enableReadyCheck: true,
    enableOfflineQueue: true,
    retryStrategy: (attempt: number) => Math.min(50 * 2 ** attempt, 2000),
    lazyConnect: false,
    ...overrides,
  });
}

/** Graceful QUIT; falls back to a hard disconnect if the server is unreachable. */
export async function closeRedisClient(client: Redis): Promise<void> {
  try {
    await client.quit();
  } catch {
    client.disconnect();
  }
}
