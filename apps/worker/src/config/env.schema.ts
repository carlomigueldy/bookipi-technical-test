import { assertSaleId, ORDERS_JOB_ATTEMPTS } from '@flash/shared';
import { z } from 'zod';

const int = (minimum: number, maximum: number, fallback: number) =>
  z.coerce.number().int().min(minimum).max(maximum).default(fallback);

export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
    WORKER_HEALTH_PORT: int(1, 65535, 3001),
    DATABASE_URL: z.url().default('postgresql://flash:flash@localhost:5433/flash'),
    REDIS_URL: z.url().default('redis://localhost:6380'),
    SALE_ID: z.string().min(1).default('flash-2026'),
    SALE_NAME: z.string().min(1).default('Aurora — Founders Edition'),
    SALE_STARTS_AT: z.iso.datetime().default('2026-07-22T12:00:00.000Z'),
    SALE_ENDS_AT: z.iso.datetime().default('2026-07-22T13:00:00.000Z'),
    SALE_TOTAL_STOCK: int(0, Number.MAX_SAFE_INTEGER, 500),
    ORDERS_QUEUE_NAME: z.string().min(1).default('orders'),
    WORKER_CONCURRENCY: int(1, 128, 16),
    WORKER_MAX_ATTEMPTS: int(1, 100, ORDERS_JOB_ATTEMPTS),
    WORKER_PG_POOL_MAX: int(2, 100, 10),
    WORKER_PG_STATEMENT_TIMEOUT_MS: int(100, 30000, 2000),
    WORKER_RECONCILE_INTERVAL_MS: int(250, 60000, 2000),
    WORKER_RECONCILE_SCAN_COUNT: int(10, 1000, 200),
    WORKER_DLQ_SWEEP_INTERVAL_MS: int(250, 60000, 1000),
    WORKER_DLQ_SCAN_COUNT: int(10, 1000, 100),
    REDIS_TEST_URL: z.string().default(''),
    POSTGRES_TEST_URL: z.string().default(''),
  })
  .superRefine((value, context) => {
    try {
      assertSaleId(value.SALE_ID);
    } catch (error) {
      context.addIssue({
        code: 'custom',
        path: ['SALE_ID'],
        message: error instanceof Error ? error.message : 'invalid sale id',
      });
    }
    if (Date.parse(value.SALE_ENDS_AT) <= Date.parse(value.SALE_STARTS_AT)) {
      context.addIssue({
        code: 'custom',
        path: ['SALE_ENDS_AT'],
        message: 'must be after SALE_STARTS_AT',
      });
    }
    if (value.WORKER_MAX_ATTEMPTS !== ORDERS_JOB_ATTEMPTS) {
      context.addIssue({
        code: 'custom',
        path: ['WORKER_MAX_ATTEMPTS'],
        message: `must equal ${ORDERS_JOB_ATTEMPTS}`,
      });
    }
  });

export type WorkerEnv = z.infer<typeof envSchema>;
