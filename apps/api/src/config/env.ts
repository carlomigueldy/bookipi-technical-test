/**
 * Environment contract for @flash/api — frozen contract §11.
 *
 * Declares and defaults every row of the frozen env table that this service
 * reads, across all phases, so the seam is real from day one. Phase 0 code
 * only *uses* the Phase-0 rows (NODE_ENV, LOG_LEVEL, API_HOST, API_PORT);
 * the rest exist here already for Phase 1+ to consume without touching this
 * file's shape.
 *
 * Plain `process.env` reads with `Number()`/defaults — no zod, no
 * `@nestjs/config` in Phase 0 (contract §11 Phase-0 rule).
 */

export type NodeEnv = 'development' | 'test' | 'production';
export type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';

export interface ApiEnv {
  NODE_ENV: NodeEnv;
  LOG_LEVEL: LogLevel;
  API_HOST: string;
  API_PORT: number;
  CORS_ORIGIN: string;
  DATABASE_URL: string;
  REDIS_URL: string;
  SALE_ID: string;
  SALE_NAME: string;
  SALE_STARTS_AT: string;
  SALE_ENDS_AT: string;
  SALE_TOTAL_STOCK: number;
  RATE_LIMIT_MAX: number;
  RATE_LIMIT_WINDOW_MS: number;
  ORDERS_QUEUE_NAME: string;
}

export const env: ApiEnv = {
  NODE_ENV: (process.env.NODE_ENV as NodeEnv | undefined) ?? 'development',
  LOG_LEVEL: (process.env.LOG_LEVEL as LogLevel | undefined) ?? 'info',
  API_HOST: process.env.API_HOST ?? '0.0.0.0',
  API_PORT: Number(process.env.API_PORT ?? 3000),
  CORS_ORIGIN: process.env.CORS_ORIGIN ?? 'http://localhost:5173',
  DATABASE_URL: process.env.DATABASE_URL ?? 'postgresql://flash:flash@localhost:5433/flash',
  REDIS_URL: process.env.REDIS_URL ?? 'redis://localhost:6380',
  SALE_ID: process.env.SALE_ID ?? 'flash-2026',
  SALE_NAME: process.env.SALE_NAME ?? 'Aurora — Founders Edition',
  SALE_STARTS_AT: process.env.SALE_STARTS_AT ?? '2026-07-22T12:00:00.000Z',
  SALE_ENDS_AT: process.env.SALE_ENDS_AT ?? '2026-07-22T13:00:00.000Z',
  SALE_TOTAL_STOCK: Number(process.env.SALE_TOTAL_STOCK ?? 500),
  RATE_LIMIT_MAX: Number(process.env.RATE_LIMIT_MAX ?? 20),
  RATE_LIMIT_WINDOW_MS: Number(process.env.RATE_LIMIT_WINDOW_MS ?? 1000),
  ORDERS_QUEUE_NAME: process.env.ORDERS_QUEUE_NAME ?? 'orders',
};
