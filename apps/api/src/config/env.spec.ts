import { describe, expect, it } from 'vitest';
import { EnvValidationError, parseApiEnv } from './env.js';

/** A full, valid env object — every row Phase 0 + Phase 2 (§3.1) added. */
const VALID_ENV: NodeJS.ProcessEnv = {
  NODE_ENV: 'production',
  LOG_LEVEL: 'info',
  API_HOST: '0.0.0.0',
  API_PORT: '3000',
  CORS_ORIGIN: 'https://flash.example.com',
  DATABASE_URL: 'postgresql://flash:flash@localhost:5433/flash',
  REDIS_URL: 'redis://localhost:6380',
  SALE_ID: 'flash-2026',
  SALE_NAME: 'Aurora — Founders Edition',
  SALE_STARTS_AT: '2026-07-22T12:00:00.000Z',
  SALE_ENDS_AT: '2026-07-22T13:00:00.000Z',
  SALE_TOTAL_STOCK: '500',
  RATE_LIMIT_MAX: '20',
  RATE_LIMIT_WINDOW_MS: '1000',
  ORDERS_QUEUE_NAME: 'orders',
  TRUST_PROXY: 'false',
  REQUEST_BODY_LIMIT_BYTES: '16384',
  RATE_LIMIT_USER_MAX: '5',
  RATE_LIMIT_USER_WINDOW_MS: '1000',
  CLOCK_SYNC_INTERVAL_MS: '5000',
  CLOCK_MAX_STALENESS_MS: '15000',
  CLOCK_GUARD_SKEW_MS: '250',
  ENQUEUE_TIMEOUT_MS: '500',
  PG_POOL_MAX: '10',
  PG_STATEMENT_TIMEOUT_MS: '2000',
  POSTGRES_TEST_URL: '',
};

