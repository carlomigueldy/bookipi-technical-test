import { describe, expect, it } from 'vitest';
import { SALE_STATES } from '../sale-state';
import { saleStatusResponseSchema } from './sale-status';

describe('saleStatusResponseSchema', () => {
  const base = {
    saleId: 'flash-2026',
    name: 'Flash Sale 2026',
    status: 'active' as const,
    startsAt: '2026-07-22T00:00:00.000Z',
    endsAt: '2026-07-22T01:00:00.000Z',
    startsAtMs: 1_784_000_000_000,
    endsAtMs: 1_784_003_600_000,
    totalStock: 500,
    stockRemaining: 497,
    serverTime: '2026-07-22T00:05:00.000Z',
    serverTimeMs: 1_784_000_300_000,
  };

  it('accepts a well-formed active-sale snapshot', () => {
    expect(saleStatusResponseSchema.safeParse(base).success).toBe(true);
  });

  it.each(SALE_STATES)('accepts every frozen SaleState as `status` (%s)', (status) => {
    expect(saleStatusResponseSchema.safeParse({ ...base, status }).success).toBe(true);
  });

  it('rejects a status outside the frozen SaleState vocabulary', () => {
    expect(saleStatusResponseSchema.safeParse({ ...base, status: 'closed' }).success).toBe(false);
  });

  it('accepts stockRemaining === 0 (sold out is not negative)', () => {
    expect(saleStatusResponseSchema.safeParse({ ...base, stockRemaining: 0 }).success).toBe(true);
  });

  it('rejects a negative stockRemaining', () => {
    expect(saleStatusResponseSchema.safeParse({ ...base, stockRemaining: -1 }).success).toBe(false);
  });

  it('rejects a negative totalStock', () => {
    expect(saleStatusResponseSchema.safeParse({ ...base, totalStock: -1 }).success).toBe(false);
  });

  it('rejects non-integer *Ms fields', () => {
    expect(saleStatusResponseSchema.safeParse({ ...base, startsAtMs: 1.5 }).success).toBe(false);
    expect(saleStatusResponseSchema.safeParse({ ...base, endsAtMs: 1.5 }).success).toBe(false);
    expect(saleStatusResponseSchema.safeParse({ ...base, serverTimeMs: 1.5 }).success).toBe(false);
  });

  it('rejects malformed ISO timestamps', () => {
    expect(saleStatusResponseSchema.safeParse({ ...base, startsAt: '07/22/2026' }).success).toBe(
      false,
    );
    expect(saleStatusResponseSchema.safeParse({ ...base, endsAt: '07/22/2026' }).success).toBe(
      false,
    );
  });

  it('rejects a missing required field', () => {
    const { name: _unused, ...withoutName } = base;
    expect(saleStatusResponseSchema.safeParse(withoutName).success).toBe(false);
  });
});
