/**
 * `pg.Pool` singleton — frozen contract §4.2.
 *
 * `new Pool(...)` is lazily-connecting by design (the `pg` driver only opens
 * a connection when a query is first run) — constructing it here never
 * blocks or fails app boot, which is required: "a Postgres outage at boot
 * must NOT prevent the API from starting" (PRD §3.5's reservations-keep-
 * succeeding-while-PG-is-down guarantee).
 */
import { Pool } from 'pg';
import type { ApiEnv } from '../config/env.js';

export function createPgPool(env: ApiEnv): Pool {
  return new Pool({
    connectionString: env.DATABASE_URL,
    max: env.PG_POOL_MAX,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 2000,
    statement_timeout: env.PG_STATEMENT_TIMEOUT_MS,
    application_name: 'flash-api',
  });
}

export async function closePgPool(pool: Pool): Promise<void> {
  await pool.end();
}
