/**
 * Environment contract for @flash/worker — frozen contract §11.
 *
 * Declares and defaults every row of the frozen env table that this service
 * reads, across all phases, so the seam is real from day one. Phase 0 code
 * only *uses* the Phase-0 rows (NODE_ENV, LOG_LEVEL, WORKER_HEALTH_PORT);
 * the rest exist here already for Phase 1+ (Redis/BullMQ wiring) to consume
 * without touching this file's shape.
 *
 * Plain `process.env` reads with `Number()`/defaults — no zod, no
 * `@nestjs/config` in Phase 0 (contract §11 Phase-0 rule).
 */

export type NodeEnv = 'development' | 'test' | 'production';
export type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';

export interface WorkerEnv {
  NODE_ENV: NodeEnv;
  LOG_LEVEL: LogLevel;
  WORKER_HEALTH_PORT: number;
  DATABASE_URL: string;
  REDIS_URL: string;
  SALE_ID: string;
  ORDERS_QUEUE_NAME: string;
  WORKER_CONCURRENCY: number;
  WORKER_MAX_ATTEMPTS: number;
}

export const env: WorkerEnv = {
  NODE_ENV: (process.env.NODE_ENV as NodeEnv | undefined) ?? 'development',
  LOG_LEVEL: (process.env.LOG_LEVEL as LogLevel | undefined) ?? 'info',
  WORKER_HEALTH_PORT: Number(process.env.WORKER_HEALTH_PORT ?? 3001),
  DATABASE_URL: process.env.DATABASE_URL ?? 'postgresql://flash:flash@localhost:5433/flash',
  REDIS_URL: process.env.REDIS_URL ?? 'redis://localhost:6380',
  SALE_ID: process.env.SALE_ID ?? 'flash-2026',
  ORDERS_QUEUE_NAME: process.env.ORDERS_QUEUE_NAME ?? 'orders',
  WORKER_CONCURRENCY: Number(process.env.WORKER_CONCURRENCY ?? 16),
  WORKER_MAX_ATTEMPTS: Number(process.env.WORKER_MAX_ATTEMPTS ?? 5),
};
