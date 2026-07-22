import { describe, expect, it } from 'vitest';
import { ORDER_STATUSES } from '../results';
import { purchaseStatusParamsSchema, purchaseStatusResponseSchema } from './purchase-status';

describe('purchaseStatusParamsSchema', () => {
  it('accepts and trims a valid userId', () => {
    const result = purchaseStatusParamsSchema.safeParse({ userId: '  bob  ' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({ userId: 'bob' });
    }
  });

  it('rejects an invalid userId', () => {
    expect(purchaseStatusParamsSchema.safeParse({ userId: '' }).success).toBe(false);
  });

  it('rejects an extra unknown key (.strict())', () => {
    expect(purchaseStatusParamsSchema.safeParse({ userId: 'bob', saleId: 'x' }).success).toBe(
      false,
    );
  });
});

describe('purchaseStatusResponseSchema', () => {
  const base = {
    userId: 'bob',
    saleId: 'flash-2026',
    purchased: true,
    order: {
      status: 'reserved' as const,
      createdAt: '2026-07-22T00:05:00.000Z',
    },
    serverTime: '2026-07-22T00:06:00.000Z',
    serverTimeMs: 1_784_000_360_000,
  };

  it('accepts a well-formed "purchased" response', () => {
    expect(purchaseStatusResponseSchema.safeParse(base).success).toBe(true);
  });

  it('accepts order: null when purchased is false (one shape, no optionality branch)', () => {
    const result = purchaseStatusResponseSchema.safeParse({
      ...base,
      purchased: false,
      order: null,
    });
    expect(result.success).toBe(true);
  });

  it('rejects order being entirely absent (must be null, not omitted)', () => {
    const { order: _unused, ...withoutOrder } = base;
    expect(purchaseStatusResponseSchema.safeParse(withoutOrder).success).toBe(false);
  });

  it.each(ORDER_STATUSES)('accepts every frozen OrderStatus (%s)', (status) => {
    const result = purchaseStatusResponseSchema.safeParse({
      ...base,
      order: { ...base.order, status },
    });
    expect(result.success).toBe(true);
  });

  it('rejects an order status outside the frozen OrderStatus vocabulary', () => {
    const result = purchaseStatusResponseSchema.safeParse({
      ...base,
      order: { ...base.order, status: 'cancelled' },
    });
    expect(result.success).toBe(false);
  });

  it('accepts order.createdAt: null', () => {
    const result = purchaseStatusResponseSchema.safeParse({
      ...base,
      order: { ...base.order, createdAt: null },
    });
    expect(result.success).toBe(true);
  });

  it('rejects a malformed order.createdAt', () => {
    const result = purchaseStatusResponseSchema.safeParse({
      ...base,
      order: { ...base.order, createdAt: 'not-a-date' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects a non-boolean purchased field', () => {
    expect(purchaseStatusResponseSchema.safeParse({ ...base, purchased: 'yes' }).success).toBe(
      false,
    );
  });

  it('rejects a missing required top-level field', () => {
    const { saleId: _unused, ...withoutSaleId } = base;
    expect(purchaseStatusResponseSchema.safeParse(withoutSaleId).success).toBe(false);
  });
});
