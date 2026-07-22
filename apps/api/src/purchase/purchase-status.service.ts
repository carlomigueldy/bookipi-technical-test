// apps/api/src/purchase/purchase-status.service.ts  [SLICE C — frozen contract §8.2]
//
// Backs `GET /api/purchase/:userId`. The ONLY route in `apps/api/src/purchase/**` that
// touches Postgres — `POST /api/purchase` (purchase.service.ts) never does (a reviewer
// greps `PG_POOL` under that one file and must find zero hits; see the §12 gate).
//
// Source precedence, pinned: Postgres first (the durable record; the only place that
// knows `createdAt` and can report `compensated`), Redis fallback (covers the window
// between a CONFIRMED reservation and the async Postgres write landing). Degradation is
// asymmetric and deliberate:
//   - Postgres unreachable -> NOT a 503. Fall through to Redis and answer
//     reserved/false. Redis is authoritative for "did I get one"; refusing to answer
//     when we CAN answer is strictly worse.
//   - Redis unreachable (and no PG row) -> 503 UPSTREAM_UNAVAILABLE. We genuinely do
//     not know.
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Pool } from 'pg';

import type { SaleRedisStore } from '@flash/redis';
import type { OrderStatus } from '@flash/shared';
import type { PurchaseStatusResponse } from '@flash/shared/schemas';

import type { ApiErrorResponse } from '../common/dto/api-error.js';
import { messageFor } from '../common/messages.js';
import { API_ENV, CLOCK, PG_POOL, SALE_REDIS_STORE } from '../common/tokens.js';
import type { ApiEnv } from '../config/env.js';
import type { Clock } from '../infra/clock.service.js';

interface OrderRow {
  status: OrderStatus;
  created_at: Date;
}

export interface PurchaseStatusOk {
  httpStatus: 200;
  body: PurchaseStatusResponse;
}

export interface PurchaseStatusUnavailable {
  httpStatus: 503;
  body: ApiErrorResponse;
}

export type PurchaseStatusOutcome = PurchaseStatusOk | PurchaseStatusUnavailable;

@Injectable()
export class PurchaseStatusService {
  private readonly logger = new Logger(PurchaseStatusService.name);

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(SALE_REDIS_STORE) private readonly store: SaleRedisStore,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(API_ENV) private readonly env: ApiEnv,
  ) {}

  async getStatus(userId: string, requestId: string): Promise<PurchaseStatusOutcome> {
    const saleId = this.env.SALE_ID;

    const row = await this.readPersistedOrder(saleId, userId);
    if (row) {
      const purchased = row.status === 'persisted';
      const nowMs = this.clock.nowMs();
      return {
        httpStatus: 200,
        body: {
          userId,
          saleId,
          purchased,
          order: { status: row.status, createdAt: row.created_at.toISOString() },
          serverTime: new Date(nowMs).toISOString(),
          serverTimeMs: nowMs,
        },
      };
    }

    // No PG row — either genuinely absent, or PG was unreachable (readPersistedOrder
    // already logged that case and returned null rather than throwing). Either way,
    // Redis is the next and only remaining source of truth.
    try {
      const inRedis = await this.store.hasPurchased(saleId, userId);
      const nowMs = this.clock.nowMs();
      return {
        httpStatus: 200,
        body: {
          userId,
          saleId,
          purchased: inRedis,
          order: inRedis ? { status: 'reserved', createdAt: null } : null,
          serverTime: new Date(nowMs).toISOString(),
          serverTimeMs: nowMs,
        },
      };
    } catch (err) {
      this.logger.error(
        { err: err instanceof Error ? err.message : String(err), saleId, userId, requestId },
        'purchase_status.redis_unavailable',
      );
      const nowMs = this.clock.nowMs();
      return {
        httpStatus: 503,
        body: {
          error: 'UPSTREAM_UNAVAILABLE',
          message: messageFor('UPSTREAM_UNAVAILABLE'),
          requestId,
          serverTime: new Date(nowMs).toISOString(),
          serverTimeMs: nowMs,
        },
      };
    }
  }

  /** Returns `null` both when no row exists AND when Postgres itself is unreachable — the caller cannot and must not distinguish the two (both fall through to Redis). */
  private async readPersistedOrder(saleId: string, userId: string): Promise<OrderRow | null> {
    try {
      const result = await this.pool.query<OrderRow>(
        'SELECT status, created_at FROM orders WHERE user_id = $1',
        [userId],
      );
      return result.rows[0] ?? null;
    } catch (err) {
      this.logger.warn(
        { err: err instanceof Error ? err.message : String(err), saleId, userId },
        'purchase_status.pg_unavailable',
      );
      return null;
    }
  }
}
