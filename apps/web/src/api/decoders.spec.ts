import { ATTEMPT_OUTCOMES } from '@flash/shared';
import { describe, expect, it } from 'vitest';
import { ApiClientError } from './client';
import {
  decodeApiError,
  decodePurchase,
  decodePurchaseStatus,
  decodeReadiness,
  decodeSaleMetrics,
  decodeSaleStatus,
} from './decoders';

const iso = '2026-07-23T04:00:00.000Z';
const baseSale = {
  saleId: 'sale',
  name: 'Aurora',
  status: 'active',
  startsAt: iso,
  endsAt: iso,
  startsAtMs: 0,
  endsAtMs: 2,
  totalStock: 5,
  stockRemaining: 4,
  serverTime: iso,
  serverTimeMs: 1,
};
const basePurchase = {
  status: 'CONFIRMED',
  userId: 'mia',
  saleId: 'sale',
  stockRemaining: 4,
  serverTime: iso,
  serverTimeMs: 1,
};
const basePurchaseStatus = {
  userId: 'mia',
  saleId: 'sale',
  purchased: true,
  order: { status: 'reserved', createdAt: null },
  serverTime: iso,
  serverTimeMs: 1,
};
const baseMetrics = {
  saleId: 'sale',
  metrics: {
    confirmed: 0,
    already_purchased: 0,
    sold_out: 0,
    sale_not_active: 0,
    not_initialized: 0,
    rate_limited: 0,
    invalid_user_id: 0,
  },
  serverTime: iso,
  serverTimeMs: 1,
};
const baseReadiness = {
  status: 'ok',
  service: 'api',
  version: 'x',
  uptimeSeconds: 1,
  checks: {
    redis: { ok: true, latencyMs: 1 },
    postgres: { ok: true, latencyMs: 1 },
    clock: { ok: true, offsetMs: 0, rttMs: 1, ageMs: 1 },
    sale: { ok: true, initialized: true, stockKeyPresent: true },
    queue: { ok: true, waiting: 0, active: 0, delayed: 0, failed: 0 },
  },
  requestId: 'x',
  serverTime: iso,
  serverTimeMs: 1,
};
const baseApiError = {
  error: 'UNAVAILABLE',
  message: 'Try later',
  requestId: 'request',
  serverTime: iso,
  serverTimeMs: 1,
};

type Decoder = (value: unknown) => unknown | null;

function expectInvalid(decoder: Decoder, value: unknown) {
  const decode = () => {
    if (decoder(value) === null) {
      throw new ApiClientError('invalid-response', 'The server returned an unexpected response.');
    }
  };
  expect(decode).toThrow(expect.objectContaining({ kind: 'invalid-response' }));
}

