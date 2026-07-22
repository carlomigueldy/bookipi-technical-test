import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';

import {
  ORDERS_JOB_ATTEMPTS,
  ORDERS_QUEUE_PREFIX,
  PERSIST_ORDER_JOB_NAME,
  buildOrdersJobId,
  saleKeys,
} from '@flash/shared';
import { Worker, type Job } from 'bullmq';
import Redis from 'ioredis';
import { Pool } from 'pg';
import { afterEach, describe, expect, it } from 'vitest';

import { HealthController } from '../../src/health/health.controller.js';
import { WORKER_SHUTDOWN_WATCHDOG_MS } from '../../src/main.js';
import { OrderProcessor } from '../../src/orders/order.processor.js';
import { OrderRepository } from '../../src/orders/order.repository.js';
import {
  BULLMQ_MAX_STALLED_FAILED_REASON,
  ORDERS_MAX_STALLED_COUNT,
} from '../../src/orders/orders.consumer.js';
import { runAdvisoryRace } from '../support/advisory-race-barrier.js';
import {
  createHarness,
  eventually,
  orderRow,
  stock,
  yieldTurn,
  type WorkerHarness,
} from '../support/harness.js';
import { unsafeCompensateAfterRead } from '../support/unsafe-compensator.js';

const harnesses: WorkerHarness[] = [];
const insertAckChild = String.raw`
const {Worker}=require('bullmq'); const Redis=require('ioredis'); const {Pool}=require('pg');
const p=JSON.parse(process.env.TEST_JOB_PAYLOAD); const c=new Redis(process.env.TEST_REDIS_URL,{maxRetriesPerRequest:null,enableReadyCheck:false});
const pool=new Pool({connectionString:process.env.TEST_POSTGRES_URL});
const w=new Worker(process.env.TEST_QUEUE_NAME,async()=>{const x=await pool.connect();try{await x.query('BEGIN');await x.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text,0))',[p.reservationId]);await x.query("INSERT INTO orders (id,user_id,sale_id,status,created_at,persisted_at,request_id) VALUES ($1,$2,$3,'persisted',to_timestamp($4/1000.0),clock_timestamp(),$5) ON CONFLICT (user_id) DO NOTHING",[p.reservationId,p.userId,p.saleId,p.reservedAtMs,p.requestId]);await x.query('COMMIT');process.stdout.write('COMMITTED\\n');await new Promise(()=>{});}finally{x.release();}},{connection:c,prefix:'bull',concurrency:1,lockDuration:500,stalledInterval:500,maxStalledCount:2});
w.on('error',e=>process.stderr.write(String(e)+'\\n'));w.waitUntilReady().then(()=>process.stdout.write('READY\\n'));
`;
const fatalSupervisorChild = String.raw`
const main=require('./dist/main.js');
const mode=process.env.TEST_FATAL_MODE;
main.superviseWorkerLifecycle({
  start:async()=>{},
  waitForFatal:()=>mode==='reject'
    ? Promise.reject(new Error('simulated worker run rejection'))
    : Promise.resolve()
}).catch(async(error)=>{
  process.stdout.write('SUPERVISED_FATAL:'+error.message+'\\n');
  await main.shutdown(1);
}).catch((error)=>{
  process.stderr.write('SUPERVISOR_CLEANUP_FAILED:'+String(error)+'\\n');
  process.exitCode=1;
});
`;

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('failed to allocate health port');
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

async function childOutput(child: ReturnType<typeof spawn>, marker: string): Promise<void> {
  const stdout = child.stdout;
  if (!stdout) throw new Error('child stdout pipe missing');
  await new Promise<void>((resolve, reject) => {
    let output = '';
    const cleanup = () => {
      stdout.off('data', listener);
      child.off('error', reject);
      child.off('exit', onExit);
    };
    const listener = (chunk: Buffer) => {
      output += chunk.toString();
      if (output.includes(marker)) {
        cleanup();
        resolve();
      }
    };
    const onExit = (code: number | null) => {
      cleanup();
      reject(new Error(`child exited ${String(code)} before ${marker}`));
    };
    stdout.on('data', listener);
    child.once('error', reject);
    child.once('exit', onExit);
  });
}

async function harness(overrides: Parameters<typeof createHarness>[0] = {}) {
  const value = await createHarness(overrides);
  harnesses.push(value);
  return value;
}

afterEach(async () => {
  await Promise.allSettled(harnesses.splice(0).map((value) => value.close()));
});

function workerConnection(url: string, name: string): Redis {
  const client = new Redis(url, {
    connectionName: name,
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });
  client.on('error', (error) => console.error('test worker Redis error', error));
  return client;
}

async function runWorker(
  h: WorkerHarness,
  process: (job: Job) => Promise<void>,
  options: { lockDuration?: number; stalledInterval?: number } = {},
) {
  const connection = workerConnection(h.env.REDIS_URL, `test-worker-${randomUUID()}`);
  const worker = new Worker(h.env.ORDERS_QUEUE_NAME, process, {
    connection,
    prefix: ORDERS_QUEUE_PREFIX,
    concurrency: 1,
    lockDuration: options.lockDuration ?? 30_000,
    stalledInterval: options.stalledInterval ?? 30_000,
    maxStalledCount: ORDERS_MAX_STALLED_COUNT,
  });
  const errors: Error[] = [];
  worker.on('error', (error) => errors.push(error));
  await worker.waitUntilReady();
  return {
    worker,
    errors,
    connection,
    close: async (force = false) => {
      await worker.close(force);
      connection.disconnect(false);
    },
  };
}

async function awaitState(h: WorkerHarness, id: string, expected: string, timeout = 30_000) {
  return eventually(
    async () => (await h.queue.getJob(id))?.getState(),
    (state) => state === expected,
    `job ${id} state ${expected}`,
    timeout,
  );
}

function startBuiltWorker(h: WorkerHarness, port: number, overrides: NodeJS.ProcessEnv = {}) {
  let output = '';
  const child = spawn(process.execPath, ['dist/main.js'], {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      NODE_ENV: 'test',
      LOG_LEVEL: 'fatal',
      WORKER_HEALTH_PORT: String(port),
      DATABASE_URL: h.env.DATABASE_URL,
      REDIS_URL: h.env.REDIS_URL,
      SALE_ID: h.env.SALE_ID,
      SALE_NAME: h.env.SALE_NAME,
      SALE_STARTS_AT: h.env.SALE_STARTS_AT,
      SALE_ENDS_AT: h.env.SALE_ENDS_AT,
      SALE_TOTAL_STOCK: String(h.env.SALE_TOTAL_STOCK),
      ORDERS_QUEUE_NAME: h.env.ORDERS_QUEUE_NAME,
      WORKER_CONCURRENCY: '1',
      WORKER_PG_POOL_MAX: String(h.env.WORKER_PG_POOL_MAX),
      WORKER_RECONCILE_INTERVAL_MS: '250',
      WORKER_DLQ_SWEEP_INTERVAL_MS: '250',
      ...overrides,
    },
  });
  child.stdout.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stderr.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });
  return { child, output: () => output };
}

