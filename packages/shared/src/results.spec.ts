import { describe, expect, it } from 'vitest';
import {
  ATTEMPT_OUTCOMES,
  ORDER_STATUSES,
  OUTCOME_METRIC_FIELD,
  PURCHASE_OUTCOME_HTTP_STATUS,
  PURCHASE_OUTCOMES,
  REQUEST_OUTCOMES,
  SALE_METRIC_FIELDS,
  SALE_NOT_ACTIVE_OUTCOMES,
  isSuccessOutcome,
} from './results';
import type { AttemptOutcome } from './results';

describe('outcome vocabularies', () => {
  it('PURCHASE_OUTCOMES is exactly the six Lua outcomes, in the frozen order', () => {
    expect(PURCHASE_OUTCOMES).toEqual([
      'CONFIRMED',
      'ALREADY_PURCHASED',
      'SOLD_OUT',
      'SALE_NOT_STARTED',
      'SALE_ENDED',
      'NOT_INITIALIZED',
    ]);
  });

  it('REQUEST_OUTCOMES is exactly the three above-Redis outcomes', () => {
    expect(REQUEST_OUTCOMES).toEqual(['INVALID_USER_ID', 'RATE_LIMITED', 'UPSTREAM_UNAVAILABLE']);
  });

  it('ATTEMPT_OUTCOMES is the concatenation of purchase + request outcomes, 9 total, no duplicates', () => {
    expect(ATTEMPT_OUTCOMES).toEqual([...PURCHASE_OUTCOMES, ...REQUEST_OUTCOMES]);
    expect(ATTEMPT_OUTCOMES).toHaveLength(9);
    expect(new Set(ATTEMPT_OUTCOMES).size).toBe(9);
  });

  it('ORDER_STATUSES mirrors the Postgres enum', () => {
    expect(ORDER_STATUSES).toEqual(['reserved', 'persisted', 'compensated']);
  });
});

describe('PURCHASE_OUTCOME_HTTP_STATUS — §7 table, exact codes', () => {
  const EXPECTED: Record<AttemptOutcome, number> = {
    CONFIRMED: 201,
    ALREADY_PURCHASED: 409,
    SOLD_OUT: 410,
    SALE_NOT_STARTED: 403,
    SALE_ENDED: 403,
    NOT_INITIALIZED: 503,
    INVALID_USER_ID: 422,
    RATE_LIMITED: 429,
    UPSTREAM_UNAVAILABLE: 503,
  };

  it.each(Object.entries(EXPECTED))('%s -> %d', (outcome, status) => {
    expect(PURCHASE_OUTCOME_HTTP_STATUS[outcome as AttemptOutcome]).toBe(status);
  });

  it('covers every member of ATTEMPT_OUTCOMES with no extras', () => {
    const mappedKeys = Object.keys(PURCHASE_OUTCOME_HTTP_STATUS).sort();
    expect(mappedKeys).toEqual([...ATTEMPT_OUTCOMES].sort());
  });
});

describe('SALE_NOT_ACTIVE_OUTCOMES', () => {
  it('is exactly the two window-closed outcomes', () => {
    expect(SALE_NOT_ACTIVE_OUTCOMES).toEqual(['SALE_NOT_STARTED', 'SALE_ENDED']);
  });
});

describe('isSuccessOutcome', () => {
  it('is true only for CONFIRMED', () => {
    for (const outcome of ATTEMPT_OUTCOMES) {
      expect(isSuccessOutcome(outcome)).toBe(outcome === 'CONFIRMED');
    }
  });
});

describe('SALE_METRIC_FIELDS / OUTCOME_METRIC_FIELD', () => {
  it('SALE_METRIC_FIELDS is the frozen seven fields', () => {
    expect(SALE_METRIC_FIELDS).toEqual([
      'confirmed',
      'already_purchased',
      'sold_out',
      'sale_not_active',
      'not_initialized',
      'rate_limited',
      'invalid_user_id',
    ]);
  });

  it('OUTCOME_METRIC_FIELD covers every member of ATTEMPT_OUTCOMES', () => {
    const mappedKeys = Object.keys(OUTCOME_METRIC_FIELD).sort();
    expect(mappedKeys).toEqual([...ATTEMPT_OUTCOMES].sort());
  });

  it('every mapped value is a field name present in SALE_METRIC_FIELDS', () => {
    for (const outcome of ATTEMPT_OUTCOMES) {
      expect(SALE_METRIC_FIELDS).toContain(OUTCOME_METRIC_FIELD[outcome]);
    }
  });

  it('SALE_NOT_STARTED and SALE_ENDED both fold into sale_not_active', () => {
    expect(OUTCOME_METRIC_FIELD.SALE_NOT_STARTED).toBe('sale_not_active');
    expect(OUTCOME_METRIC_FIELD.SALE_ENDED).toBe('sale_not_active');
  });

  it('the exact mapping for every outcome', () => {
    expect(OUTCOME_METRIC_FIELD).toEqual({
      CONFIRMED: 'confirmed',
      ALREADY_PURCHASED: 'already_purchased',
      SOLD_OUT: 'sold_out',
      SALE_NOT_STARTED: 'sale_not_active',
      SALE_ENDED: 'sale_not_active',
      NOT_INITIALIZED: 'not_initialized',
      INVALID_USER_ID: 'invalid_user_id',
      RATE_LIMITED: 'rate_limited',
      UPSTREAM_UNAVAILABLE: 'not_initialized',
    });
  });
});
