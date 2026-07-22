import { ATTEMPT_OUTCOMES, ORDER_STATUSES, SALE_METRIC_FIELDS, SALE_STATES } from '@flash/shared';
import type {
  ApiErrorResponse,
  PurchaseResponse,
  PurchaseStatusResponse,
  ReadinessResponse,
  SaleMetricsResponse,
  SaleStatusResponse,
} from './contracts';

type Dict = Record<string, unknown>;
const object = (value: unknown): value is Dict =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const string = (value: unknown): value is string => typeof value === 'string';
const bool = (value: unknown): value is boolean => typeof value === 'boolean';
const finite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);
const integer = (value: unknown): value is number => finite(value) && Number.isInteger(value);
const count = (value: unknown): value is number => integer(value) && value >= 0;
const nullableCount = (value: unknown): value is number | null => value === null || count(value);
const iso = (value: unknown): value is string =>
  string(value) && Number.isFinite(Date.parse(value));
const member = <T extends readonly string[]>(values: T, value: unknown): value is T[number] =>
  string(value) && values.includes(value);

export function decodeSaleStatus(value: unknown): SaleStatusResponse | null {
  if (!object(value)) return null;
  if (
    !string(value.saleId) ||
    !string(value.name) ||
    !member(SALE_STATES, value.status) ||
    !iso(value.startsAt) ||
    !iso(value.endsAt) ||
    !integer(value.startsAtMs) ||
    !integer(value.endsAtMs) ||
    !count(value.totalStock) ||
    !count(value.stockRemaining) ||
    value.stockRemaining > value.totalStock ||
    !iso(value.serverTime) ||
    !integer(value.serverTimeMs)
  )
    return null;
  return value as SaleStatusResponse;
}

export function decodePurchase(value: unknown): PurchaseResponse | null {
  if (!object(value)) return null;
  if (
    !member(ATTEMPT_OUTCOMES, value.status) ||
    !string(value.userId) ||
    !string(value.saleId) ||
    !nullableCount(value.stockRemaining) ||
    !iso(value.serverTime) ||
    !integer(value.serverTimeMs) ||
    (value.message !== undefined && !string(value.message))
  )
    return null;
  return value as PurchaseResponse;
}

export function decodePurchaseStatus(value: unknown): PurchaseStatusResponse | null {
  if (!object(value) || !string(value.userId) || !string(value.saleId) || !bool(value.purchased))
    return null;
  if (!iso(value.serverTime) || !integer(value.serverTimeMs)) return null;
  if (value.order !== null) {
    if (!object(value.order) || !member(ORDER_STATUSES, value.order.status)) return null;
    if (!(value.order.createdAt === null || iso(value.order.createdAt))) return null;
    if (value.order.status === 'compensated' ? value.purchased : !value.purchased) return null;
  } else if (value.purchased) return null;
  return value as PurchaseStatusResponse;
}

export function decodeApiError(value: unknown): ApiErrorResponse | null {
  if (!object(value)) return null;
  if (!string(value.error) || !string(value.message) || !string(value.requestId)) return null;
  if (!iso(value.serverTime) || !integer(value.serverTimeMs)) return null;
  return value as ApiErrorResponse;
}

export function decodeSaleMetrics(value: unknown): SaleMetricsResponse | null {
  if (!object(value) || !string(value.saleId) || !object(value.metrics)) return null;
  const metrics = value.metrics;
  if (!SALE_METRIC_FIELDS.every((field) => count(metrics[field]))) return null;
  if (!iso(value.serverTime) || !integer(value.serverTimeMs)) return null;
  return value as SaleMetricsResponse;
}

function latency(value: unknown): value is number | null {
  return value === null || (finite(value) && value >= 0);
}

export function decodeReadiness(value: unknown): ReadinessResponse | null {
  if (
    !object(value) ||
    !member(['ok', 'degraded'] as const, value.status) ||
    value.service !== 'api'
  )
    return null;
  if (!string(value.version) || !finite(value.uptimeSeconds) || value.uptimeSeconds < 0)
    return null;
  if (!string(value.requestId) || !iso(value.serverTime) || !integer(value.serverTimeMs))
    return null;
  if (!object(value.checks)) return null;
  const { redis, postgres, clock, sale, queue } = value.checks;
  if (!object(redis) || !bool(redis.ok) || !latency(redis.latencyMs)) return null;
  if (!object(postgres) || !bool(postgres.ok) || !latency(postgres.latencyMs)) return null;
  if (
    !object(clock) ||
    !bool(clock.ok) ||
    !finite(clock.offsetMs) ||
    !finite(clock.rttMs) ||
    !finite(clock.ageMs)
  )
    return null;
  if (!object(sale) || !bool(sale.ok) || !bool(sale.initialized) || !bool(sale.stockKeyPresent))
    return null;
  if (
    !object(queue) ||
    !bool(queue.ok) ||
    !count(queue.waiting) ||
    !count(queue.active) ||
    !count(queue.delayed) ||
    !count(queue.failed)
  )
    return null;
  return value as ReadinessResponse;
}
