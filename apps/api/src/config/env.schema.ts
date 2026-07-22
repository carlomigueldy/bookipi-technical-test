/**
 * Environment zod schema for @flash/api — frozen contract §3.1/§3.2.
 *
 * Phase 0 §11 mandated plain `process.env` reads with no zod, no
 * `@nestjs/config`. Phase 2 §3.2 LIFTS that rule for `apps/api` only: env
 * values became security controls in this phase (a mistyped
 * `RATE_LIMIT_MAX=twenty` silently becoming `NaN` disables the limiter), so
 * every row is now zod-validated and parsed once, at module load, before
 * `NestFactory.create`.
 *
 * `@nestjs/config` is deliberately NOT used — it adds a DI-scoped
 * indirection over a value this file needs at bootstrap, before the DI
 * container exists (contract §3.2).
 *
 * Defaults preserve host development/test ergonomics. `parseApiEnv` performs
 * the production-only raw-presence check for CORS_ORIGIN, DATABASE_URL,
 * REDIS_URL, and SALE_ID before this schema applies those defaults.
 */
import { z } from 'zod';
import { assertSaleId } from '@flash/shared';

const NODE_ENVS = ['development', 'test', 'production'] as const;
const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace'] as const;

/**
 * `z.coerce.boolean()` is a trap here: `Boolean('false')` is `true`, so a
 * naive coerce would silently invert an explicit `TRUST_PROXY=false`. An
 * exact string enum + explicit transform is the only safe reading of a
 * `'true' | 'false'` env row.
 */
const booleanFromString = z.enum(['true', 'false']).transform((value) => value === 'true');

/**
 * `.default(n)` re-parses the DEFAULT value (a real number) through the
 * coerce/int/bound chain when the raw input is `undefined` — it never feeds
 * `undefined` itself into `Number(...)`, so this cannot produce a silent
 * `NaN` default. A *present* non-numeric value (e.g. `'twenty'`) still fails
 * `.int()` and is a fatal boot error, which is the property this schema
 * exists to guarantee.
 */
function positiveIntEnv(defaultValue: number) {
  return z.coerce.number().int().positive().default(defaultValue);
}

function nonNegativeIntEnv(defaultValue: number) {
  return z.coerce.number().int().nonnegative().default(defaultValue);
}

/**
 * Precision-agnostic ISO-8601 datetime, matching the same `z.iso.datetime()`
 * call already used (without extra options) for millisecond-precision
 * server-generated timestamps in `@flash/shared`'s DTOs
 * (`packages/shared/src/dto/sale-status.ts`). Kept as a bare call here too,
 * for the same reason: consistency with the one existing precedent in this
 * codebase, rather than inventing new options this schema would be the only
 * user of.
 */
const isoDateTimeEnv = z.iso.datetime();

export const envSchema = z
  .object({
    NODE_ENV: z.enum(NODE_ENVS).default('development'),
    LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),

    API_HOST: z.string().min(1).default('0.0.0.0'),
    API_PORT: positiveIntEnv(3000),

    CORS_ORIGIN: z.string().min(1).default('http://localhost:5173'),
    DATABASE_URL: z.string().min(1).default('postgresql://flash:flash@localhost:5433/flash'),
    REDIS_URL: z.string().min(1).default('redis://localhost:6380'),

    SALE_ID: z.string().min(1).default('flash-2026'),
    SALE_NAME: z.string().min(1).default('Aurora — Founders Edition'),
    SALE_STARTS_AT: isoDateTimeEnv.default('2026-07-22T12:00:00.000Z'),
    SALE_ENDS_AT: isoDateTimeEnv.default('2026-07-22T13:00:00.000Z'),
    SALE_TOTAL_STOCK: nonNegativeIntEnv(500),

    RATE_LIMIT_MAX: positiveIntEnv(20),
    RATE_LIMIT_WINDOW_MS: positiveIntEnv(1000),

    ORDERS_QUEUE_NAME: z.string().min(1).default('orders'),

    // Phase 2 additions — contract §3.1.
    TRUST_PROXY: booleanFromString.default(false),
    REQUEST_BODY_LIMIT_BYTES: positiveIntEnv(16384),
    RATE_LIMIT_USER_MAX: positiveIntEnv(5),
    RATE_LIMIT_USER_WINDOW_MS: positiveIntEnv(1000),
    CLOCK_SYNC_INTERVAL_MS: positiveIntEnv(5000),
    CLOCK_MAX_STALENESS_MS: positiveIntEnv(15000),
    CLOCK_GUARD_SKEW_MS: nonNegativeIntEnv(250),
    ENQUEUE_TIMEOUT_MS: positiveIntEnv(500),
    PG_POOL_MAX: positiveIntEnv(10),
    PG_STATEMENT_TIMEOUT_MS: positiveIntEnv(2000),
    POSTGRES_TEST_URL: z.string().default(''),
  })
  .superRefine((value, ctx) => {
    // SALE_ID is validated against @flash/shared's assertSaleId at boot
    // (contract §3.2) — the same guard `@flash/redis` uses internally, so
    // the API can never boot with a saleId that would corrupt the Redis
    // Cluster hash-tag key space.
    try {
      assertSaleId(value.SALE_ID);
    } catch (err) {
      ctx.addIssue({
        code: 'custom',
        path: ['SALE_ID'],
        message: err instanceof Error ? err.message : 'invalid SALE_ID',
      });
    }

    // "SALE_STARTS_AT / SALE_ENDS_AT must be parseable ISO-8601 with
    // endsAt > startsAt" (contract §3.2). Individual parseability is already
    // enforced by `isoDateTimeEnv`; this cross-field check is the one thing
    // a single-field schema cannot express.
    const startsAtMs = Date.parse(value.SALE_STARTS_AT);
    const endsAtMs = Date.parse(value.SALE_ENDS_AT);
    if (Number.isFinite(startsAtMs) && Number.isFinite(endsAtMs) && endsAtMs <= startsAtMs) {
      ctx.addIssue({
        code: 'custom',
        path: ['SALE_ENDS_AT'],
        message: `SALE_ENDS_AT (${value.SALE_ENDS_AT}) must be after SALE_STARTS_AT (${value.SALE_STARTS_AT})`,
      });
    }
  });

export type ApiEnv = z.infer<typeof envSchema>;
export type NodeEnv = ApiEnv['NODE_ENV'];
export type LogLevel = ApiEnv['LOG_LEVEL'];
