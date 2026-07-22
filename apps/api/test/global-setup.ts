// apps/api/test/global-setup.ts  [SLICE E — frozen contract §11.1]
//
// Starts ONE real `redis:7.4-alpine` and ONE real `postgres:16-alpine` (Testcontainers)
// for the whole integration run, applies `infra/postgres/init/001_schema.sql` to the
// Postgres container, and hands both connection URLs to every spec via
// `project.provide` (declared in `./vitest.d.ts`, consumed with `inject(...)`).
//
// Mirrors `packages/redis/test/global-setup.ts`'s frozen Phase 1 pattern exactly:
//   - REDIS_TEST_URL / POSTGRES_TEST_URL set in the environment -> use those, start
//     nothing, PING/SELECT-1 it, THROW if unreachable (the CI-service-container path).
//   - unset -> start a throwaway container, verify it, stop it on teardown.
//
// There is NO skip branch anywhere in this file. An unreachable datastore FAILS the
// whole integration run loudly — this is the inherited Phase 1 rule, restated as
// process rule #2 in `.claude/contracts/phase-2.md` §0: a Redis- or Postgres-dependent
// spec must never `describe.skip` / `it.skip` / early-return when the datastore is
// unavailable, and neither may this setup file.
import path from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import Redis from 'ioredis';
import { Client } from 'pg';

// Pinned to the exact image tags `infra/docker-compose.yml` uses, so the throwaway
// local container and a CI service container behave identically (Phase 1 precedent).
const REDIS_IMAGE = 'redis:7.4-alpine';
const POSTGRES_IMAGE = 'postgres:16-alpine';

// `apps/api`'s tsconfig targets CommonJS (`@flash/tooling/tsconfig/node.json`), where
// `__dirname` is a native CommonJS binding — no `import.meta.url` shim needed (and
// `import.meta` is in fact a compile error under a CommonJS `module` target).
const SCHEMA_SQL_PATH = path.resolve(__dirname, '../../../infra/postgres/init/001_schema.sql');

interface GlobalSetupProject {
  provide(key: 'redisUrl', value: string): void;
  provide(key: 'postgresUrl', value: string): void;
}

let redisContainer: StartedRedisContainer | undefined;
let postgresContainer: StartedPostgreSqlContainer | undefined;

async function assertRedisReachable(url: string): Promise<void> {
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

async function assertPostgresSchemaApplied(url: string): Promise<void> {
  const client = new Client({ connectionString: url });
  try {
    await client.connect();
    const { rows } = await client.query<{ reg: string | null }>(
      "SELECT to_regclass('public.orders') AS reg",
    );
    if (!rows[0]?.reg) {
      throw new Error(
        "Postgres is reachable but the 'orders' table does not exist — " +
          '001_schema.sql was not applied.',
      );
    }
  } finally {
    await client.end();
  }
}

async function startRedis(): Promise<string> {
  const explicitUrl = process.env.REDIS_TEST_URL;

  if (explicitUrl) {
    try {
      await assertRedisReachable(explicitUrl);
    } catch (err) {
      throw new Error(
        `apps/api test/global-setup: REDIS_TEST_URL='${explicitUrl}' is set but unreachable. ` +
          `Original error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return explicitUrl;
  }

  redisContainer = await new RedisContainer(REDIS_IMAGE).start();
  const url = redisContainer.getConnectionUrl();

  try {
    await assertRedisReachable(url);
  } catch (err) {
    await redisContainer.stop();
    throw new Error(
      `apps/api test/global-setup: throwaway testcontainers Redis (${REDIS_IMAGE}) started ` +
        `but is unreachable at ${url}. Original error: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return url;
}

async function startPostgres(): Promise<string> {
  const explicitUrl = process.env.POSTGRES_TEST_URL;

  if (explicitUrl) {
    try {
      await assertPostgresSchemaApplied(explicitUrl);
    } catch (err) {
      throw new Error(
        `apps/api test/global-setup: POSTGRES_TEST_URL='${explicitUrl}' is set but ` +
          `unreachable or missing schema. Original error: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return explicitUrl;
  }

  postgresContainer = await new PostgreSqlContainer(POSTGRES_IMAGE)
    .withDatabase('flash')
    .withUsername('flash')
    .withPassword('flash')
    .withCopyFilesToContainer([
      { source: SCHEMA_SQL_PATH, target: '/docker-entrypoint-initdb.d/001_schema.sql' },
    ])
    .start();
  const url = postgresContainer.getConnectionUri();

  try {
    await assertPostgresSchemaApplied(url);
  } catch (err) {
    await postgresContainer.stop();
    throw new Error(
      `apps/api test/global-setup: throwaway testcontainers Postgres (${POSTGRES_IMAGE}) ` +
        `started but failed schema verification at ${url}. Original error: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return url;
}

export async function setup(project: GlobalSetupProject): Promise<void> {
  // Sequential, not Promise.all: a failure in one must not leave the other's container
  // running un-torn-down if `teardown()` is never reached because `setup()` threw.
  const redisUrl = await startRedis();
  try {
    const postgresUrl = await startPostgres();
    project.provide('redisUrl', redisUrl);
    project.provide('postgresUrl', postgresUrl);
  } catch (err) {
    await redisContainer?.stop();
    throw err;
  }
}

export async function teardown(): Promise<void> {
  await Promise.all([redisContainer?.stop(), postgresContainer?.stop()]);
}
