import { describe, expect, it } from 'vitest';

import {
  ORDERS_JOB_ATTEMPTS,
  ORDERS_JOB_BACKOFF_DELAY_MS,
  ORDERS_QUEUE_PREFIX,
  PERSIST_ORDER_JOB_NAME,
  assertOrdersQueueJobPayload,
  buildOrdersJobId,
  type OrdersQueueJobPayload,
} from './queue';

const VALID_PAYLOAD: OrdersQueueJobPayload = {
  saleId: 'flash-2026',
  userId: 'buyer-one',
  reservationId: '11111111-1111-4111-8111-111111111111',
  reservedAtMs: 1_700_000_000_000,
  requestId: 'request_1',
};

describe('shared orders queue contract', () => {
  it('exports the frozen queue constants', () => {
    expect(ORDERS_QUEUE_PREFIX).toBe('bull');
    expect(PERSIST_ORDER_JOB_NAME).toBe('persist-order');
    expect(ORDERS_JOB_ATTEMPTS).toBe(5);
    expect(ORDERS_JOB_BACKOFF_DELAY_MS).toBe(200);
  });

  it('builds the user-deterministic job id without changing hyphenated inputs', () => {
    expect(buildOrdersJobId('flash-2026', 'buyer-one')).toBe('flash-2026-buyer-one');
  });

  it('validates saleId before userId', () => {
    expect(() => buildOrdersJobId('INVALID', ' bad ')).toThrow(/saleId/);
  });

  it.each(['ab', ' buyer', 'buyer ', 'bad user', 'a'.repeat(65)])(
    'rejects invalid userId %j',
    (userId) => {
      expect(() => buildOrdersJobId('flash-2026', userId)).toThrow(TypeError);
    },
  );

  it('accepts the exact payload shape and returns nothing', () => {
    expect(assertOrdersQueueJobPayload(VALID_PAYLOAD)).toBeUndefined();
  });

  it.each([
    null,
    [],
    {},
    { ...VALID_PAYLOAD, extra: true },
    Object.assign({ ...VALID_PAYLOAD }, { [Symbol('extra')]: true }),
    { ...VALID_PAYLOAD, saleId: 'INVALID' },
    { ...VALID_PAYLOAD, userId: ' buyer-one' },
    { ...VALID_PAYLOAD, reservationId: 'not-a-uuid' },
    { ...VALID_PAYLOAD, reservationId: '11111111-1111-0111-1111-111111111111' },
    { ...VALID_PAYLOAD, reservedAtMs: -1 },
    { ...VALID_PAYLOAD, reservedAtMs: 1.5 },
    { ...VALID_PAYLOAD, reservedAtMs: Number.MAX_SAFE_INTEGER + 1 },
    { ...VALID_PAYLOAD, requestId: '' },
    { ...VALID_PAYLOAD, requestId: 'bad request' },
    { ...VALID_PAYLOAD, requestId: 'a'.repeat(129) },
  ])('rejects malformed payload %#', (payload) => {
    expect(() => assertOrdersQueueJobPayload(payload)).toThrow(TypeError);
  });

  it('accepts reconciliation request IDs', () => {
    expect(() =>
      assertOrdersQueueJobPayload({
        ...VALID_PAYLOAD,
        requestId: `reconcile-${VALID_PAYLOAD.reservationId}`,
      }),
    ).not.toThrow();
  });
});
