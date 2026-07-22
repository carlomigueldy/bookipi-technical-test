import type {
  PurchaseResponse,
  PurchaseStatusResponse,
  SaleStatusResponse,
} from '@flash/shared/schemas';

export type { PurchaseResponse, PurchaseStatusResponse, SaleStatusResponse };

export type ApiErrorResponse = {
  error: string;
  message: string;
  requestId: string;
  serverTime: string;
  serverTimeMs: number;
};

export type MetricName =
  | 'confirmed'
  | 'already_purchased'
  | 'sold_out'
  | 'sale_not_active'
  | 'not_initialized'
  | 'rate_limited'
  | 'invalid_user_id';

export type SaleMetricsResponse = {
  saleId: string;
  metrics: Record<MetricName, number>;
  serverTime: string;
  serverTimeMs: number;
};

export type ReadinessResponse = {
  status: 'ok' | 'degraded';
  service: 'api';
  version: string;
  uptimeSeconds: number;
  checks: {
    redis: { ok: boolean; latencyMs: number | null };
    postgres: { ok: boolean; latencyMs: number | null };
    clock: { ok: boolean; offsetMs: number; rttMs: number; ageMs: number };
    sale: { ok: boolean; initialized: boolean; stockKeyPresent: boolean };
    queue: { ok: boolean; waiting: number; active: number; delayed: number; failed: number };
  };
  requestId: string;
  serverTime: string;
  serverTimeMs: number;
};

export type Timed<T> = {
  data: T;
  sentAtMs: number;
  receivedAtMs: number;
  retryAfterSeconds?: number;
};
