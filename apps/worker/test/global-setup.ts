import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import Redis from 'ioredis';
import { Client } from 'pg';

const exec = promisify(execFile);
const REDIS_IMAGE = 'redis:7.4-alpine';
const POSTGRES_IMAGE = 'postgres:16-alpine';
const schemaPath = path.resolve(__dirname, '../../../infra/postgres/init/001_schema.sql');
const suffix = randomUUID().slice(0, 8);
const redisName = `flash-worker-test-redis-${suffix}`;
const postgresName = `flash-worker-test-postgres-${suffix}`;
let ownedRedis = false;
let ownedPostgres = false;

interface SetupProject {
  provide(key: 'redisUrl' | 'postgresUrl', value: string): void;
}

async function waitFor<T>(operation: () => Promise<T>, label: string): Promise<T> {
  const deadline = Date.now() + 60_000;
  let cause: unknown;
  while (Date.now() < deadline) {
    try {
      return await operation();
    } catch (error) {
      cause = error;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  throw new Error(
    `${label} did not become ready: ${cause instanceof Error ? cause.message : String(cause)}`,
  );
}

async function redisUrl(): Promise<string> {
  if (process.env.REDIS_TEST_URL) {
    const client = new Redis(process.env.REDIS_TEST_URL, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
    });
    try {
      await client.connect();
      await client.ping();
    } finally {
      client.disconnect();
    }
    return process.env.REDIS_TEST_URL;
  }
  await exec('docker', [
    'run',
    '--detach',
    '--rm',
    '--name',
    redisName,
    '--publish',
    '127.0.0.1::6379',
    REDIS_IMAGE,
  ]);
  ownedRedis = true;
  const { stdout } = await exec('docker', ['port', redisName, '6379/tcp']);
  const port = stdout.trim().split(':').at(-1);
  const url = `redis://127.0.0.1:${port}`;
  await waitFor(async () => {
    const client = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 1 });
    try {
      await client.connect();
      return await client.ping();
    } finally {
      client.disconnect();
    }
  }, 'Redis');
  return url;
}

async function postgresUrl(): Promise<string> {
  const explicit = process.env.POSTGRES_TEST_URL;
  let url = explicit;
  if (!url) {
    await exec('docker', [
      'run',
      '--detach',
      '--rm',
      '--name',
      postgresName,
      '--env',
      'POSTGRES_DB=flash',
      '--env',
      'POSTGRES_USER=flash',
      '--env',
      'POSTGRES_PASSWORD=flash',
      '--publish',
      '127.0.0.1::5432',
      POSTGRES_IMAGE,
    ]);
    ownedPostgres = true;
    const { stdout } = await exec('docker', ['port', postgresName, '5432/tcp']);
    const port = stdout.trim().split(':').at(-1);
    url = `postgresql://flash:flash@127.0.0.1:${port}/flash`;
  }
  await waitFor(async () => {
    const client = new Client({ connectionString: url });
    try {
      await client.connect();
      return await client.query('SELECT 1');
    } finally {
      await client.end().catch(() => undefined);
    }
  }, 'Postgres');
  const client = new Client({ connectionString: url });
  try {
    await client.connect();
    const exists = await client.query<{ orders: string | null }>(
      "SELECT to_regclass('public.orders')::text AS orders",
    );
    if (!exists.rows[0]?.orders) await client.query(await readFile(schemaPath, 'utf8'));
  } finally {
    await client.end();
  }
  return url;
}

export async function setup(project: SetupProject): Promise<void> {
  const redis = await redisUrl();
  try {
    const postgres = await postgresUrl();
    project.provide('redisUrl', redis);
    project.provide('postgresUrl', postgres);
  } catch (error) {
    if (ownedRedis) await exec('docker', ['rm', '--force', redisName]).catch(() => undefined);
    throw error;
  }
}

export async function teardown(): Promise<void> {
  await Promise.all([
    ownedRedis ? exec('docker', ['rm', '--force', redisName]).catch(() => undefined) : undefined,
    ownedPostgres
      ? exec('docker', ['rm', '--force', postgresName]).catch(() => undefined)
      : undefined,
  ]);
}
