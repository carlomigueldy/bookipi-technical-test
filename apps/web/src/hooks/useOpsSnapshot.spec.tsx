import '@testing-library/jest-dom/vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApiClient } from '../api/client';
import type { ReadinessResponse, SaleMetricsResponse, Timed } from '../api/contracts';
import { useOpsSnapshot } from './useOpsSnapshot';

const now = Date.UTC(2026, 6, 23, 4, 0, 0);
const iso = new Date(now).toISOString();
const middle = () => 0.5;
const timed = <T,>(data: T): Timed<T> => ({ data, sentAtMs: now, receivedAtMs: now });
const metric = (confirmed: number): SaleMetricsResponse => ({
  saleId: 'sale',
  metrics: {
    confirmed,
    already_purchased: 0,
    sold_out: 0,
    sale_not_active: 0,
    not_initialized: 0,
    rate_limited: 0,
    invalid_user_id: 0,
  },
  serverTime: iso,
  serverTimeMs: now,
});
const ready = (version: string): ReadinessResponse => ({
  status: 'ok',
  service: 'api',
  version,
  uptimeSeconds: 1,
  checks: {
    redis: { ok: true, latencyMs: 1 },
    postgres: { ok: true, latencyMs: 1 },
    clock: { ok: true, offsetMs: 0, rttMs: 1, ageMs: 1 },
    sale: { ok: true, initialized: true, stockKeyPresent: true },
    queue: { ok: true, waiting: 0, active: 0, delayed: 0, failed: 0 },
  },
  requestId: 'request',
  serverTime: iso,
  serverTimeMs: now,
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function apiClient(): ApiClient {
  return {
    getSaleStatus: vi.fn(),
    purchase: vi.fn(),
    getPurchaseStatus: vi.fn(),
    getSaleMetrics: vi.fn(),
    getReadiness: vi.fn(),
  } as unknown as ApiClient;
}

function Harness({ client }: { client: ApiClient }) {
  const ops = useOpsSnapshot(client, middle);
  return (
    <div>
      <span data-testid="metrics">
        {ops.metrics.value?.metrics.confirmed ?? 'none'}:{String(ops.metrics.stale)}:
        {ops.metrics.failures}:{ops.metrics.updatedAt ?? 'never'}:{ops.metrics.dueAt}
      </span>
      <span data-testid="readiness">
        {ops.readiness.value?.version ?? 'none'}:{String(ops.readiness.stale)}:
        {ops.readiness.failures}:{ops.readiness.updatedAt ?? 'never'}:{ops.readiness.dueAt}
      </span>
      <button onClick={ops.refresh}>Refresh ops</button>
    </div>
  );
}

describe('useOpsSnapshot lifecycle ownership', () => {
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('StrictMode stale success cannot overwrite the fresh generation or schedule work', async () => {
    const client = apiClient();
    const oldMetrics = deferred<Timed<SaleMetricsResponse>>();
    const oldReadiness = deferred<Timed<ReadinessResponse>>();
    let oldMetricsSignal: AbortSignal | undefined;
    let oldReadinessSignal: AbortSignal | undefined;
    vi.mocked(client.getSaleMetrics)
      .mockImplementationOnce((signal) => {
        oldMetricsSignal = signal;
        return oldMetrics.promise;
      })
      .mockResolvedValueOnce(timed(metric(22)));
    vi.mocked(client.getReadiness)
      .mockImplementationOnce((signal) => {
        oldReadinessSignal = signal;
        return oldReadiness.promise;
      })
      .mockResolvedValueOnce(timed(ready('fresh')));
    const timer = vi.spyOn(globalThis, 'setTimeout');
    render(
      <StrictMode>
        <Harness client={client} />
      </StrictMode>,
    );
    await waitFor(() => expect(client.getSaleMetrics).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByTestId('metrics')).toHaveTextContent('22:false:0'));
    expect(screen.getByTestId('readiness')).toHaveTextContent('fresh:false:0');
    expect(oldMetricsSignal?.aborted).toBe(true);
    expect(oldReadinessSignal?.aborted).toBe(true);
    const timersBeforeOldSettlement = timer.mock.calls.length;
    await act(async () => {
      oldMetrics.resolve(timed(metric(999)));
      oldReadiness.resolve(timed(ready('stale')));
      await Promise.resolve();
    });
    expect(screen.getByTestId('metrics')).toHaveTextContent('22:false:0');
    expect(screen.getByTestId('readiness')).toHaveTextContent('fresh:false:0');
    expect(timer.mock.calls).toHaveLength(timersBeforeOldSettlement);
  });

  it('StrictMode stale failure cannot mark fresh resources stale or move scheduling state', async () => {
    const client = apiClient();
    const oldMetrics = deferred<Timed<SaleMetricsResponse>>();
    const oldReadiness = deferred<Timed<ReadinessResponse>>();
    vi.mocked(client.getSaleMetrics)
      .mockImplementationOnce(() => oldMetrics.promise)
      .mockResolvedValueOnce(timed(metric(7)));
    vi.mocked(client.getReadiness)
      .mockImplementationOnce(() => oldReadiness.promise)
      .mockResolvedValueOnce(timed(ready('current')));
    render(
      <StrictMode>
        <Harness client={client} />
      </StrictMode>,
    );
    await waitFor(() => expect(screen.getByTestId('metrics')).toHaveTextContent('7:false:0'));
    const metricsBefore = screen.getByTestId('metrics').textContent;
    const readinessBefore = screen.getByTestId('readiness').textContent;
    await act(async () => {
      oldMetrics.reject(new Error('old metrics failure'));
      oldReadiness.reject(new Error('old readiness failure'));
      await Promise.resolve();
    });
    expect(screen.getByTestId('metrics')).toHaveTextContent(metricsBefore ?? '');
    expect(screen.getByTestId('readiness')).toHaveTextContent(readinessBefore ?? '');
    expect(client.getSaleMetrics).toHaveBeenCalledTimes(2);
    expect(client.getReadiness).toHaveBeenCalledTimes(2);
  });

  it('unmount aborts the owner and repeated refresh stays serialized with no late commit', async () => {
    const client = apiClient();
    const heldMetrics = deferred<Timed<SaleMetricsResponse>>();
    const heldReadiness = deferred<Timed<ReadinessResponse>>();
    let metricsSignal: AbortSignal | undefined;
    let readinessSignal: AbortSignal | undefined;
    vi.mocked(client.getSaleMetrics).mockImplementation((signal) => {
      metricsSignal = signal;
      return heldMetrics.promise;
    });
    vi.mocked(client.getReadiness).mockImplementation((signal) => {
      readinessSignal = signal;
      return heldReadiness.promise;
    });
    const removeListener = vi.spyOn(document, 'removeEventListener');
    const timer = vi.spyOn(globalThis, 'setTimeout');
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const view = render(<Harness client={client} />);
    await waitFor(() => expect(metricsSignal).toBeDefined());
    fireEvent.click(screen.getByRole('button', { name: 'Refresh ops' }));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh ops' }));
    expect(client.getSaleMetrics).toHaveBeenCalledTimes(1);
    expect(client.getReadiness).toHaveBeenCalledTimes(1);
    const timerCallsAtUnmount = timer.mock.calls.length;
    view.unmount();
    expect(metricsSignal?.aborted).toBe(true);
    expect(readinessSignal?.aborted).toBe(true);
    expect(removeListener).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
    await act(async () => {
      heldMetrics.resolve(timed(metric(88)));
      heldReadiness.resolve(timed(ready('late')));
      await Promise.resolve();
    });
    expect(timer.mock.calls).toHaveLength(timerCallsAtUnmount);
    expect(consoleError).not.toHaveBeenCalled();
  });
});
