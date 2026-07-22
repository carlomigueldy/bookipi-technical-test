import { PURCHASE_OUTCOME_HTTP_STATUS } from '@flash/shared';
import { API_BASE_URL } from '../env';
import {
  decodeApiError,
  decodePurchase,
  decodePurchaseStatus,
  decodeReadiness,
  decodeSaleMetrics,
  decodeSaleStatus,
} from './decoders';
import type {
  PurchaseResponse,
  PurchaseStatusResponse,
  ReadinessResponse,
  SaleMetricsResponse,
  SaleStatusResponse,
  Timed,
} from './contracts';

export type ApiClientErrorKind = 'network' | 'timeout' | 'invalid-response' | 'http';

export class ApiClientError extends Error {
  constructor(
    public readonly kind: ApiClientErrorKind,
    message: string,
    public readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'ApiClientError';
  }
}

type Fetch = typeof fetch;
type Decoder<T> = (value: unknown) => T | null;
const DECIMAL_SECONDS = /^[0-9]+$/;

function parseRetryAfter(value: string | null): number | undefined {
  if (value === null || !DECIMAL_SECONDS.test(value)) return undefined;
  const seconds = Number(value);
  if (!Number.isSafeInteger(seconds)) return undefined;
  return Math.min(10, Math.max(0, seconds));
}

function abortSignals(external: AbortSignal | undefined, timeoutMs: number | undefined) {
  const controller = new AbortController();
  let timedOut = false;
  const onAbort = () => controller.abort(external?.reason);
  external?.addEventListener('abort', onAbort, { once: true });
  const timer =
    timeoutMs === undefined
      ? undefined
      : setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, timeoutMs);
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    cleanup: () => {
      if (timer !== undefined) clearTimeout(timer);
      external?.removeEventListener('abort', onAbort);
    },
  };
}

export function createApiClient({
  baseUrl = API_BASE_URL,
  fetchImpl = globalThis.fetch,
  nowMs = Date.now,
}: { baseUrl?: string; fetchImpl?: Fetch; nowMs?: () => number } = {}) {
  const root = baseUrl.replace(/\/+$/, '');

  async function request<T>(
    path: string,
    decoder: Decoder<T>,
    options: RequestInit & { timeoutMs?: number } = {},
    purchase = false,
  ): Promise<Timed<T>> {
    const sentAtMs = nowMs();
    const linked = abortSignals(options.signal ?? undefined, options.timeoutMs);
    try {
      const response = await fetchImpl(`${root}${path}`, { ...options, signal: linked.signal });
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw new ApiClientError('invalid-response', 'The server returned an unreadable response.');
      }
      const retryAfterSeconds = parseRetryAfter(response.headers.get('Retry-After'));
      const data = decoder(body);
      if (
        purchase &&
        data &&
        (data as unknown as PurchaseResponse).status === 'CONFIRMED' &&
        response.status !== PURCHASE_OUTCOME_HTTP_STATUS.CONFIRMED
      ) {
        throw new ApiClientError('invalid-response', 'The server returned an unexpected response.');
      }
      if (data && (response.ok || purchase))
        return { data, sentAtMs, receivedAtMs: nowMs(), retryAfterSeconds };
      const apiError = decodeApiError(body);
      if (!response.ok && apiError) {
        throw new ApiClientError(
          'http',
          'The service is temporarily unavailable.',
          retryAfterSeconds,
        );
      }
      throw new ApiClientError('invalid-response', 'The server returned an unexpected response.');
    } catch (error) {
      if (error instanceof ApiClientError) throw error;
      if (linked.timedOut()) throw new ApiClientError('timeout', 'The request timed out.');
      throw new ApiClientError('network', 'The service could not be reached.');
    } finally {
      linked.cleanup();
    }
  }

  return {
    getSaleStatus: (signal?: AbortSignal) =>
      request<SaleStatusResponse>('/sale/status', decodeSaleStatus, { signal, timeoutMs: 4000 }),
    purchase: (userId: string, signal?: AbortSignal) =>
      request<PurchaseResponse>(
        '/purchase',
        decodePurchase,
        {
          method: 'POST',
          signal,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userId: userId.trim() }),
        },
        true,
      ),
    getPurchaseStatus: (userId: string, signal?: AbortSignal) =>
      request<PurchaseStatusResponse>(
        `/purchase/${encodeURIComponent(userId)}`,
        decodePurchaseStatus,
        { signal, timeoutMs: 4000 },
      ),
    getSaleMetrics: (signal?: AbortSignal) =>
      request<SaleMetricsResponse>('/sale/metrics', decodeSaleMetrics, { signal, timeoutMs: 4000 }),
    getReadiness: (signal?: AbortSignal) =>
      request<ReadinessResponse>('/health/ready', decodeReadiness, { signal, timeoutMs: 4000 }),
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
export const apiClient = createApiClient();
