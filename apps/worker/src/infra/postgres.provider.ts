import { Pool } from 'pg';
import type { WorkerEnv } from '../config/env.js';

export function createWorkerPgPool(workerEnv: WorkerEnv): Pool {
  const pool = new Pool({
    connectionString: workerEnv.DATABASE_URL,
    max: workerEnv.WORKER_PG_POOL_MAX,
    connectionTimeoutMillis: 2000,
    idleTimeoutMillis: 30000,
    statement_timeout: workerEnv.WORKER_PG_STATEMENT_TIMEOUT_MS,
    application_name: 'flash-worker',
  });
  pool.on('error', (error) => {
    console.error(JSON.stringify({ event: 'postgres.pool_error', message: error.message }));
  });
  return pool;
}
