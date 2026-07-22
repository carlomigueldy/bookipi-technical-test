import { describe, expect, it } from 'vitest';
import {
  API_GLOBAL_PREFIX,
  ATTEMPT_OUTCOMES,
  HEALTH_PATH,
  OUTCOME_METRIC_FIELD,
  ORDERS_JOB_ATTEMPTS,
  ORDERS_JOB_BACKOFF_DELAY_MS,
  ORDERS_QUEUE_PREFIX,
  PERSIST_ORDER_JOB_NAME,
  PURCHASE_OUTCOME_HTTP_STATUS,
  SALE_STATES,
  SERVICE_NAMES,
  USER_ID_MAX_LENGTH,
  USER_ID_MIN_LENGTH,
  USER_ID_PATTERN,
  assertSaleId,
  assertOrdersQueueJobPayload,
  buildOrdersJobId,
  deriveSaleState,
  isWithinSaleWindow,
  saleKeys,
} from './index';
import type { HealthResponse, OrdersQueueJobPayload, SaleState } from './index';

describe('@flash/shared barrel exports', () => {
  it('exposes the frozen service name list', () => {
    expect(SERVICE_NAMES).toEqual(['api', 'worker', 'web']);
  });

  it('exposes the frozen api prefix and health path', () => {
    expect(API_GLOBAL_PREFIX).toBe('api');
    expect(HEALTH_PATH).toBe('health');
  });

  it('shapes a HealthResponse matching the frozen contract', () => {
    const sample: HealthResponse = {
      status: 'ok',
      service: 'api',
      version: '0.0.0',
      uptimeSeconds: 12.3,
    };

    expect(sample.status).toBe('ok');
  });

  it('exposes the userId validation constants (single source for SLICE 2)', () => {
    expect(USER_ID_MIN_LENGTH).toBe(3);
    expect(USER_ID_MAX_LENGTH).toBe(64);
    expect(USER_ID_PATTERN.test('valid.user-1@x')).toBe(true);
    expect(USER_ID_PATTERN.test('bad user')).toBe(false);
  });

  it('re-exports the key builders and assertSaleId, wired correctly through the barrel', () => {
    expect(saleKeys('flash-2026')).toEqual({
      config: 'sale:{flash-2026}:config',
      stock: 'sale:{flash-2026}:stock',
      buyers: 'sale:{flash-2026}:buyers',
      metrics: 'sale:{flash-2026}:metrics',
      reservations: 'sale:{flash-2026}:reservations',
    });
    expect(() => assertSaleId('has{brace')).toThrow(TypeError);
  });

  it('re-exports the sale state machine, wired correctly through the barrel', () => {
    expect(SALE_STATES).toEqual(['upcoming', 'active', 'sold_out', 'ended']);
    const state: SaleState = deriveSaleState({
      nowMs: 1_500,
      startsAtMs: 1_000,
      endsAtMs: 2_000,
      stockRemaining: 3,
    });
    expect(state).toBe('active');
    expect(isWithinSaleWindow(1_500, 1_000, 2_000)).toBe(true);
  });

  it('re-exports the result/error taxonomy, wired correctly through the barrel', () => {
    expect(ATTEMPT_OUTCOMES).toContain('CONFIRMED');
    expect(PURCHASE_OUTCOME_HTTP_STATUS.CONFIRMED).toBe(201);
    expect(OUTCOME_METRIC_FIELD.SOLD_OUT).toBe('sold_out');
  });

  it('re-exports the queue contract, wired correctly through the barrel', () => {
    const payload: OrdersQueueJobPayload = {
      saleId: 'flash-2026',
      userId: 'buyer-one',
      reservationId: '11111111-1111-4111-8111-111111111111',
      reservedAtMs: 1_700_000_000_000,
      requestId: 'request-1',
    };

    expect(ORDERS_QUEUE_PREFIX).toBe('bull');
    expect(PERSIST_ORDER_JOB_NAME).toBe('persist-order');
    expect(ORDERS_JOB_ATTEMPTS).toBe(5);
    expect(ORDERS_JOB_BACKOFF_DELAY_MS).toBe(200);
    expect(buildOrdersJobId(payload.saleId, payload.userId)).toBe('flash-2026-buyer-one');
    expect(assertOrdersQueueJobPayload(payload)).toBeUndefined();
  });
});
