import { describe, expect, it } from 'vitest';
import { EnvValidationError, parseWorkerEnv } from './env.js';

describe('parseWorkerEnv', () => {
  it('applies the development defaults', () => {
    const parsed = parseWorkerEnv({});
    expect(parsed.WORKER_CONCURRENCY).toBe(16);
    expect(parsed.WORKER_RECONCILE_SCAN_COUNT).toBe(200);
    expect(parsed.WORKER_MAX_ATTEMPTS).toBe(5);
    expect(parsed.WORKER_PG_POOL_MAX).toBe(10);
  });

  it('requires every sale and datastore value explicitly in production', () => {
    expect(() => parseWorkerEnv({ NODE_ENV: 'production' })).toThrow(EnvValidationError);
  });

  it('rejects invalid windows, bounds, sale ids, and attempt drift', () => {
    expect(() => parseWorkerEnv({ SALE_ENDS_AT: '2026-07-22T11:00:00.000Z' })).toThrow();
    expect(() => parseWorkerEnv({ WORKER_CONCURRENCY: '129' })).toThrow();
    expect(() => parseWorkerEnv({ SALE_ID: 'bad{id}' })).toThrow();
    expect(() => parseWorkerEnv({ WORKER_MAX_ATTEMPTS: '4' })).toThrow();
  });

  it.each(['1', '0', '-1', '2.5', 'not-a-number', '101'])(
    'rejects WORKER_PG_POOL_MAX=%s',
    (value) => {
      expect(() => parseWorkerEnv({ WORKER_PG_POOL_MAX: value })).toThrow(EnvValidationError);
    },
  );

  it.each([
    ['2', 2],
    ['100', 100],
  ])('accepts WORKER_PG_POOL_MAX=%s unchanged', (value, expected) => {
    expect(parseWorkerEnv({ WORKER_PG_POOL_MAX: value }).WORKER_PG_POOL_MAX).toBe(expected);
  });
});
