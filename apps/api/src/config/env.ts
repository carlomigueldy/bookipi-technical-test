/**
 * Environment contract for @flash/api — frozen contract §3.2.
 *
 * Parses `process.env` ONCE, at module load, before `NestFactory.create` —
 * every other module that needs an env value imports `env` from here (or
 * injects the `API_ENV` DI token, which is `useValue: env`). An invalid or
 * missing-and-malformed value is a FATAL boot error with a printed field
 * list, never a silent `NaN`/`undefined` default reaching a security control
 * (contract §3.2's rationale, restated in `env.schema.ts`'s header comment).
 *
 * `parseApiEnv` is exported separately from the `env` singleton so it is
 * testable as a pure function — `env.spec.ts` never touches `process.exit`.
 */
import { envSchema, type ApiEnv, type LogLevel, type NodeEnv } from './env.schema.js';

export type { ApiEnv, LogLevel, NodeEnv };

export class EnvValidationError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`invalid environment configuration:\n${issues.map((i) => `  - ${i}`).join('\n')}`);
    this.name = 'EnvValidationError';
    this.issues = issues;
  }
}

const PRODUCTION_REQUIRED_FIELDS = ['CORS_ORIGIN', 'DATABASE_URL', 'REDIS_URL', 'SALE_ID'] as const;

/** Pure — throws `EnvValidationError` on failure, never touches `process.exit`. */
export function parseApiEnv(source: NodeJS.ProcessEnv = process.env): ApiEnv {
  if (source.NODE_ENV === 'production') {
    const missing = PRODUCTION_REQUIRED_FIELDS.filter((field) => {
      const value = source[field];
      return value === undefined || value.trim().length === 0;
    });
    if (missing.length > 0) {
      throw new EnvValidationError(
        missing.map((field) => `${field}: required explicitly in production`),
      );
    }
  }

  const result = envSchema.safeParse(source);
  if (!result.success) {
    const issues = result.error.issues.map(
      (issue) => `${issue.path.length > 0 ? issue.path.join('.') : '(root)'}: ${issue.message}`,
    );
    throw new EnvValidationError(issues);
  }
  return result.data;
}

/**
 * The only place `process.exit` is called in this file. Kept as a tiny,
 * separate function (rather than inlined into the top-level `const env =`)
 * so `parseApiEnv`'s pure validation logic stays independently testable.
 */
function loadEnvOrExit(): ApiEnv {
  try {
    return parseApiEnv(process.env);
  } catch (err) {
    if (!(err instanceof EnvValidationError)) throw err;
    console.error(`\nFatal: @flash/api ${err.message}\n`);
    return process.exit(1);
  }
}

export const env: ApiEnv = loadEnvOrExit();