async function readiness(port: number): Promise<{
  status: number;
  checks: Record<string, unknown> | null;
}> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health/ready`);
    const body = (await response.json()) as { checks?: Record<string, unknown> };
    return { status: response.status, checks: body.checks ?? null };
  } catch {
    return { status: 0, checks: null };
  }
}

async function stopIfRunning(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGKILL');
  await eventually(
    async () => child.exitCode !== null || child.signalCode !== null,
    Boolean,
    'test child cleanup',
    10_000,
  ).catch(() => undefined);
}

async function runFatalSupervisorCase(mode: 'reject' | 'resolve') {
  let output = '';
  const startedAt = Date.now();
  const child = spawn(process.execPath, ['-e', fatalSupervisorChild], {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, TEST_FATAL_MODE: mode },
  });
  child.stdout.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stderr.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });
  try {
    await eventually(
      async () => child.exitCode,
      (code) => code !== null,
      `${mode} fatal supervisor exit`,
      2_000,
    );
    return { code: child.exitCode, elapsedMs: Date.now() - startedAt, output };
  } finally {
    await stopIfRunning(child);
  }
}

describe('Phase 3 real-container durability failures', () => {
  it('1. normal + duplicate delivery persists the reservation identity once', async () => {
    const h = await harness();
    await h.seed();
    const payload = await h.reserve('usr-normal');
    await h.reconciliation.start();
    await h.add(payload);
    const id = buildOrdersJobId(payload.saleId, payload.userId);
    await awaitState(h, id, 'completed');
    expect(await orderRow(h, payload.userId)).toEqual({
      id: payload.reservationId,
      status: 'persisted',
    });
    const replay = await h.queue.getJob(id);
    await h.processor.process(replay as Job);
    const count = await h.pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM orders WHERE user_id=$1',
      [payload.userId],
    );
    expect(count.rows[0]?.count).toBe('1');
  });

  it('2. insert-ack crash redelivers after commit without compensation', async () => {
    const h = await harness();
    await h.seed();
    const payload = await h.reserve('usr-ack-crash');
    const child = spawn(process.execPath, ['-e', insertAckChild], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'ignore'],
      env: {
        ...process.env,
        TEST_JOB_PAYLOAD: JSON.stringify(payload),
        TEST_REDIS_URL: h.env.REDIS_URL,
        TEST_POSTGRES_URL: h.env.DATABASE_URL,
        TEST_QUEUE_NAME: h.env.ORDERS_QUEUE_NAME,
      },
    });
    await childOutput(child, 'READY');
    await h.add(payload);
    await childOutput(child, 'COMMITTED');
    child.kill('SIGKILL');
    await new Promise<void>((resolve) => child.once('exit', () => resolve()));
    const second = await runWorker(h, (job) => h.processor.process(job), {
      lockDuration: 500,
      stalledInterval: 500,
    });
    const id = buildOrdersJobId(payload.saleId, payload.userId);
    await awaitState(h, id, 'completed', 15_000);
    await second.close();
    expect(await orderRow(h, payload.userId)).toEqual({
      id: payload.reservationId,
      status: 'persisted',
    });
    expect(await stock(h)).toBe(h.env.SALE_TOTAL_STOCK - 1);
    expect(await h.store.getReservation(h.env.SALE_ID, payload.userId)).toMatchObject({
      reservationId: payload.reservationId,
    });
  });

  it('3. Postgres outage exhausts five attempts, recovery compensates exactly once', async () => {
    const h = await harness();
    await h.seed();
    const payload = await h.reserve('usr-pg-outage');
    const badUrl = new URL(h.env.DATABASE_URL);
    badUrl.port = '1';
    const badPool = new Pool({ connectionString: badUrl.toString(), connectionTimeoutMillis: 100 });
    badPool.on('error', () => undefined);
    const failedProcessor = new OrderProcessor(new OrderRepository(badPool, h.env, h.store));
    const failing = await runWorker(h, (job) => failedProcessor.process(job));
    await h.add(payload);
    const id = buildOrdersJobId(payload.saleId, payload.userId);
    await awaitState(h, id, 'failed', 20_000);
    await failing.close();
    await badPool.end();
    expect((await h.queue.getJob(id))?.attemptsMade).toBe(ORDERS_JOB_ATTEMPTS);
    expect(await stock(h)).toBe(h.env.SALE_TOTAL_STOCK - 1);
    expect(await h.store.getReservation(h.env.SALE_ID, payload.userId)).not.toBeNull();
    await h.reconciliation.triggerDlqSweep();
    expect(await h.queue.getJob(id)).toBeUndefined();
    expect(await orderRow(h, payload.userId)).toEqual({
      id: payload.reservationId,
      status: 'compensated',
    });
    expect(await stock(h)).toBe(h.env.SALE_TOTAL_STOCK);
    expect(await h.store.getReservation(h.env.SALE_ID, payload.userId)).toBeNull();
  });

  it('4. crash after Redis compensation retries NOOP and never increments twice', async () => {
    const h = await harness();
    await h.seed();
    const payload = await h.reserve('usr-comp-crash');
    await expect(
      h.repository.resolveFailed(payload, async () => {
        const result = await h.store.compensate(
          payload.saleId,
          payload.userId,
          payload.reservationId,
        );
        throw Object.assign(new Error('crash before PG commit'), { result });
      }),
    ).rejects.toThrow('crash before PG commit');
    expect(await stock(h)).toBe(h.env.SALE_TOTAL_STOCK);
    expect(await orderRow(h, payload.userId)).toBeNull();
    await expect(
      h.repository.resolveFailed(payload, () =>
        h.store.compensate(payload.saleId, payload.userId, payload.reservationId),
      ),
    ).resolves.toBe('compensation_noop');
    expect(await orderRow(h, payload.userId)).toEqual({
      id: payload.reservationId,
      status: 'compensated',
    });
    expect(await stock(h)).toBe(h.env.SALE_TOTAL_STOCK);
  });

  it('5. advisory lock prevents persist/compensate race; unsafe negative control exposes it', async () => {
    const safe = await harness();
    await safe.seed();
    const safePayload = await safe.reserve('usr-safe-race');
    const safeResult = await runAdvisoryRace(safe, safePayload, (hooks) =>
      safe.repository.resolveFailed(
        safePayload,
        () =>
          safe.store.compensate(safePayload.saleId, safePayload.userId, safePayload.reservationId),
        hooks,
      ),
    );
    expect(safeResult).toMatchObject({
      firstObservation: 'persister_waiting_advisory',
      order: { id: safePayload.reservationId, status: 'compensated' },
      stock: safe.env.SALE_TOTAL_STOCK,
    });

    const unsafe = await harness();
    await unsafe.seed();
    const unsafePayload = await unsafe.reserve('usr-unsafe-race');
    const unsafeResult = await runAdvisoryRace(unsafe, unsafePayload, (hooks) =>
      unsafeCompensateAfterRead(unsafe.pool, unsafe.store, unsafePayload, hooks),
    );
    expect(unsafeResult).toMatchObject({
      firstObservation: 'persister_committed',
      order: { id: unsafePayload.reservationId, status: 'persisted' },
      stock: unsafe.env.SALE_TOTAL_STOCK,
    });
  });

  it('6. stale R1 compensation cannot remove R2 and repair clears the job-id collision', async () => {
    const h = await harness();
    await h.seed();
    const r1 = await h.reserve('usr-r1-r2');
    const failing = await runWorker(h, async () => {
      throw new Error('exhaust R1');
    });
    await h.add(r1);
    const id = buildOrdersJobId(r1.saleId, r1.userId);
    await awaitState(h, id, 'failed', 20_000);
    await failing.close();
    await h.repository.resolveFailed(r1, () =>
      h.store.compensate(r1.saleId, r1.userId, r1.reservationId),
    );
    const r2 = await h.reserve(r1.userId);
    await expect(h.store.compensate(r1.saleId, r1.userId, r1.reservationId)).resolves.toMatchObject(
      { outcome: 'NOOP' },
    );
    await h.reconciliation.triggerPass();
    expect((await h.queue.getJob(id))?.data.reservationId).toBe(r2.reservationId);
    const worker = await runWorker(h, (job) => h.processor.process(job));
    await awaitState(h, id, 'completed');
    await worker.close();
    expect(await orderRow(h, r2.userId)).toEqual({ id: r2.reservationId, status: 'persisted' });
    expect(await stock(h)).toBe(h.env.SALE_TOTAL_STOCK - 1);
  });

  it('7. continuous reconciliation repairs a live enqueue gap without restart', async () => {
    const h = await harness();
    await h.seed();
    await h.reconciliation.start();
    const payload = await h.reserve('usr-gap');
    await eventually(
      () => orderRow(h, payload.userId),
      (row) => row?.id === payload.reservationId,
      'continuous enqueue repair',
    );
    expect(
      (await h.queue.getJob(buildOrdersJobId(payload.saleId, payload.userId)))?.data.reservationId,
    ).toBe(payload.reservationId);
  });

  it('8. warm reconciliation restores membership, pending identity, and HLEN stock', async () => {
    const h = await harness();
    await h.seed();
    const persisted = await h.reserve('usr-warm-persisted');
    await h.repository.persist(persisted);
    const pending = await h.reserve('usr-warm-pending');
    await h.add(pending);
    const keys = saleKeys(h.env.SALE_ID);
    await h.redis.srem(keys.buyers, persisted.userId);
    await h.redis.set(keys.stock, '19');
    await h.reconciliation.triggerPass();
    expect(await h.redis.sismember(keys.buyers, persisted.userId)).toBe(1);
    expect(await h.store.getReservation(h.env.SALE_ID, pending.userId)).toMatchObject({
      reservationId: pending.reservationId,
    });
    expect(await stock(h)).toBe(h.env.SALE_TOTAL_STOCK - 2);
    expect(await h.queue.getWaitingCount()).toBe(1);
  });

  it('9. cold sale-key rebuild restores PG identities before consumer start', async () => {
    const h = await harness();
    await h.seed();
    const rows = [await h.reserve('usr-cold-1'), await h.reserve('usr-cold-2')];
    for (const payload of rows) await h.repository.persist(payload);
    await h.store.reset(h.env.SALE_ID);
    const originalStart = h.consumer.start.bind(h.consumer);
    let observedBeforeConsumer = false;
    h.consumer.start = async () => {
      observedBeforeConsumer =
        (await h.store.status(h.env.SALE_ID)).initialized &&
        (await stock(h)) === h.env.SALE_TOTAL_STOCK - rows.length;
      await originalStart();
    };
    await h.reconciliation.start();
    expect(observedBeforeConsumer).toBe(true);
    for (const payload of rows)
      expect(await h.store.getReservation(h.env.SALE_ID, payload.userId)).toMatchObject({
        reservationId: payload.reservationId,
      });
  });

  it('10. completed-without-PG is removed, re-enqueued, and persisted', async () => {
    const h = await harness();
    await h.seed();
    const payload = await h.reserve('usr-completed-gap');
    const noop = await runWorker(h, async () => undefined);
    await h.add(payload);
    const id = buildOrdersJobId(payload.saleId, payload.userId);
    await awaitState(h, id, 'completed');
    await noop.close();
    expect(await orderRow(h, payload.userId)).toBeNull();
    await h.reconciliation.triggerPass();
    const real = await runWorker(h, (job) => h.processor.process(job));
    await eventually(
      () => orderRow(h, payload.userId),
      (row) => row?.id === payload.reservationId,
      'completed job repair',
    );
    await real.close();
  });

  it('11. unrecoverable buyer-only and overcommitted ledger fail closed with readiness 503', async () => {
    const buyerOnly = await harness();
    await buyerOnly.seed();
    const keys = saleKeys(buyerOnly.env.SALE_ID);
    await buyerOnly.redis.sadd(keys.buyers, 'usr-lost-identity');
    await expect(buyerOnly.reconciliation.triggerPass()).rejects.toThrow(
      'unrecoverable buyer-only identity',
    );
    expect(await buyerOnly.redis.sismember(keys.buyers, 'usr-lost-identity')).toBe(1);
    let status = 0;
    new HealthController(buyerOnly.health).getReady({
      status(code) {
        status = code;
      },
    });
    expect(status).toBe(503);

    const over = await harness({ SALE_TOTAL_STOCK: 1 });
    await over.seed();
    await over.store.restoreReservations(over.env.SALE_ID, [
      { userId: 'usr-over-1', reservationId: randomUUID(), reservedAtMs: Date.now() },
      { userId: 'usr-over-2', reservationId: randomUUID(), reservedAtMs: Date.now() },
    ]);
    const before = await stock(over);
    await expect(over.reconciliation.triggerPass()).rejects.toThrow('OVERCOMMITTED');
    expect(await stock(over)).toBe(before);
    let overStatus = 0;
    new HealthController(over.health).getReady({
      status(code) {
        overStatus = code;
      },
    });
    expect(overStatus).toBe(503);
  });

  it('12. built production worker handles SIGTERM and closes Fastify, Redis, BullMQ, and PG', async () => {
    const h = await harness();
    const port = await freePort();
    let output = '';
    const child = spawn(process.execPath, ['dist/main.js'], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        NODE_ENV: 'test',
        LOG_LEVEL: 'fatal',
        WORKER_HEALTH_PORT: String(port),
        DATABASE_URL: h.env.DATABASE_URL,
        REDIS_URL: h.env.REDIS_URL,
        SALE_ID: h.env.SALE_ID,
        SALE_NAME: h.env.SALE_NAME,
        SALE_STARTS_AT: h.env.SALE_STARTS_AT,
        SALE_ENDS_AT: h.env.SALE_ENDS_AT,
        SALE_TOTAL_STOCK: String(h.env.SALE_TOTAL_STOCK),
        ORDERS_QUEUE_NAME: h.env.ORDERS_QUEUE_NAME,
        WORKER_RECONCILE_INTERVAL_MS: '250',
        WORKER_DLQ_SWEEP_INTERVAL_MS: '250',
      },
    });
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    await eventually(
      async () => {
        if (child.exitCode !== null) throw new Error(`worker exited early: ${output}`);
        try {
          return (await fetch(`http://127.0.0.1:${port}/health/ready`)).status;
        } catch {
          return 0;
        }
      },
      (status) => status === 200,
      'production worker readiness',
      20_000,
    );
    const payload = await h.reserve('usr-production-sigterm');
    await h.add(payload);
    await eventually(
      () => orderRow(h, payload.userId),
      (row) => row?.status === 'persisted',
      'production worker order',
    );
    const signalAt = Date.now();
    child.kill('SIGTERM');
    await eventually(
      async () => child.exitCode,
      (code) => code !== null,
      'production worker exit',
      10_000,
    );
    expect(child.exitCode).toBe(0);
    expect(Date.now() - signalAt).toBeLessThan(10_000);
    expect(output).toContain('worker.shutdown_started');
    expect(output).toContain('worker.shutdown_completed');
    expect(output).not.toMatch(/error|unhandled(?:Rejection| rejection)|uncaughtException/i);
    await expect(fetch(`http://127.0.0.1:${port}/health`)).rejects.toThrow();
    const clients = String(await h.redis.call('CLIENT', 'LIST'));
    expect(clients).not.toMatch(/name=flash-worker-(?:store|consumer|admin)/);
    const pg = await h.pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM pg_stat_activity WHERE application_name='flash-worker'",
    );
    expect(pg.rows[0]?.count).toBe('0');
    expect(await h.queue.getActiveCount()).toBe(0);
  }, 120_000);

  it('13. real installProcessHandlers watchdog exits 1 while the production default stays 10s', async () => {
    expect(WORKER_SHUTDOWN_WATCHDOG_MS).toBe(10_000);
    const child = spawn(
      process.execPath,
      [
        '-e',
        "const m=require('./dist/main.js');m.installProcessHandlers({shutdownFn:()=>new Promise(()=>{}),watchdogMs:250});process.stdout.write('READY\\n');setInterval(()=>{},1000)",
      ],
      { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] },
    );
    await childOutput(child, 'READY');
    const signalAt = Date.now();
    child.kill('SIGTERM');
    await eventually(
      async () => child.exitCode,
      (code) => code !== null,
      'watchdog child exit',
      2_000,
    );
    expect(child.exitCode).toBe(1);
    expect(Date.now() - signalAt).toBeLessThan(2_000);
  });

  it('14. lost BullMQ lock max-stalls below five attempts and still compensates terminally', async () => {
    const h = await harness();
    await h.seed();
    const payload = await h.reserve('usr-max-stalled');
    const lostLock = await runWorker(
      h,
      async (job) => {
        await h.redis.del(`${job.queueQualifiedName}:${job.id}:lock`);
      },
      { lockDuration: 250, stalledInterval: 250 },
    );
    await h.add(payload);
    const id = buildOrdersJobId(payload.saleId, payload.userId);
    await awaitState(h, id, 'failed', 15_000);
    await lostLock.close(true);
    const failed = await h.queue.getJob(id);
    expect(failed?.attemptsMade).toBeLessThan(ORDERS_JOB_ATTEMPTS);
    expect(failed?.failedReason).toBe(BULLMQ_MAX_STALLED_FAILED_REASON);
    expect(failed?.stalledCounter).toBeGreaterThan(ORDERS_MAX_STALLED_COUNT);
    await h.reconciliation.triggerDlqSweep();
    expect(await h.queue.getJob(id)).toBeUndefined();
    expect(await orderRow(h, payload.userId)).toEqual({
      id: payload.reservationId,
      status: 'compensated',
    });
    expect(await stock(h)).toBe(h.env.SALE_TOTAL_STOCK);
  });

  it('15. rotating bounded DLQ traversal resolves a valid tail behind malformed retained heads', async () => {
    const h = await harness({ WORKER_DLQ_SCAN_COUNT: 2 });
    await h.seed();
    await h.queue.add(
      PERSIST_ORDER_JOB_NAME,
      { malformed: 1 },
      { jobId: 'malformed-head-1', attempts: 1, removeOnFail: false },
    );
    await h.queue.add(
      PERSIST_ORDER_JOB_NAME,
      { malformed: 2 },
      { jobId: 'malformed-head-2', attempts: 1, removeOnFail: false },
    );
    const valid = await h.reserve('usr-valid-tail');
    await h.add(valid);
    const failing = await runWorker(h, async () => {
      throw new Error('terminal failure');
    });
    await awaitState(h, 'malformed-head-1', 'failed');
    await awaitState(h, 'malformed-head-2', 'failed');
    const validId = buildOrdersJobId(valid.saleId, valid.userId);
    await awaitState(h, validId, 'failed', 20_000);
    await failing.close();
    const originalGetJobs = h.queue.getJobs.bind(h.queue);
    let pageReads = 0;
    h.queue.getJobs = (async (...args: Parameters<typeof h.queue.getJobs>) => {
      if (Array.isArray(args[0]) && args[0].includes('failed')) {
        pageReads += 1;
        expect(Number(args[2]) - Number(args[1]) + 1).toBeLessThanOrEqual(2);
      }
      return originalGetJobs(...args);
    }) as typeof h.queue.getJobs;
    for (let pass = 0; pass < 4 && (await h.queue.getJob(validId)); pass += 1) {
      pageReads = 0;
      await h.reconciliation.triggerDlqSweep().catch((error: unknown) => {
        expect(error).toBeInstanceOf(Error);
      });
      expect(pageReads).toBeLessThanOrEqual(2);
      await yieldTurn();
    }
    expect(await h.queue.getJob(validId)).toBeUndefined();
    expect(await h.queue.getJob('malformed-head-1')).toBeDefined();
    expect(await h.queue.getJob('malformed-head-2')).toBeDefined();
    expect(await orderRow(h, valid.userId)).toEqual({
      id: valid.reservationId,
      status: 'compensated',
    });
    expect(h.state.reconciliationHealthy).toBe(false);
  });

  it('16. fresh start stays live but degraded behind malformed heads while periodic DLQ reaches the valid tail', async () => {
    const h = await harness({ WORKER_RECONCILE_SCAN_COUNT: 2, WORKER_DLQ_SCAN_COUNT: 2 });
    await h.seed();
    await h.queue.add(
      PERSIST_ORDER_JOB_NAME,
      { malformed: 'head-one' },
      { jobId: 'restart-malformed-head-1', attempts: 1, removeOnFail: false },
    );
    await h.queue.add(
      PERSIST_ORDER_JOB_NAME,
      { malformed: 'head-two' },
      { jobId: 'restart-malformed-head-2', attempts: 1, removeOnFail: false },
    );
    const valid = await h.reserve('usr-restart-valid-tail');
    await h.add(valid);
    const producer = await runWorker(h, async () => {
      throw new Error('produce retained failed state');
    });
    const validId = buildOrdersJobId(valid.saleId, valid.userId);
    await awaitState(h, 'restart-malformed-head-1', 'failed');
    await awaitState(h, 'restart-malformed-head-2', 'failed');
    await awaitState(h, validId, 'failed', 20_000);
    await producer.close();

    const retainedIds = ['restart-malformed-head-1', 'restart-malformed-head-2'] as const;
    const retainedBefore = await Promise.all(
      retainedIds.map(async (id) => (await h.queue.getJob(id))?.asJSON()),
    );
    const pageReads: Array<{ states: string[]; start: number; end: number }> = [];
    const originalGetJobs = h.queue.getJobs.bind(h.queue);
    h.queue.getJobs = (async (...args: Parameters<typeof h.queue.getJobs>) => {
      pageReads.push({
        states: Array.isArray(args[0]) ? args[0].map(String) : [String(args[0])],
        start: Number(args[1]),
        end: Number(args[2]),
      });
      return originalGetJobs(...args);
    }) as typeof h.queue.getJobs;
    const compensationResults: Array<{
      reservationId: string;
      outcome: string;
      stockRemaining: number;
    }> = [];
    const originalCompensate = h.store.compensate.bind(h.store);
    h.store.compensate = (async (...args: Parameters<typeof h.store.compensate>) => {
      const result = await originalCompensate(...args);
      compensationResults.push({ reservationId: args[2], ...result });
      return result;
    }) as typeof h.store.compensate;

    const fresh = h.freshLifecycle();
    await fresh.reconciliation.start();
    expect(fresh.state.bootstrapReconciled).toBe(true);
    expect(fresh.state.consumerReady).toBe(true);
    expect(fresh.consumer.ready).toBe(true);
    expect(await h.queue.isPaused()).toBe(false);
    const bootDlqAt = fresh.state.lastDlqSweepAt;
    await eventually(
      async () => ({ job: await h.queue.getJob(validId), sweepAt: fresh.state.lastDlqSweepAt }),
      ({ job, sweepAt }) => job === undefined && sweepAt !== null && sweepAt !== bootDlqAt,
      'periodic DLQ tail resolution after fresh start',
      20_000,
    );

    const retainedAfter = await Promise.all(
      retainedIds.map(async (id) => (await h.queue.getJob(id))?.asJSON()),
    );
    expect(retainedAfter).toEqual(retainedBefore);
    expect(fresh.state.retainedQueueEntries).toBeGreaterThanOrEqual(2);
    expect(await orderRow(h, valid.userId)).toEqual({
      id: valid.reservationId,
      status: 'compensated',
    });
    expect(compensationResults).toEqual([
      {
        reservationId: valid.reservationId,
        outcome: 'COMPENSATED',
        stockRemaining: h.env.SALE_TOTAL_STOCK,
      },
    ]);
    let readinessStatus = 0;
    new HealthController(fresh.health).getReady({
      status(code) {
        readinessStatus = code;
      },
    });
    expect(readinessStatus).toBe(503);
    expect(pageReads.length).toBeGreaterThan(0);
    for (const read of pageReads) {
      expect(read.end).not.toBe(-1);
      expect(read.end - read.start + 1).toBeLessThanOrEqual(h.env.WORKER_RECONCILE_SCAN_COUNT);
      if (read.states.includes('failed')) {
        expect(read.end - read.start + 1).toBeLessThanOrEqual(2);
      }
    }
  });

  it('17. fresh start removes proven completed R1, compensates only R2, and converges to R1', async () => {
    const h = await harness();
    await h.seed();
    const r1 = await h.reserve('usr-partial-loss-r1-r2');
    await h.add(r1);
    const r1Worker = await runWorker(h, (job) => h.processor.process(job));
    const deterministicJobId = buildOrdersJobId(r1.saleId, r1.userId);
    await awaitState(h, deterministicJobId, 'completed');
    await r1Worker.close();
    expect(await orderRow(h, r1.userId)).toEqual({ id: r1.reservationId, status: 'persisted' });
    expect((await h.queue.getJob(deterministicJobId))?.data.reservationId).toBe(r1.reservationId);

    const keys = saleKeys(h.env.SALE_ID);
    await h.redis.del(keys.buyers, keys.reservations, keys.stock);
    await h.redis.set(keys.stock, String(h.env.SALE_TOTAL_STOCK));
    const r2 = await h.reserve(r1.userId);
    expect(r2.reservationId).not.toBe(r1.reservationId);
    expect(await h.store.getReservation(h.env.SALE_ID, r1.userId)).toMatchObject({
      reservationId: r2.reservationId,
    });
    expect(await stock(h)).toBe(h.env.SALE_TOTAL_STOCK - 1);

    const compensatedIdentities: string[] = [];
    const originalCompensate = h.store.compensate.bind(h.store);
    h.store.compensate = async (saleId, userId, reservationId) => {
      compensatedIdentities.push(reservationId);
      return originalCompensate(saleId, userId, reservationId);
    };
    const fresh = h.freshLifecycle();
    const persistedIdentities: string[] = [];
    const originalPersist = fresh.repository.persist.bind(fresh.repository);
    fresh.repository.persist = async (payload, hooks) => {
      persistedIdentities.push(payload.reservationId);
      return originalPersist(payload, hooks);
    };
    await fresh.reconciliation.start();

    await eventually(
      async () => {
        const job = await h.queue.getJob(deterministicJobId);
        return job?.data.reservationId;
      },
      (reservationId) => reservationId === r2.reservationId,
      'R2 occupies deterministic job id after proven R1 removal',
    );
    await eventually(
      async () => ({
        job: await h.queue.getJob(deterministicJobId),
        durable: await orderRow(h, r1.userId),
        ledger: await h.store.getReservation(h.env.SALE_ID, r1.userId),
        buyer: await h.redis.sismember(keys.buyers, r1.userId),
        remaining: await stock(h),
        healthy: fresh.state.reconciliationHealthy,
      }),
      ({ job, durable, ledger, buyer, remaining, healthy }) =>
        job === undefined &&
        durable?.id === r1.reservationId &&
        durable.status === 'persisted' &&
        ledger?.reservationId === r1.reservationId &&
        buyer === 1 &&
        remaining === h.env.SALE_TOTAL_STOCK - 1 &&
        healthy,
      'R1 durable and Redis convergence after identity-safe R2 compensation',
      20_000,
    );

    expect(persistedIdentities).toEqual(Array(ORDERS_JOB_ATTEMPTS).fill(r2.reservationId));
    expect(compensatedIdentities).toEqual([r2.reservationId]);
    expect(compensatedIdentities).not.toContain(r1.reservationId);
    expect(
      await h.pool.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM orders WHERE user_id=$1 AND id=$2',
        [r1.userId, r2.reservationId],
      ),
    ).toMatchObject({ rows: [{ count: '0' }] });
    let readinessStatus = 0;
    new HealthController(fresh.health).getReady({
      status(code) {
        readinessStatus = code;
      },
    });
    expect(readinessStatus).toBe(200);
    const stableStock = await stock(h);
    const reconciledAt = fresh.state.lastReconciledAt;
    await eventually(
      async () => fresh.state.lastReconciledAt,
      (value) => value !== null && value !== reconciledAt,
      'subsequent periodic reconciliation',
    );
    expect(await stock(h)).toBe(stableStock);
    expect(compensatedIdentities).toEqual([r2.reservationId]);
  });

  it('18. PG fence excludes P3 through P2 resume verification and P3 pause blocks P2', async () => {
    const h = await harness({
      WORKER_RECONCILE_INTERVAL_MS: 60_000,
      WORKER_DLQ_SWEEP_INTERVAL_MS: 60_000,
    });
    await h.seed();
    const p2 = h.barrierLifecycle();
    const p3 = h.barrierLifecycle();
    const fenceClient = await h.pool.connect();
    let fenceHeld = false;
    let p3EnteredDiff = false;
    p3.beforeConsumerStart.entered.then(() => {
      p3EnteredDiff = true;
    });
    const p2Start = p2.reconciliation.start();
    void p2Start.catch(() => undefined);
    let p3Start: Promise<void> | null = null;
    try {
      await p2.beforeConsumerStart.entered;
      expect(await h.queue.isPaused()).toBe(true);
      expect(p2.state.bootstrapReconciled).toBe(false);
      expect(p2.state.consumerReady).toBe(false);

      p3Start = p3.reconciliation.start();
      void p3Start.catch(() => undefined);
      await yieldTurn();
      expect(p3EnteredDiff).toBe(false);
      const excludedAtDiff = await fenceClient.query<{ acquired: boolean }>(
        `SELECT pg_try_advisory_lock(
           hashtextextended('flash-reconcile:' || $1,0)
         ) AS acquired`,
        [h.env.SALE_ID],
      );
      expect(excludedAtDiff.rows[0]?.acquired).toBe(false);

      p2.beforeConsumerStart.release();
      await p2.afterResumeVerified.entered;
      expect(p2.consumer.ready).toBe(true);
      expect(await h.queue.isPaused()).toBe(false);
      expect(p2.state.bootstrapReconciled).toBe(false);
      expect(p2.state.consumerReady).toBe(false);
      expect(p3EnteredDiff).toBe(false);
      const excludedAfterResume = await fenceClient.query<{ acquired: boolean }>(
        `SELECT pg_try_advisory_lock(
           hashtextextended('flash-reconcile:' || $1,0)
         ) AS acquired`,
        [h.env.SALE_ID],
      );
      expect(excludedAfterResume.rows[0]?.acquired).toBe(false);

      p2.afterResumeVerified.release();
      await p2Start;
      await p3.beforeConsumerStart.entered;
      expect(p3EnteredDiff).toBe(true);
      expect(await h.queue.isPaused()).toBe(true);
      expect(p2.state.bootstrapReconciled).toBe(true);
      expect(p2.state.consumerReady).toBe(true);
      expect(p3.state.bootstrapReconciled).toBe(false);
      expect(p3.state.consumerReady).toBe(false);

      const payload = await h.reserve('usr-fenced-ready-transition');
      await h.add(payload);
      const jobId = buildOrdersJobId(payload.saleId, payload.userId);
      for (let observation = 0; observation < 10; observation += 1) {
        await yieldTurn();
        expect(await (await h.queue.getJob(jobId))?.getState()).toBe('waiting');
        expect(await orderRow(h, payload.userId)).toBeNull();
      }

      p3.beforeConsumerStart.release();
      await p3.afterResumeVerified.entered;
      expect(p3.consumer.ready).toBe(true);
      expect(await h.queue.isPaused()).toBe(false);
      expect(p3.state.bootstrapReconciled).toBe(false);
      expect(p3.state.consumerReady).toBe(false);
      const excludedAtP3Resume = await fenceClient.query<{ acquired: boolean }>(
        `SELECT pg_try_advisory_lock(
           hashtextextended('flash-reconcile:' || $1,0)
         ) AS acquired`,
        [h.env.SALE_ID],
      );
      expect(excludedAtP3Resume.rows[0]?.acquired).toBe(false);

      p3.afterResumeVerified.release();
      await p3Start;
      await awaitState(h, jobId, 'completed');
      expect(
        await h.pool.query<{ count: string; id: string; status: string }>(
          `SELECT count(*) OVER ()::text AS count,id,status
           FROM orders WHERE user_id=$1`,
          [payload.userId],
        ),
      ).toMatchObject({
        rows: [{ count: '1', id: payload.reservationId, status: 'persisted' }],
      });
      expect(p2.state.bootstrapReconciled).toBe(true);
      expect(p2.state.consumerReady).toBe(true);
      expect(p2.state.reconciliationHealthy).toBe(true);
      expect(p3.state.bootstrapReconciled).toBe(true);
      expect(p3.state.consumerReady).toBe(true);
      expect(p3.state.reconciliationHealthy).toBe(true);

      await eventually(
        async () => {
          const result = await fenceClient.query<{ acquired: boolean }>(
            `SELECT pg_try_advisory_lock(
               hashtextextended('flash-reconcile:' || $1,0)
             ) AS acquired`,
            [h.env.SALE_ID],
          );
          return result.rows[0]?.acquired === true;
        },
        Boolean,
        'PG fence available after both transitions',
      );
      fenceHeld = true;
      const unlocked = await fenceClient.query<{ unlocked: boolean }>(
        `SELECT pg_advisory_unlock(
           hashtextextended('flash-reconcile:' || $1,0)
         ) AS unlocked`,
        [h.env.SALE_ID],
      );
      expect(unlocked.rows[0]?.unlocked).toBe(true);
      fenceHeld = false;
    } finally {
      p2.beforeConsumerStart.release();
      p2.afterResumeVerified.release();
      p3.beforeConsumerStart.release();
      p3.afterResumeVerified.release();
      if (fenceHeld) {
        await fenceClient
          .query(
            `SELECT pg_advisory_unlock(
               hashtextextended('flash-reconcile:' || $1,0)
             )`,
            [h.env.SALE_ID],
          )
          .catch(() => undefined);
      }
      fenceClient.release();
      await Promise.allSettled([p2.close(), p3.close()]);
    }
  }, 30_000);

  it('19. built fatal supervisor rejects run failure and impossible resolution without leaks', async () => {
    const [rejected, resolved] = await Promise.all([
      runFatalSupervisorCase('reject'),
      runFatalSupervisorCase('resolve'),
    ]);
    expect(rejected.code).toBe(1);
    expect(rejected.elapsedMs).toBeLessThan(2_000);
    expect(rejected.output).toContain('SUPERVISED_FATAL:simulated worker run rejection');
    expect(rejected.output).toContain('worker.shutdown_started');
    expect(rejected.output).toContain('worker.shutdown_completed');
    expect(rejected.output).not.toMatch(
      /unhandled(?:Rejection| rejection)|uncaughtException|SUPERVISOR_CLEANUP_FAILED/i,
    );
    expect(resolved.code).toBe(1);
    expect(resolved.elapsedMs).toBeLessThan(2_000);
    expect(resolved.output).toContain(
      'SUPERVISED_FATAL:worker fatal channel resolved unexpectedly',
    );
    expect(resolved.output).toContain('worker.shutdown_started');
    expect(resolved.output).toContain('worker.shutdown_completed');
    expect(resolved.output).not.toMatch(
      /unhandled(?:Rejection| rejection)|uncaughtException|SUPERVISOR_CLEANUP_FAILED/i,
    );
  });

  it('20. P2 shutdown during fenced orphan recovery is clean before built P3 persists once', async () => {
    const h = await harness();
    const p1Port = await freePort();
    const p2Port = await freePort();
    const p3Port = await freePort();
    const p1 = startBuiltWorker(h, p1Port);
    let p2: ReturnType<typeof startBuiltWorker> | null = null;
    let p3: ReturnType<typeof startBuiltWorker> | null = null;
    const advisory = await h.pool.connect();
    let lockedReservationId: string | null = null;
    try {
      await eventually(
        () => readiness(p1Port),
        ({ status }) => status === 200,
        'built P1 readiness 200',
        20_000,
      );
      const payload = await h.reserve('usr-production-orphan-restart');
      await advisory.query('SELECT pg_advisory_lock(hashtextextended($1::text,0))', [
        payload.reservationId,
      ]);
      lockedReservationId = payload.reservationId;
      await h.add(payload);
      const jobId = buildOrdersJobId(payload.saleId, payload.userId);
      const activeJob = await awaitState(h, jobId, 'active', 20_000);
      expect(activeJob).toBe('active');
      const job = await h.queue.getJob(jobId);
      expect(job).toBeDefined();
      const lockKey = `${job!.queueQualifiedName}:${jobId}:lock`;
      expect(await h.redis.exists(lockKey)).toBe(1);
      expect(await orderRow(h, payload.userId)).toBeNull();

      p1.child.kill('SIGKILL');
      await eventually(
        async () => ({ exitCode: p1.child.exitCode, signalCode: p1.child.signalCode }),
        ({ signalCode }) => signalCode === 'SIGKILL',
        'built P1 SIGKILL exit',
        10_000,
      );
      expect(await (await h.queue.getJob(jobId))?.getState()).toBe('active');
      expect(await h.redis.exists(lockKey)).toBe(1);

      const unlock = await advisory.query<{ unlocked: boolean }>(
        'SELECT pg_advisory_unlock(hashtextextended($1::text,0)) AS unlocked',
        [payload.reservationId],
      );
      expect(unlock.rows[0]?.unlocked).toBe(true);
      lockedReservationId = null;
      const orphanBeforeP2 = (await h.queue.getJob(jobId))?.asJSON();

      p2 = startBuiltWorker(h, p2Port);
      await eventually(
        async () => ({
          probe: await readiness(p2Port),
          paused: await h.queue.isPaused(),
          state: await (await h.queue.getJob(jobId))?.getState(),
          durable: await orderRow(h, payload.userId),
        }),
        ({ probe, paused, state, durable }) =>
          probe.status === 503 && paused && state === 'active' && durable === null,
        'built P2 paused and unready with unprocessed active orphan',
        20_000,
      );
      const p2Fence = await advisory.query<{ acquired: boolean }>(
        `SELECT pg_try_advisory_lock(
           hashtextextended('flash-reconcile:' || $1,0)
         ) AS acquired`,
        [h.env.SALE_ID],
      );
      expect(p2Fence.rows[0]?.acquired).toBe(false);

      const p2SignalAt = Date.now();
      p2.child.kill('SIGTERM');
      await eventually(
        async () => p2?.child.exitCode,
        (code) => code !== null,
        'built P2 recovery SIGTERM exit',
        WORKER_SHUTDOWN_WATCHDOG_MS,
      );
      expect(p2.child.exitCode, p2.output()).toBe(0);
      expect(Date.now() - p2SignalAt).toBeLessThan(WORKER_SHUTDOWN_WATCHDOG_MS);
      expect(p2.output()).toContain('worker.shutdown_started');
      expect(p2.output()).toContain('worker.shutdown_completed');
      expect(p2.output()).not.toMatch(/unhandled(?:Rejection| rejection)|uncaughtException/i);
      expect(await (await h.queue.getJob(jobId))?.getState()).toBe('active');
      expect((await h.queue.getJob(jobId))?.asJSON()).toEqual(orphanBeforeP2);
      expect(await orderRow(h, payload.userId)).toBeNull();
      expect(await h.queue.isPaused()).toBe(true);
      await expect(fetch(`http://127.0.0.1:${p2Port}/health`)).rejects.toThrow();

      let clients = String(await h.redis.call('CLIENT', 'LIST'));
      expect(clients).not.toMatch(/name=flash-worker-(?:store|consumer|events|admin)/);
      let pg = await h.pool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM pg_stat_activity WHERE application_name='flash-worker'",
      );
      expect(pg.rows[0]?.count).toBe('0');
      const p2ReleasedFence = await advisory.query<{ acquired: boolean }>(
        `SELECT pg_try_advisory_lock(
           hashtextextended('flash-reconcile:' || $1,0)
         ) AS acquired`,
        [h.env.SALE_ID],
      );
      expect(p2ReleasedFence.rows[0]?.acquired).toBe(true);
      const releaseP2Fence = await advisory.query<{ unlocked: boolean }>(
        `SELECT pg_advisory_unlock(
           hashtextextended('flash-reconcile:' || $1,0)
         ) AS unlocked`,
        [h.env.SALE_ID],
      );
      expect(releaseP2Fence.rows[0]?.unlocked).toBe(true);

      p3 = startBuiltWorker(h, p3Port);
      await eventually(
        async () => ({
          probe: await readiness(p3Port),
          paused: await h.queue.isPaused(),
          state: await (await h.queue.getJob(jobId))?.getState(),
          durable: await orderRow(h, payload.userId),
        }),
        ({ probe, paused, state, durable }) =>
          probe.status === 503 && paused && state === 'active' && durable === null,
        'built P3 fenced orphan recovery',
        20_000,
      );
      await eventually(
        async () => {
          const result = await advisory.query<{ acquired: boolean }>(
            `SELECT pg_try_advisory_lock(
               hashtextextended('flash-reconcile:' || $1,0)
             ) AS acquired`,
            [h.env.SALE_ID],
          );
          if (!result.rows[0]?.acquired) return true;
          const release = await advisory.query<{ unlocked: boolean }>(
            `SELECT pg_advisory_unlock(
               hashtextextended('flash-reconcile:' || $1,0)
             ) AS unlocked`,
            [h.env.SALE_ID],
          );
          expect(release.rows[0]?.unlocked).toBe(true);
          return false;
        },
        Boolean,
        'built P3 owns recovery fence',
        20_000,
      );

      await eventually(
        async () => ({
          state: await (await h.queue.getJob(jobId))?.getState(),
          row: await orderRow(h, payload.userId),
          probe: await readiness(p3Port),
          paused: await h.queue.isPaused(),
        }),
        ({ state, row, probe, paused }) =>
          state === 'completed' &&
          row?.id === payload.reservationId &&
          row.status === 'persisted' &&
          probe.status === 200 &&
          probe.checks?.bootstrapReconciled === true &&
          probe.checks.consumerReady === true &&
          probe.checks.reconciliationHealthy === true &&
          !paused,
        'built P3 resumed terminal persistence and readiness',
        100_000,
      );

      const durable = await h.pool.query<{ count: string; id: string; status: string }>(
        `SELECT count(*) OVER ()::text AS count,id,status
         FROM orders WHERE user_id=$1`,
        [payload.userId],
      );
      expect(durable.rows).toEqual([
        { count: '1', id: payload.reservationId, status: 'persisted' },
      ]);
      const keys = saleKeys(h.env.SALE_ID);
      expect(await h.store.getReservation(h.env.SALE_ID, payload.userId)).toMatchObject({
        reservationId: payload.reservationId,
      });
      expect(await h.redis.sismember(keys.buyers, payload.userId)).toBe(1);
      expect(await stock(h)).toBe(h.env.SALE_TOTAL_STOCK - 1);

      p3.child.kill('SIGTERM');
      await eventually(
        async () => p3?.child.exitCode,
        (code) => code !== null,
        'built P3 SIGTERM exit',
        WORKER_SHUTDOWN_WATCHDOG_MS,
      );
      expect(p3.child.exitCode).toBe(0);
      expect(p3.output()).toContain('worker.shutdown_started');
      expect(p3.output()).toContain('worker.shutdown_completed');
      expect(`${p1.output()}\n${p2.output()}\n${p3.output()}`).not.toMatch(
        /unhandled(?:Rejection| rejection)|uncaughtException/i,
      );
      await expect(fetch(`http://127.0.0.1:${p3Port}/health`)).rejects.toThrow();
      clients = String(await h.redis.call('CLIENT', 'LIST'));
      expect(clients).not.toMatch(/name=flash-worker-(?:store|consumer|events|admin)/);
      pg = await h.pool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM pg_stat_activity WHERE application_name='flash-worker'",
      );
      expect(pg.rows[0]?.count).toBe('0');
      expect(await h.queue.getActiveCount()).toBe(0);
    } finally {
      if (lockedReservationId) {
        await advisory
          .query('SELECT pg_advisory_unlock(hashtextextended($1::text,0))', [lockedReservationId])
          .catch(() => undefined);
      }
      advisory.release();
      await Promise.all([
        stopIfRunning(p1.child),
        ...(p2 ? [stopIfRunning(p2.child)] : []),
        ...(p3 ? [stopIfRunning(p3.child)] : []),
      ]);
    }
  }, 120_000);

  it('21. production module boots through the reconciliation fence with the legal pool minimum', async () => {
    const h = await harness({
      WORKER_PG_POOL_MAX: 2,
      WORKER_RECONCILE_INTERVAL_MS: 60_000,
      WORKER_DLQ_SWEEP_INTERVAL_MS: 60_000,
    });
    await h.seed();
    const payload = await h.reserve('usr-production-pool-minimum');
    await h.add(payload);
    const jobId = buildOrdersJobId(payload.saleId, payload.userId);
    const production = await h.productionMinimumPoolLifecycle();
    const observer = await h.pool.connect();
    let observerOwnsFence = false;
    let barrierEntered = false;
    let startupSettled = false;
    production.beforeConsumerStart.entered.then(() => {
      barrierEntered = true;
    });
    const startup = production.reconciliation.start().finally(() => {
      startupSettled = true;
    });
    void startup.catch(() => undefined);
    try {
      await eventually(
        async () => barrierEntered,
        Boolean,
        'production pool-2 boot diff barrier',
        20_000,
      );

      expect(production.pool.options.max).toBe(2);
      expect(production.pool.totalCount).toBe(2);
      expect(production.pool.waitingCount).toBe(0);
      expect(startupSettled).toBe(false);
      expect(await production.queue.isPaused()).toBe(true);
      expect(production.state.bootstrapReconciled).toBe(false);
      expect(production.state.consumerReady).toBe(false);
      expect(await production.store.getReservation(h.env.SALE_ID, payload.userId)).toMatchObject({
        reservationId: payload.reservationId,
      });
      expect(await orderRow(h, payload.userId)).toBeNull();
      expect(await (await h.queue.getJob(jobId))?.getState()).toBe('waiting');

      const excluded = await observer.query<{ acquired: boolean }>(
        `SELECT pg_try_advisory_lock(
           hashtextextended('flash-reconcile:' || $1,0)
         ) AS acquired`,
        [h.env.SALE_ID],
      );
      expect(excluded.rows[0]?.acquired).toBe(false);

      production.beforeConsumerStart.release();
      await eventually(
        async () => ({
          settled: startupSettled,
          paused: await production.queue.isPaused(),
          bootstrapReconciled: production.state.bootstrapReconciled,
          consumerReady: production.state.consumerReady,
          healthy: production.state.reconciliationHealthy,
        }),
        (state) =>
          state.settled &&
          !state.paused &&
          state.bootstrapReconciled &&
          state.consumerReady &&
          state.healthy,
        'production pool-2 readiness after fence release',
        20_000,
      );
      await startup;

      await eventually(
        async () => {
          const result = await observer.query<{ acquired: boolean }>(
            `SELECT pg_try_advisory_lock(
               hashtextextended('flash-reconcile:' || $1,0)
             ) AS acquired`,
            [h.env.SALE_ID],
          );
          return result.rows[0]?.acquired === true;
        },
        Boolean,
        'production pool-2 reconciliation fence release',
        20_000,
      );
      observerOwnsFence = true;
      const unlocked = await observer.query<{ unlocked: boolean }>(
        `SELECT pg_advisory_unlock(
           hashtextextended('flash-reconcile:' || $1,0)
         ) AS unlocked`,
        [h.env.SALE_ID],
      );
      expect(unlocked.rows[0]?.unlocked).toBe(true);
      observerOwnsFence = false;

      await awaitState(h, jobId, 'completed', 20_000);
      expect(
        await h.pool.query<{ count: string; id: string; status: string }>(
          `SELECT count(*) OVER ()::text AS count,id,status
           FROM orders WHERE user_id=$1`,
          [payload.userId],
        ),
      ).toMatchObject({
        rows: [{ count: '1', id: payload.reservationId, status: 'persisted' }],
      });
    } finally {
      production.beforeConsumerStart.release();
      if (observerOwnsFence) {
        await observer
          .query(
            `SELECT pg_advisory_unlock(
               hashtextextended('flash-reconcile:' || $1,0)
             )`,
            [h.env.SALE_ID],
          )
          .catch(() => undefined);
      }
      observer.release();
      await production.close();
    }
  }, 120_000);

  it('22. built production rejects pool size one before opening any resource', async () => {
    const h = await harness();
    const port = await freePort();
    const initialPaused = await h.queue.isPaused();
    const initialCounts = await h.queue.getJobCounts('active', 'waiting', 'delayed', 'failed');
    const startedAt = Date.now();
    const production = startBuiltWorker(h, port, {
      NODE_ENV: 'production',
      WORKER_PG_POOL_MAX: '1',
    });
    let healthOpened = false;
    try {
      await eventually(
        async () => {
          const probe = await readiness(port);
          if (probe.status !== 0) healthOpened = true;
          return production.child.exitCode;
        },
        (code) => code !== null,
        'invalid production pool-size exit',
        2_000,
      );
      expect(production.child.exitCode).toBe(1);
      expect(Date.now() - startedAt).toBeLessThan(2_000);
      expect(production.output()).toContain('invalid environment configuration');
      expect(production.output()).toContain('WORKER_PG_POOL_MAX');
      expect(healthOpened).toBe(false);
      await expect(fetch(`http://127.0.0.1:${port}/health`)).rejects.toThrow();

      const clients = String(await h.redis.call('CLIENT', 'LIST'));
      expect(clients).not.toMatch(/name=flash-worker-(?:store|consumer|events|admin)/);
      const pg = await h.pool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM pg_stat_activity WHERE application_name='flash-worker'",
      );
      expect(pg.rows[0]?.count).toBe('0');
      expect(await h.queue.isPaused()).toBe(initialPaused);
      expect(await h.queue.getJobCounts('active', 'waiting', 'delayed', 'failed')).toEqual(
        initialCounts,
      );
    } finally {
      await stopIfRunning(production.child);
    }
  }, 10_000);
});
