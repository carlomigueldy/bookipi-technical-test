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

import { envSchema, type WorkerEnv } from './env.schema.js';

export type { WorkerEnv };

export class EnvValidationError extends Error {
  constructor(readonly issues: readonly string[]) {
    super(
      `invalid environment configuration:\n${issues.map((issue) => `  - ${issue}`).join('\n')}`,
    );
    this.name = 'EnvValidationError';
  }
}

const PRODUCTION_REQUIRED = [
  'DATABASE_URL',
  'REDIS_URL',
  'SALE_ID',
  'SALE_NAME',
  'SALE_STARTS_AT',
  'SALE_ENDS_AT',
  'SALE_TOTAL_STOCK',
] as const;

export function parseWorkerEnv(source: NodeJS.ProcessEnv = process.env): WorkerEnv {
  if (source.NODE_ENV === 'production') {
    const missing = PRODUCTION_REQUIRED.filter(
      (key) => source[key]?.trim().length === 0 || source[key] === undefined,
    );
    if (missing.length > 0) {
      throw new EnvValidationError(
        missing.map((key) => `${key}: required explicitly in production`),
      );
    }
  }
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    throw new EnvValidationError(
      parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
    );
  }
  return parsed.data;
}

export const env = parseWorkerEnv();
