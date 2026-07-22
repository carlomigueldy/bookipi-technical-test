import { describe, expect, it } from 'vitest';
import { ATTEMPT_OUTCOMES } from '../results';
import { purchaseRequestSchema, purchaseResponseSchema } from './purchase';

describe('purchaseRequestSchema', () => {
  it('accepts a valid userId and trims it', () => {
    const result = purchaseRequestSchema.safeParse({ userId: '  bob  ' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({ userId: 'bob' });
    }
  });

  it('rejects a missing userId', () => {
    expect(purchaseRequestSchema.safeParse({}).success).toBe(false);
  });

  it('rejects an invalid userId (charset violation)', () => {
    expect(purchaseRequestSchema.safeParse({ userId: 'a b' }).success).toBe(false);
  });

  it('rejects a request with an extra unknown key (.strict())', () => {
    const result = purchaseRequestSchema.safeParse({ userId: 'bob', admin: true });
    expect(result.success).toBe(false);
  });

  it('rejects a non-object payload', () => {
    expect(purchaseRequestSchema.safeParse('bob').success).toBe(false);
    expect(purchaseRequestSchema.safeParse(null).success).toBe(false);
    expect(purchaseRequestSchema.safeParse(undefined).success).toBe(false);
  });

  it('rejects a prototype-pollution-shaped payload (zod .strict() enumerates the inherited key too)', () => {
    // `__proto__` as an *object literal key* in JS source sets the object's
    // [[Prototype]] rather than creating an own property (Annex B legacy
    // behavior) — `Object.keys(payload)` is just `['userId']`. One might
    // expect an own-keys-based strict check to therefore let this through.
    // Verified reality is stronger: zod's `.strict()` unknown-key check
    // enumerates inherited enumerable properties too (`for...in` semantics),
    // so it sees `polluted` (an enumerable own property of the injected
    // prototype) as an unrecognized key and REJECTS the payload outright.
    // This is a genuinely good defense-in-depth property worth pinning down
    // with a real test rather than assuming it either way.
    const result = purchaseRequestSchema.safeParse({
      userId: 'bob',
      __proto__: { polluted: true },
    });
    expect(result.success).toBe(false);
  });
});

describe('purchaseResponseSchema', () => {
  const base = {
    status: 'CONFIRMED' as const,
    userId: 'bob',
    saleId: 'flash-2026',
    stockRemaining: 9,
    serverTime: '2026-07-22T00:00:00.000Z',
    serverTimeMs: 1_784_000_000_000,
  };

  it('accepts a well-formed CONFIRMED response', () => {
    expect(purchaseResponseSchema.safeParse(base).success).toBe(true);
  });

  it('accepts stockRemaining: null (unknown outcome, e.g. 422/429/503)', () => {
    const result = purchaseResponseSchema.safeParse({
      ...base,
      status: 'INVALID_USER_ID',
      stockRemaining: null,
    });
    expect(result.success).toBe(true);
  });

  it('accepts an optional message field', () => {
    expect(purchaseResponseSchema.safeParse({ ...base, message: 'human readable' }).success).toBe(
      true,
    );
  });

  it('rejects when message is omitted (optional, not required) — sanity check it is truly optional', () => {
    const { message: _unused, ...withoutMessage } = { ...base, message: 'x' };
    expect(purchaseResponseSchema.safeParse(withoutMessage).success).toBe(true);
  });

  it.each(ATTEMPT_OUTCOMES)('accepts every frozen AttemptOutcome as `status` (%s)', (status) => {
    const result = purchaseResponseSchema.safeParse({ ...base, status });
    expect(result.success).toBe(true);
  });

  it('rejects a status outside the frozen AttemptOutcome vocabulary', () => {
    expect(purchaseResponseSchema.safeParse({ ...base, status: 'BOGUS' }).success).toBe(false);
  });

  it('rejects a non-integer stockRemaining', () => {
    expect(purchaseResponseSchema.safeParse({ ...base, stockRemaining: 9.5 }).success).toBe(false);
  });

  it('rejects a malformed serverTime (not ISO-8601)', () => {
    expect(purchaseResponseSchema.safeParse({ ...base, serverTime: 'not-a-date' }).success).toBe(
      false,
    );
  });

  it('rejects a non-integer serverTimeMs', () => {
    expect(purchaseResponseSchema.safeParse({ ...base, serverTimeMs: 1.5 }).success).toBe(false);
  });

  it('rejects a missing required field', () => {
    const { saleId: _unused, ...withoutSaleId } = base;
    expect(purchaseResponseSchema.safeParse(withoutSaleId).success).toBe(false);
  });
});
