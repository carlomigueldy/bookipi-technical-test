import { Inject, Injectable } from '@nestjs/common';
import type { CompensateResult, SaleRedisStore } from '@flash/redis';
import type { OrdersQueueJobPayload } from '@flash/shared';
import type { Pool, PoolClient } from 'pg';

import { WORKER_ENV, WORKER_PG_POOL, WORKER_SALE_STORE } from '../common/tokens.js';
import type { WorkerEnv } from '../config/env.js';

export type DurableOrderStatus = 'persisted' | 'compensated';
export interface DurableOrder {
  id: string;
  userId: string;
  saleId: string;
  status: DurableOrderStatus;
  createdAtMs: number;
  requestId: string;
}
export type PersistResult = 'persisted' | 'idempotent' | 'compensated';
export type ResolveFailedResult = 'persisted' | 'compensated' | 'compensation_noop';
export const RECONCILIATION_LOCK_POLL_MS = 100 as const;

export class PersistenceConflictError extends Error {}

export interface AdvisoryRaceHooks {
  afterResolverAbsentRead?: () => Promise<void>;
  beforePersisterAdvisoryLock?: (backendPid: number) => Promise<void>;
  afterPersisterCommit?: () => Promise<void>;
}

interface OrderDbRow {
  id: string;
  user_id: string;
  sale_id: string;
  status: DurableOrderStatus;
  created_at_ms: string;
  request_id: string;
}

function fromRow(row: OrderDbRow): DurableOrder {
  return {
    id: row.id,
    userId: row.user_id,
    saleId: row.sale_id,
    status: row.status,
    createdAtMs: Number(row.created_at_ms),
    requestId: row.request_id,
  };
}

@Injectable()
export class OrderRepository {
  constructor(
    @Inject(WORKER_PG_POOL) private readonly pool: Pool,
    @Inject(WORKER_ENV) private readonly env: WorkerEnv,
    @Inject(WORKER_SALE_STORE) private readonly store: SaleRedisStore,
  ) {}

  async ensureSale(): Promise<void> {
    await this.pool.query(
      `INSERT INTO sales (id,name,total_stock,starts_at,ends_at) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (id) DO NOTHING`,
      [
        this.env.SALE_ID,
        this.env.SALE_NAME,
        this.env.SALE_TOTAL_STOCK,
        this.env.SALE_STARTS_AT,
        this.env.SALE_ENDS_AT,
      ],
    );
    const result = await this.pool.query<{
      name: string;
      total_stock: number;
      starts_ms: string;
      ends_ms: string;
    }>(
      `SELECT name,total_stock,
              (extract(epoch from starts_at)*1000)::bigint::text AS starts_ms,
              (extract(epoch from ends_at)*1000)::bigint::text AS ends_ms
       FROM sales WHERE id=$1`,
      [this.env.SALE_ID],
    );
    const row = result.rows[0];
    if (
      !row ||
      row.name !== this.env.SALE_NAME ||
      row.total_stock !== this.env.SALE_TOTAL_STOCK ||
      Number(row.starts_ms) !== Date.parse(this.env.SALE_STARTS_AT) ||
      Number(row.ends_ms) !== Date.parse(this.env.SALE_ENDS_AT)
    ) {
      throw new Error(`sale configuration drift for ${this.env.SALE_ID}`);
    }
  }

  async persist(
    payload: OrdersQueueJobPayload,
    hooks: AdvisoryRaceHooks = {},
  ): Promise<PersistResult> {
    const result = await this.transaction(async (client) => {
      const backend = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      const backendPid = backend.rows[0]?.pid;
      if (typeof backendPid !== 'number' || !Number.isInteger(backendPid)) {
        throw new Error('Postgres did not return a backend PID');
      }
      await hooks.beforePersisterAdvisoryLock?.(backendPid);
      await this.lockReservation(client, payload.reservationId);
      const inserted = await client.query<{ id: string; status: DurableOrderStatus }>(
        `INSERT INTO orders (id,user_id,sale_id,status,created_at,persisted_at,request_id)
         VALUES ($1,$2,$3,'persisted',to_timestamp($4/1000.0),clock_timestamp(),$5)
         ON CONFLICT (user_id) DO NOTHING RETURNING id,status`,
        [
          payload.reservationId,
          payload.userId,
          payload.saleId,
          payload.reservedAtMs,
          payload.requestId,
        ],
      );
      if (inserted.rowCount === 1) return 'persisted';
      const current = await this.selectUserForUpdate(client, payload.userId);
      if (!current) throw new Error('order conflict produced no user row');
      if (current.id === payload.reservationId) {
        return current.status === 'persisted' ? 'idempotent' : 'compensated';
      }
      if (current.status === 'persisted') {
        throw new PersistenceConflictError(
          `permanent persistence conflict for user ${payload.userId}`,
        );
      }
      const ledger = await this.store.getReservation(payload.saleId, payload.userId);
      if (ledger?.reservationId !== payload.reservationId) {
        throw new Error(`current reservation identity mismatch for user ${payload.userId}`);
      }
      const updated = await client.query(
        `UPDATE orders SET id=$1,sale_id=$2,status='persisted',created_at=to_timestamp($3/1000.0),
           persisted_at=clock_timestamp(),request_id=$4
         WHERE user_id=$5 AND id=$6 AND status='compensated'`,
        [
          payload.reservationId,
          payload.saleId,
          payload.reservedAtMs,
          payload.requestId,
          payload.userId,
          current.id,
        ],
      );
      if (updated.rowCount !== 1)
        throw new Error('guarded compensated-order promotion affected unexpected row count');
      return 'persisted';
    });
    await hooks.afterPersisterCommit?.();
    return result;
  }

