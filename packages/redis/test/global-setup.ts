// packages/redis/test/global-setup.ts
//
// Frozen per .claude/contracts/phase-1.md §6.2. An in-memory Redis client mock is
// banned for every Lua spec (§6.1) — a mock executes in the Node event loop, where
// concurrent "purchases" are interleaved by the JS scheduler, not by Redis's
// single-threaded dispatcher, so any apparent serialization would be an artefact of
// JS, not proof of atomicity. This setup guarantees every spec in this package runs
// against a real Redis 7.4 server:
//
//   - REDIS_TEST_URL set  -> use it, start nothing, PING it, THROW if unreachable.
//   - REDIS_TEST_URL unset -> start a throwaway `redis:7.4-alpine` testcontainer (same
//     tag as infra/docker-compose.yml), PING it, THROW if unreachable, stop it on
//     teardown.
//
// There is no skip branch. An unreachable Redis fails the whole suite loudly — adding
// `it.skip`/`describe.skip`/a try/catch downgrade here is an automatic contract
// violation per §6.2.
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import Redis from 'ioredis';

// Pinned to the exact image tag Phase 0 §12 uses for the real compose stack, so the
// throwaway local container and the CI service container behave identically.
const REDIS_IMAGE = 'redis:7.4-alpine';

interface GlobalSetupProject {
  provide(key: 'redisUrl', value: string): void;
}

let container: StartedRedisContainer | undefined;

async function assertReachable(url: string): Promise<void> {
  const client = new Redis(url, {
    lazyConnect: true,
    connectTimeout: 5000,
    commandTimeout: 5000,
    maxRetriesPerRequest: 1,
  });
  try {
    await client.connect();
    const pong = await client.ping();
    if (pong !== 'PONG') {
      throw new Error(`unexpected PING reply: ${JSON.stringify(pong)}`);
    }
  } finally {
    client.disconnect();
  }
}

export async function setup(project: GlobalSetupProject): Promise<void> {
  const explicitUrl = process.env.REDIS_TEST_URL;

  if (explicitUrl) {
    try {
      await assertReachable(explicitUrl);
    } catch (err) {
      throw new Error(
        `packages/redis test/global-setup: REDIS_TEST_URL='${explicitUrl}' is set but ` +
          `unreachable. Lua atomicity specs require a real Redis 7.4 server — there is ` +
          `no fallback to a mock. Original error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    project.provide('redisUrl', explicitUrl);
    return;
  }

  container = await new RedisContainer(REDIS_IMAGE).start();
  const url = container.getConnectionUrl();

  try {
    await assertReachable(url);
  } catch (err) {
    await container.stop();
    throw new Error(
      `packages/redis test/global-setup: throwaway testcontainers Redis (${REDIS_IMAGE}) ` +
        `started but is unreachable at ${url}. Original error: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }

  project.provide('redisUrl', url);
}

export async function teardown(): Promise<void> {
  await container?.stop();
}
