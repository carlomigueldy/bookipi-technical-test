// apps/api/src/health/health.service.ts
//
// SLICE D — .claude/contracts/phase-2.md §9.
//
// Two questions, two methods. `getLiveness()` is Phase 0's frozen, I/O-free shape
// (§9.2), unchanged. `getReadiness()` runs the five §9.3 checks in parallel, each
// bounded by a shared budget, and folds them into `status: 'ok' | 'degraded'` using the
// EXACT subset the contract pins: `redis`, `clock`, and `sale` failing degrade the pod;
// `postgres` and `queue` failing are reported but never degrade it (PRD §3.5 tolerates a
// Postgres outage and the queue's ledger-based recovery, per §8.4, precisely so a queue
// hiccup must not drain every pod from the load balancer).
//
// Every check function below swallows its own errors and resolves to a safe, typed
// result — never throws — because a bug in one check must not take down the readiness
// probe itself. `Promise.allSettled` (contract §9.3) is layered on top as a second,
// defensive net.
import { Inject, Injectable, Optional } from '@nestjs/common';
import type { Pool, QueryConfig } from 'pg';

import type { SaleRedisStore } from '@flash/redis';
import type { HealthStatus, ServiceName } from '@flash/shared';

import { API_ENV, CLOCK, PG_POOL, QUEUE_DEPTH_PROBE, SALE_REDIS_STORE } from '../common/tokens.js';
import type { ApiEnv } from '../config/env.js';
import type { Clock } from '../infra/clock.service.js';
import type { QueueDepthProbe } from '../infra/queue-depth-probe.js';

const SERVICE_VERSION = '0.0.0';
const SERVICE_NAME: ServiceName = 'api';

/** Overall check budget (contract §9.3: "1s overall budget"). Not env-configurable —
 * it is a fixed property of the readiness contract, not a per-deployment tuning knob.
 * Overridable only by the constructor's optional 4th argument, for test determinism. */
const DEFAULT_READINESS_BUDGET_MS = 1000;
const POSTGRES_QUERY_TIMEOUT_MS = 750;
// `pg` 8.x reads `query_timeout` from each query config at runtime, but
// `@types/pg` exposes it only on ClientConfig. Keep the runtime-supported field
// explicit without widening any shared/pool-wide configuration.
const POSTGRES_READINESS_QUERY: QueryConfig & { query_timeout: number } = {
  text: 'SELECT 1',
  query_timeout: POSTGRES_QUERY_TIMEOUT_MS,
};

export interface RedisCheck {
  ok: boolean;
  latencyMs: number | null;
}

export interface PostgresCheck {
  ok: boolean;
  latencyMs: number | null;
}

export interface ClockCheck {
  ok: boolean;
  offsetMs: number;
  rttMs: number;
  ageMs: number;
}

export interface SaleCheck {
  ok: boolean;
  initialized: boolean;
  stockKeyPresent: boolean;
}

export interface QueueCheck {
  ok: boolean;
  waiting: number;
  active: number;
  delayed: number;
  failed: number;
}

export interface ReadinessChecks {
  redis: RedisCheck;
  postgres: PostgresCheck;
  clock: ClockCheck;
  sale: SaleCheck;
  queue: QueueCheck;
}

export interface LivenessBody {
  status: HealthStatus;
  service: ServiceName;
  version: string;
  uptimeSeconds: number;
}

export interface ReadinessBody extends LivenessBody {
  checks: ReadinessChecks;
  requestId: string;
  serverTime: string;
  serverTimeMs: number;
}

export interface ReadinessResult {
  healthy: boolean;
  body: ReadinessBody;
}

const TIMED_OUT_REDIS: RedisCheck = { ok: false, latencyMs: null };
const TIMED_OUT_POSTGRES: PostgresCheck = { ok: false, latencyMs: null };
const TIMED_OUT_SALE: SaleCheck = { ok: false, initialized: false, stockKeyPresent: false };
const TIMED_OUT_QUEUE: QueueCheck = { ok: false, waiting: 0, active: 0, delayed: 0, failed: 0 };

@Injectable()
export class HealthService {
  constructor(
    @Inject(SALE_REDIS_STORE) private readonly store: SaleRedisStore,
    @Inject(PG_POOL) private readonly pgPool: Pool,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(API_ENV) private readonly env: ApiEnv,
    @Inject(QUEUE_DEPTH_PROBE) private readonly queueDepthProbe: QueueDepthProbe,
    // `@Optional()` is required here: a bare `number` parameter type has no DI token
    // Nest can resolve, so without it Nest throws UnknownDependenciesException at
    // bootstrap. `@Optional()` makes Nest inject `undefined` when nothing is bound to
    // it, which is exactly what lets the default value below apply — this argument
    // exists solely so tests can inject a tiny budget; production wiring never passes
    // a 6th constructor arg for this token.
    @Optional() private readonly readinessBudgetMs: number = DEFAULT_READINESS_BUDGET_MS,
  ) {}