  async resolveFailed(
    payload: OrdersQueueJobPayload,
    compensate: () => Promise<CompensateResult>,
    hooks: AdvisoryRaceHooks = {},
  ): Promise<ResolveFailedResult> {
    let compensateAfterCommit = false;
    const result = await this.transaction(async (client): Promise<ResolveFailedResult> => {
      await this.lockReservation(client, payload.reservationId);
      const current = await this.selectUserForUpdate(client, payload.userId);
      if (current?.id === payload.reservationId && current.status === 'persisted')
        return 'persisted';
      if (current?.id === payload.reservationId && current.status === 'compensated') {
        compensateAfterCommit = true;
        return 'compensation_noop';
      }
      if (!current) await hooks.afterResolverAbsentRead?.();
      const compensation = await compensate();
      if (!['COMPENSATED', 'COMPENSATED_CAPPED', 'NOOP'].includes(compensation.outcome)) {
        throw new Error(`unexpected compensation outcome: ${String(compensation.outcome)}`);
      }
      if (!current) {
        await client.query(
          `INSERT INTO orders (id,user_id,sale_id,status,created_at,persisted_at,request_id)
           VALUES ($1,$2,$3,'compensated',to_timestamp($4/1000.0),NULL,$5)`,
          [
            payload.reservationId,
            payload.userId,
            payload.saleId,
            payload.reservedAtMs,
            payload.requestId,
          ],
        );
      } else if (current.status === 'compensated') {
        const updated = await client.query(
          `UPDATE orders SET id=$1,sale_id=$2,status='compensated',created_at=to_timestamp($3/1000.0),
             persisted_at=NULL,request_id=$4 WHERE user_id=$5 AND id=$6 AND status='compensated'`,
          [
            payload.reservationId,
            payload.saleId,
            payload.reservedAtMs,
            payload.requestId,
            payload.userId,
            current.id,
          ],
        );
        if (updated.rowCount !== 1)
          throw new Error('guarded compensation marker update affected unexpected row count');
      }
      return compensation.outcome === 'NOOP' ? 'compensation_noop' : 'compensated';
    });
    if (compensateAfterCommit) await compensate();
    return result;
  }

  async getByUser(userId: string): Promise<DurableOrder | null> {
    const result = await this.pool.query<OrderDbRow>(
      `SELECT id,user_id,sale_id,status,(extract(epoch from created_at)*1000)::bigint::text AS created_at_ms,request_id
       FROM orders WHERE user_id=$1`,
      [userId],
    );
    return result.rows[0] ? fromRow(result.rows[0]) : null;
  }

  async listSaleOrders(offset: number, limit: number): Promise<DurableOrder[]> {
    const result = await this.pool.query<OrderDbRow>(
      `SELECT id,user_id,sale_id,status,(extract(epoch from created_at)*1000)::bigint::text AS created_at_ms,request_id
       FROM orders WHERE sale_id=$1 ORDER BY user_id OFFSET $2 LIMIT $3`,
      [this.env.SALE_ID, offset, limit],
    );
    return result.rows.map(fromRow);
  }

  async withSessionReconciliationLock<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T> {
    const client = await this.pool.connect();
    let acquired = false;
    let value: T | undefined;
    let primaryError: unknown;
    const cleanupErrors: unknown[] = [];
    try {
      do {
        signal.throwIfAborted();
        const lock = await client.query<{ acquired: boolean }>(
          `SELECT pg_try_advisory_lock(
             hashtextextended('flash-reconcile:' || $1, 0)
           ) AS acquired`,
          [this.env.SALE_ID],
        );
        acquired = lock.rows[0]?.acquired === true;
        if (!acquired) await this.abortableDelay(RECONCILIATION_LOCK_POLL_MS, signal);
      } while (!acquired);
      signal.throwIfAborted();
      value = await work();
    } catch (error) {
      primaryError = error;
    } finally {
      if (acquired) {
        try {
          const unlock = await client.query<{ unlocked: boolean }>(
            `SELECT pg_advisory_unlock(
               hashtextextended('flash-reconcile:' || $1, 0)
             ) AS unlocked`,
            [this.env.SALE_ID],
          );
          if (unlock.rows[0]?.unlocked !== true) {
            cleanupErrors.push(new Error('Postgres reconciliation advisory lock was not released'));
          }
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
      try {
        client.release();
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (primaryError !== undefined && cleanupErrors.length > 0) {
      throw new AggregateError(
        [primaryError, ...cleanupErrors],
        'reconciliation work and session-lock cleanup failed',
      );
    }
    if (primaryError !== undefined) throw primaryError;
    if (cleanupErrors.length > 0) {
      throw new AggregateError(cleanupErrors, 'reconciliation session-lock cleanup failed');
    }
    return value as T;
  }

  private abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const onAbort = (): void => {
        clearTimeout(timer);
        reject(signal.reason);
      };
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      timer.unref?.();
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  private async lockReservation(client: PoolClient, reservationId: string): Promise<void> {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text,0))', [
      reservationId,
    ]);
  }

  private async selectUserForUpdate(
    client: PoolClient,
    userId: string,
  ): Promise<{ id: string; status: DurableOrderStatus } | null> {
    const result = await client.query<{ id: string; status: DurableOrderStatus }>(
      'SELECT id,status FROM orders WHERE user_id=$1 FOR UPDATE',
      [userId],
    );
    return result.rows[0] ?? null;
  }

  private async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        /* original/indeterminate error wins */
      }
      throw error;
    } finally {
      client.release();
    }
  }
}
