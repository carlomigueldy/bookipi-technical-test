// apps/api/src/sale/sale.service.ts
//
// SLICE B — .claude/contracts/phase-2.md §6.1-§6.3.
//
// Maps a live `SaleRedisStore.status()` snapshot to `GET /api/sale/status`'s frozen
// `SaleStatusResponse`, and `SaleRedisStore.readMetrics()` to `GET /api/sale/metrics`.
//
// Resolves Phase 1 open issue 3 (contract §6.2): `status.lua` returns
// `stockRemaining = -1` when the config hash survives but the stock key does not — the
// partial-AOF-replay case. That is data loss, not "sold out", so it is never rendered
// as a 200 with a clamped/negative stock. The combined guard below
// (`!snapshot.initialized || snapshot.stockRemaining < 0`) is written as the SINGLE
// condition the contract mandates, specifically so the "never seeded" and "data loss"
// branches cannot be fixed independently and drift apart — only the *log event* differs
// between them, never the HTTP outcome.
//
// This service never wraps `store.status()`/`store.readMetrics()` in a try/catch: a
// thrown ioredis error is not a business outcome (§8.1's "never synthesize an outcome
// from a Redis error" invariant, restated here at the read path) and is left to
// propagate to the global `HttpExceptionFilter`, which renders it 500 `INTERNAL`
// (§6.7's "anything else" row) — never 503, since 503 `NOT_INITIALIZED` here means
// specifically "Redis answered and the answer was unservable," not "Redis didn't
// answer."
import { Inject, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';

import type { SaleRedisStore } from '@flash/redis';
import { SALE_METRIC_FIELDS, type AttemptOutcome, type SaleMetricField } from '@flash/shared';
import type { SaleStatusResponse } from '@flash/shared/schemas';

import { API_ENV, SALE_REDIS_STORE } from '../common/tokens.js';
import type { ApiEnv } from '../config/env.js';

/** `GET /api/sale/metrics` response — PRD §5.1/§10, contract §6.3. Not a `@flash/shared`
 * DTO: the frozen schema entry point (§0.1) is closed for Phase 2 amendments, and this
 * shape is purely additive ops surface, not consumed by anything outside this app. */
export interface SaleMetricsResponse {
  saleId: string;
  metrics: Record<SaleMetricField, number>;
  serverTime: string;
  serverTimeMs: number;
}

const NOT_INITIALIZED_OUTCOME: { outcome: AttemptOutcome } = { outcome: 'NOT_INITIALIZED' };

@Injectable()
export class SaleService {
  private readonly logger = new Logger(SaleService.name);

  constructor(
    @Inject(SALE_REDIS_STORE) private readonly store: SaleRedisStore,
    @Inject(API_ENV) private readonly env: ApiEnv,
  ) {}

  /** Backs `GET /api/sale/status`. Live `store.status()` per request — never cached
   * (contract §6.1: a stale `stockRemaining`/`state` is the one thing users act on). */
  async getStatus(): Promise<SaleStatusResponse> {
    const snapshot = await this.store.status(this.env.SALE_ID);

    // Single combined condition (contract §6.2) — never split into two independent
    // `if`s, so the 503 branch cannot be satisfied for one case and silently missed
    // for the other.
    const notInitialized = !snapshot.initialized || snapshot.stockRemaining < 0;

    if (notInitialized) {
      if (snapshot.initialized) {
        // config hash present, stock key gone: partial data loss, not "nobody seeded".
        this.logger.error({
          event: 'sale.stock_key_missing',
          saleId: this.env.SALE_ID,
          configPresent: true,
        });
      } else {
        this.logger.warn({
          event: 'sale.not_initialized',
          saleId: this.env.SALE_ID,
        });
      }
      throw new ServiceUnavailableException(NOT_INITIALIZED_OUTCOME);
    }

    return {
      saleId: snapshot.saleId,
      name: snapshot.name,
      status: snapshot.state,
      startsAt: snapshot.startsAt,
      endsAt: snapshot.endsAt,
      startsAtMs: snapshot.startsAtMs,
      endsAtMs: snapshot.endsAtMs,
      totalStock: snapshot.totalStock,
      stockRemaining: snapshot.stockRemaining,
      serverTime: new Date(snapshot.serverTimeMs).toISOString(),
      serverTimeMs: snapshot.serverTimeMs,
    };
  }

  /** Backs `GET /api/sale/metrics` (contract §6.3). Absent fields default to `0` — the
   * hash starts empty and the SPA must never see `undefined`. `serverTimeMs` is the
   * pod's own anchored clock (`Clock.nowMs()`), not a Lua `TIME` read, per §5.1(a)'s
   * table: this route never reaches Lua. */
  async getMetrics(nowMs: number): Promise<SaleMetricsResponse> {
    const raw = await this.store.readMetrics(this.env.SALE_ID);

    const metrics = Object.fromEntries(
      SALE_METRIC_FIELDS.map((field) => [field, raw[field] ?? 0]),
    ) as Record<SaleMetricField, number>;

    return {
      saleId: this.env.SALE_ID,
      metrics,
      serverTime: new Date(nowMs).toISOString(),
      serverTimeMs: nowMs,
    };
  }
}