describe('parseApiEnv', () => {
  it('parses a fully-populated, valid env into the exact typed ApiEnv shape', () => {
    const env = parseApiEnv(VALID_ENV);
    expect(env.NODE_ENV).toBe('production');
    expect(env.API_PORT).toBe(3000);
    expect(env.SALE_TOTAL_STOCK).toBe(500);
    expect(env.TRUST_PROXY).toBe(false);
    expect(env.RATE_LIMIT_USER_MAX).toBe(5);
    expect(env.CLOCK_GUARD_SKEW_MS).toBe(250);
    expect(env.ENQUEUE_TIMEOUT_MS).toBe(500);
    expect(env.PG_STATEMENT_TIMEOUT_MS).toBe(2000);
  });

  it('applies host-dev defaults for every row when given an empty environment', () => {
    const env = parseApiEnv({});
    expect(env.NODE_ENV).toBe('development');
    expect(env.LOG_LEVEL).toBe('info');
    expect(env.API_PORT).toBe(3000);
    expect(env.TRUST_PROXY).toBe(false);
    expect(env.REQUEST_BODY_LIMIT_BYTES).toBe(16384);
    expect(env.RATE_LIMIT_USER_MAX).toBe(5);
    expect(env.RATE_LIMIT_USER_WINDOW_MS).toBe(1000);
    expect(env.CLOCK_SYNC_INTERVAL_MS).toBe(5000);
    expect(env.CLOCK_MAX_STALENESS_MS).toBe(15000);
    expect(env.CLOCK_GUARD_SKEW_MS).toBe(250);
    expect(env.ENQUEUE_TIMEOUT_MS).toBe(500);
    expect(env.PG_POOL_MAX).toBe(10);
    expect(env.PG_STATEMENT_TIMEOUT_MS).toBe(2000);
    expect(env.POSTGRES_TEST_URL).toBe('');
  });

  it.each(['development', 'test'] as const)(
    'retains localhost defaults when operational fields are omitted in %s',
    (nodeEnv) => {
      const parsed = parseApiEnv({ NODE_ENV: nodeEnv });
      expect(parsed.CORS_ORIGIN).toBe('http://localhost:5173');
      expect(parsed.DATABASE_URL).toBe('postgresql://flash:flash@localhost:5433/flash');
      expect(parsed.REDIS_URL).toBe('redis://localhost:6380');
      expect(parsed.SALE_ID).toBe('flash-2026');
    },
  );

  it.each(['CORS_ORIGIN', 'DATABASE_URL', 'REDIS_URL', 'SALE_ID'] as const)(
    'requires raw %s presence in production before defaults are applied',
    (field) => {
      const source = { ...VALID_ENV };
      delete source[field];

      expect(() => parseApiEnv(source)).toThrowError(
        expect.objectContaining<Partial<EnvValidationError>>({
          issues: [`${field}: required explicitly in production`],
        }),
      );
    },
  );

  it('lists every missing production-required field in one error', () => {
    const source = { ...VALID_ENV };
    for (const field of ['CORS_ORIGIN', 'DATABASE_URL', 'REDIS_URL', 'SALE_ID'] as const) {
      delete source[field];
    }

    expect(() => parseApiEnv(source)).toThrowError(
      expect.objectContaining<Partial<EnvValidationError>>({
        issues: [
          'CORS_ORIGIN: required explicitly in production',
          'DATABASE_URL: required explicitly in production',
          'REDIS_URL: required explicitly in production',
          'SALE_ID: required explicitly in production',
        ],
      }),
    );
  });

  it.each(['CORS_ORIGIN', 'DATABASE_URL', 'REDIS_URL', 'SALE_ID'] as const)(
    'rejects an empty production %s value as missing',
    (field) => {
      expect(() => parseApiEnv({ ...VALID_ENV, [field]: '' })).toThrowError(
        expect.objectContaining<Partial<EnvValidationError>>({
          issues: [`${field}: required explicitly in production`],
        }),
      );
    },
  );

  it('parses explicit production operational values', () => {
    const parsed = parseApiEnv(VALID_ENV);
    expect(parsed).toMatchObject({
      NODE_ENV: 'production',
      CORS_ORIGIN: VALID_ENV.CORS_ORIGIN,
      DATABASE_URL: VALID_ENV.DATABASE_URL,
      REDIS_URL: VALID_ENV.REDIS_URL,
      SALE_ID: VALID_ENV.SALE_ID,
    });
  });

  it('correctly coerces TRUST_PROXY="true" to boolean true (not the Boolean("false")===true trap)', () => {
    expect(parseApiEnv({ ...VALID_ENV, TRUST_PROXY: 'true' }).TRUST_PROXY).toBe(true);
    expect(parseApiEnv({ ...VALID_ENV, TRUST_PROXY: 'false' }).TRUST_PROXY).toBe(false);
  });

  it('rejects an invalid NODE_ENV', () => {
    expect(() => parseApiEnv({ ...VALID_ENV, NODE_ENV: 'staging' })).toThrow(EnvValidationError);
  });

  it('rejects a non-numeric RATE_LIMIT_MAX rather than silently coercing to NaN', () => {
    try {
      parseApiEnv({ ...VALID_ENV, RATE_LIMIT_MAX: 'twenty' });
      throw new Error('expected parseApiEnv to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(EnvValidationError);
      expect((err as EnvValidationError).issues.some((i) => i.includes('RATE_LIMIT_MAX'))).toBe(
        true,
      );
    }
  });

  it('rejects TRUST_PROXY values other than the exact strings "true"/"false"', () => {
    expect(() => parseApiEnv({ ...VALID_ENV, TRUST_PROXY: 'TRUE' })).toThrow(EnvValidationError);
    expect(() => parseApiEnv({ ...VALID_ENV, TRUST_PROXY: 'yes' })).toThrow(EnvValidationError);
  });

  it('rejects an invalid SALE_ID (uppercase / braces) via assertSaleId, naming the field', () => {
    try {
      parseApiEnv({ ...VALID_ENV, SALE_ID: 'Flash{2026}' });
      throw new Error('expected parseApiEnv to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(EnvValidationError);
      expect((err as EnvValidationError).issues.some((i) => i.startsWith('SALE_ID:'))).toBe(true);
    }
  });

  it('rejects a malformed SALE_STARTS_AT', () => {
    expect(() => parseApiEnv({ ...VALID_ENV, SALE_STARTS_AT: 'not-a-date' })).toThrow(
      EnvValidationError,
    );
  });

  it('rejects SALE_ENDS_AT <= SALE_STARTS_AT, naming SALE_ENDS_AT', () => {
    try {
      parseApiEnv({
        ...VALID_ENV,
        SALE_STARTS_AT: '2026-07-22T13:00:00.000Z',
        SALE_ENDS_AT: '2026-07-22T12:00:00.000Z',
      });
      throw new Error('expected parseApiEnv to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(EnvValidationError);
      expect((err as EnvValidationError).issues.some((i) => i.startsWith('SALE_ENDS_AT:'))).toBe(
        true,
      );
    }
  });

  it('rejects SALE_ENDS_AT === SALE_STARTS_AT (a zero-length window)', () => {
    expect(() =>
      parseApiEnv({
        ...VALID_ENV,
        SALE_STARTS_AT: VALID_ENV.SALE_ENDS_AT,
        SALE_ENDS_AT: VALID_ENV.SALE_ENDS_AT,
      }),
    ).toThrow(EnvValidationError);
  });

  it('the printed field list surfaces every invalid field at once, not just the first', () => {
    try {
      parseApiEnv({ ...VALID_ENV, RATE_LIMIT_MAX: 'nope', NODE_ENV: 'bogus', TRUST_PROXY: 'nope' });
      throw new Error('expected parseApiEnv to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(EnvValidationError);
      const issues = (err as EnvValidationError).issues;
      expect(issues.length).toBeGreaterThanOrEqual(3);
    }
  });

  it('EnvValidationError.message contains every field name for operator readability', () => {
    try {
      parseApiEnv({ ...VALID_ENV, RATE_LIMIT_MAX: 'nope' });
      throw new Error('expected parseApiEnv to throw');
    } catch (err) {
      expect((err as EnvValidationError).message).toContain('RATE_LIMIT_MAX');
    }
  });
});