describe('response decoders', () => {
  it.each(ATTEMPT_OUTCOMES)('accepts purchase outcome %s', (status) => {
    expect(decodePurchase({ ...basePurchase, status })).not.toBeNull();
  });

  it('accepts every ops DTO and compensated false', () => {
    expect(decodeSaleStatus(baseSale)).not.toBeNull();
    expect(decodeSaleMetrics(baseMetrics)).not.toBeNull();
    expect(
      decodePurchaseStatus({
        ...basePurchaseStatus,
        purchased: false,
        order: { status: 'compensated', createdAt: null },
      }),
    ).not.toBeNull();
    expect(decodeReadiness(baseReadiness)).not.toBeNull();
    expect(decodeApiError(baseApiError)).not.toBeNull();
  });

  it.each([
    ['non-object', null],
    ['unknown state', { ...baseSale, status: 'paused' }],
    ['invalid ISO time', { ...baseSale, startsAt: 'tomorrow' }],
    ['fractional serverTimeMs', { ...baseSale, serverTimeMs: 1.5 }],
    ['negative totalStock', { ...baseSale, totalStock: -1 }],
    ['negative remainingStock', { ...baseSale, stockRemaining: -1 }],
    ['remainingStock greater than totalStock', { ...baseSale, stockRemaining: 6 }],
  ])('sale status rejects %s', (_reason, value) => expectInvalid(decodeSaleStatus, value));

  it.each([
    ['non-object', []],
    ['unknown outcome', { ...basePurchase, status: 'PENDING' }],
    ['negative stock', { ...basePurchase, stockRemaining: -1 }],
    ['fractional stock', { ...basePurchase, stockRemaining: 1.5 }],
    ['invalid ISO time', { ...basePurchase, serverTime: 'now' }],
    ['fractional serverTimeMs', { ...basePurchase, serverTimeMs: 1.5 }],
    ['non-string optional message', { ...basePurchase, message: 42 }],
  ])('purchase response rejects %s', (_reason, value) => expectInvalid(decodePurchase, value));

  it.each([
    [
      'unknown order status',
      { ...basePurchaseStatus, order: { status: 'queued', createdAt: null } },
    ],
    ['reserved with purchased false', { ...basePurchaseStatus, purchased: false }],
    [
      'persisted with purchased false',
      {
        ...basePurchaseStatus,
        purchased: false,
        order: { status: 'persisted', createdAt: iso },
      },
    ],
    [
      'compensated with purchased true',
      { ...basePurchaseStatus, order: { status: 'compensated', createdAt: null } },
    ],
    ['null order with purchased true', { ...basePurchaseStatus, order: null }],
    [
      'invalid non-null createdAt',
      { ...basePurchaseStatus, order: { status: 'persisted', createdAt: 'yesterday' } },
    ],
  ])('purchase status rejects %s', (_reason, value) => expectInvalid(decodePurchaseStatus, value));

  it.each([
    [
      'missing metric field',
      { ...baseMetrics, metrics: { ...baseMetrics.metrics, confirmed: undefined } },
    ],
    ['negative metric', { ...baseMetrics, metrics: { ...baseMetrics.metrics, sold_out: -1 } }],
    [
      'fractional metric',
      { ...baseMetrics, metrics: { ...baseMetrics.metrics, rate_limited: 1.5 } },
    ],
    ['invalid server time pair', { ...baseMetrics, serverTime: 'later', serverTimeMs: 1.5 }],
  ])('sale metrics rejects %s', (_reason, value) => expectInvalid(decodeSaleMetrics, value));

  it.each([
    ['wrong top-level status', { ...baseReadiness, status: 'ready' }],
    ['wrong top-level service', { ...baseReadiness, service: 'worker' }],
    ['negative uptime', { ...baseReadiness, uptimeSeconds: -1 }],
    ['missing request ID', { ...baseReadiness, requestId: undefined }],
    [
      'invalid latency',
      {
        ...baseReadiness,
        checks: { ...baseReadiness.checks, redis: { ok: true, latencyMs: -1 } },
      },
    ],
    [
      'invalid Redis clock',
      {
        ...baseReadiness,
        checks: {
          ...baseReadiness.checks,
          clock: { ...baseReadiness.checks.clock, offsetMs: Number.NaN },
        },
      },
    ],
    [
      'negative queue count',
      {
        ...baseReadiness,
        checks: {
          ...baseReadiness.checks,
          queue: { ...baseReadiness.checks.queue, waiting: -1 },
        },
      },
    ],
    [
      'missing nested check',
      { ...baseReadiness, checks: { ...baseReadiness.checks, postgres: undefined } },
    ],
  ])('readiness rejects %s', (_reason, value) => expectInvalid(decodeReadiness, value));

  it.each([
    ['non-object', 'failure'],
    ['missing required string', { ...baseApiError, requestId: undefined }],
    ['invalid required string', { ...baseApiError, message: 42 }],
    ['invalid ISO serverTime', { ...baseApiError, serverTime: 'now' }],
    ['fractional serverTimeMs', { ...baseApiError, serverTimeMs: 1.5 }],
  ])('API error rejects %s', (_reason, value) => expectInvalid(decodeApiError, value));
});