  /** `GET /api/health` — contract §9.2. No network I/O; always the frozen Phase 0
   * shape. */
  getLiveness(): LivenessBody {
    return {
      status: 'ok',
      service: SERVICE_NAME,
      version: SERVICE_VERSION,
      uptimeSeconds: process.uptime(),
    };
  }

  /** `GET /api/health/ready` — contract §9.3. `requestId` is threaded in by the
   * controller (Fastify's own `request.id`), never derived here. */
  async getReadiness(requestId: string): Promise<ReadinessResult> {
    const [redisSettled, postgresSettled, clockSettled, saleSettled, queueSettled] =
      await Promise.allSettled([
        this.withBudget(this.checkRedis(), TIMED_OUT_REDIS),
        this.withBudget(this.checkPostgres(), TIMED_OUT_POSTGRES),
        Promise.resolve(this.checkClock()),
        this.withBudget(this.checkSale(), TIMED_OUT_SALE),
        this.withBudget(this.checkQueue(), TIMED_OUT_QUEUE),
      ]);

    const checks: ReadinessChecks = {
      redis: this.settledOrDefault(redisSettled, TIMED_OUT_REDIS),
      postgres: this.settledOrDefault(postgresSettled, TIMED_OUT_POSTGRES),
      clock: this.settledOrDefault(clockSettled, {
        ok: false,
        offsetMs: 0,
        rttMs: 0,
        ageMs: Number.POSITIVE_INFINITY,
      }),
      sale: this.settledOrDefault(saleSettled, TIMED_OUT_SALE),
      queue: this.settledOrDefault(queueSettled, TIMED_OUT_QUEUE),
    };

    // Exhaustive per contract §9.3's table: only redis/clock/sale degrade the pod.
    const healthy = checks.redis.ok && checks.clock.ok && checks.sale.ok;
    const serverTimeMs = this.clock.nowMs();

    return {
      healthy,
      body: {
        status: healthy ? 'ok' : 'degraded',
        service: SERVICE_NAME,
        version: SERVICE_VERSION,
        uptimeSeconds: process.uptime(),
        checks,
        requestId,
        serverTime: new Date(serverTimeMs).toISOString(),
        serverTimeMs,
      },
    };
  }

  private async withBudget<T>(promise: Promise<T>, fallback: T): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<T>((resolve) => {
      timer = setTimeout(() => resolve(fallback), this.readinessBudgetMs);
    });
    try {
      return await Promise.race([promise, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  private settledOrDefault<T>(settled: PromiseSettledResult<T>, fallback: T): T {
    return settled.status === 'fulfilled' ? settled.value : fallback;
  }

  private async checkRedis(): Promise<RedisCheck> {
    const start = Date.now();
    try {
      const ok = await this.store.ping();
      return { ok, latencyMs: Date.now() - start };
    } catch {
      return { ok: false, latencyMs: Date.now() - start };
    }
  }

  private async checkPostgres(): Promise<PostgresCheck> {
    const start = Date.now();
    try {
      await this.pgPool.query(POSTGRES_READINESS_QUERY);
      return { ok: true, latencyMs: Date.now() - start };
    } catch {
      return { ok: false, latencyMs: Date.now() - start };
    }
  }

  private checkClock(): ClockCheck {
    return {
      ok: this.clock.isFresh(),
      offsetMs: this.clock.offsetMs(),
      rttMs: this.clock.rttMs(),
      ageMs: this.clock.ageMs(),
    };
  }

  /** Uses the identical §6.2 combined condition SaleService uses for the 503 branch —
   * `!initialized || stockRemaining < 0` — so "is the sale servable" can never drift
   * between the two endpoints that both ask it. */
  private async checkSale(): Promise<SaleCheck> {
    try {
      const snapshot = await this.store.status(this.env.SALE_ID);
      const stockKeyPresent = snapshot.initialized && snapshot.stockRemaining >= 0;
      return {
        ok: stockKeyPresent,
        initialized: snapshot.initialized,
        stockKeyPresent,
      };
    } catch {
      return { ok: false, initialized: false, stockKeyPresent: false };
    }
  }

  private async checkQueue(): Promise<QueueCheck> {
    try {
      const depth = await this.queueDepthProbe.depth();
      return { ok: true, ...depth };
    } catch {
      return { ok: false, waiting: 0, active: 0, delayed: 0, failed: 0 };
    }
  }
}
