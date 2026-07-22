import '@testing-library/jest-dom/vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiClientError, type ApiClient } from './api/client';
import App from './App';

const now = Date.now();
const iso = new Date(now).toISOString();
const timed = <T,>(data: T) => Promise.resolve({ data, sentAtMs: now, receivedAtMs: now });
const saleData = (overrides: Record<string, unknown> = {}) => ({
  saleId: 'sale',
  name: 'Aurora',
  status: 'active' as const,
  startsAt: new Date(now - 1000).toISOString(),
  endsAt: new Date(now + 60_000).toISOString(),
  startsAtMs: now - 1000,
  endsAtMs: now + 60_000,
  totalStock: 500,
  stockRemaining: 500,
  serverTime: iso,
  serverTimeMs: now,
  ...overrides,
});

function client(outcome = 'CONFIRMED'): ApiClient {
  return {
    getSaleStatus: vi.fn(() => timed(saleData())),
    purchase: vi.fn((userId: string) =>
      timed({
        status: outcome,
        userId,
        saleId: 'sale',
        stockRemaining: outcome === 'CONFIRMED' ? 499 : 500,
        serverTime: iso,
        serverTimeMs: now,
      } as never),
    ),
    getPurchaseStatus: vi.fn((userId: string) =>
      timed({
        userId,
        saleId: 'sale',
        purchased: true,
        order: { status: 'reserved' as const, createdAt: null },
        serverTime: iso,
        serverTimeMs: now,
      }),
    ),
    getSaleMetrics: vi.fn(() =>
      timed({
        saleId: 'sale',
        metrics: {
          confirmed: 1,
          already_purchased: 0,
          sold_out: 0,
          sale_not_active: 0,
          not_initialized: 0,
          rate_limited: 0,
          invalid_user_id: 0,
        },
        serverTime: iso,
        serverTimeMs: now,
      }),
    ),
    getReadiness: vi.fn(() =>
      timed({
        status: 'ok' as const,
        service: 'api' as const,
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
        serverTimeMs: now,
      }),
    ),
  };
}

describe('Aurora app', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    );
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
  it('validates without a request and renders 50 proportional segments', async () => {
    const api = client();
    render(<App client={api} />);
    await screen.findByRole('button', { name: 'Secure your card' });
    fireEvent.change(screen.getByRole('textbox', { name: 'Email or username' }), {
      target: { value: 'x' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Secure your card' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Enter 3–64');
    expect(api.purchase).not.toHaveBeenCalled();
    expect(document.querySelectorAll('.ticks i')).toHaveLength(50);
  });
  it('does not confirm before the server and blocks double submit', async () => {
    let resolve!: (value: Awaited<ReturnType<ApiClient['purchase']>>) => void;
    const api = client();
    vi.mocked(api.purchase).mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    render(<App client={api} />);
    const user = userEvent.setup();
    await screen.findByRole('button', { name: 'Secure your card' });
    await user.type(screen.getByRole('textbox'), 'mia@example.com');
    const button = screen.getByRole('button', { name: 'Secure your card' });
    fireEvent.submit(button.closest('form')!);
    fireEvent.submit(button.closest('form')!);
    expect(api.purchase).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Card secured')).not.toBeInTheDocument();
    resolve(
      await timed({
        status: 'CONFIRMED',
        userId: 'mia@example.com',
        saleId: 'sale',
        stockRemaining: 499,
        serverTime: iso,
        serverTimeMs: now,
      }),
    );
    expect(await screen.findByText('Card secured')).toBeVisible();
  });
  it.each([
    ['ALREADY_PURCHASED', 'You already hold a reservation'],
    ['SOLD_OUT', 'Sold out'],
    ['SALE_NOT_STARTED', 'Not open yet'],
    ['SALE_ENDED', 'This drop is closed'],
    ['NOT_INITIALIZED', 'Sale temporarily unavailable'],
    ['INVALID_USER_ID', 'Check your identifier'],
    ['RATE_LIMITED', 'Too many attempts'],
    ['UPSTREAM_UNAVAILABLE', 'Service temporarily unavailable'],
  ])('renders %s with explicit text', async (outcome, heading) => {
    const api = client(outcome);
    render(<App client={api} />);
    await screen.findByRole('button', { name: 'Secure your card' });
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'mia@example.com' } });
    fireEvent.submit(screen.getByRole('textbox').closest('form')!);
    await waitFor(() => expect(screen.getByText(heading)).toBeVisible());
  });
  it.each([
    ['network', new ApiClientError('network', 'offline'), 'Result unknown'],
    ['timeout', new ApiClientError('timeout', 'late'), 'Result unknown'],
    [
      'invalid-response',
      new ApiClientError('invalid-response', 'bad payload'),
      'We could not verify the result',
    ],
    ['http', new ApiClientError('http', 'server replied'), 'We could not verify the result'],
    ['unexpected Error', new Error('private detail'), 'We could not verify the result'],
  ])('maps rejected POST %s to exact safe feedback', async (_case, failure, heading) => {
    const api = client();
    vi.mocked(api.purchase).mockRejectedValue(failure);
    render(<App client={api} />);
    await screen.findByRole('button', { name: 'Secure your card' });
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'mia@example.com' } });
    fireEvent.submit(input.closest('form')!);
    expect(await screen.findByText(heading)).toBeVisible();
    expect(input).toHaveValue('mia@example.com');
    expect(screen.getByRole('button', { name: 'Check my status' })).toBeEnabled();
    expect(screen.queryByText('Card secured')).not.toBeInTheDocument();
    expect(api.purchase).toHaveBeenCalledTimes(1);
  });
  it('StrictMode cleanup permits a fresh poll without stale-flight clobbering', async () => {
    const api = client();
    const fresh = vi.mocked(api.getSaleStatus).getMockImplementation()!;
    vi.mocked(api.getSaleStatus)
      .mockImplementationOnce(() => new Promise(() => undefined))
      .mockImplementation(fresh);
    const view = render(
      <StrictMode>
        <App client={api} />
      </StrictMode>,
    );
    await waitFor(() => expect(api.getSaleStatus).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole('button', { name: 'Secure your card' })).toBeEnabled();
    view.unmount();
  });

  it.each([
    [
      'upcoming before startsAt',
      { startsAtMs: now + 1, startsAt: new Date(now + 1).toISOString() },
      'Upcoming',
      'Opens soon',
    ],
    [
      'active exactly at startsAt',
      { startsAtMs: now, startsAt: new Date(now).toISOString() },
      'Live now',
      'Secure your card',
    ],
    [
      'active one millisecond before endsAt',
      { endsAtMs: now + 1, endsAt: new Date(now + 1).toISOString() },
      'Live now',
      'Secure your card',
    ],
    [
      'ended exactly at endsAt',
      { endsAtMs: now, endsAt: new Date(now).toISOString() },
      'Ended',
      'Sale ended',
    ],
  ])('renders loading then the half-open boundary: %s', async (_case, overrides, pill, button) => {
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const api = client();
    let release!: (value: Awaited<ReturnType<ApiClient['getSaleStatus']>>) => void;
    vi.mocked(api.getSaleStatus).mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    render(<App client={api} />);
    expect(screen.getByText('Loading')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Loading sale…' })).toBeDisabled();
    await act(async () => release(await timed(saleData(overrides))));
    expect(await screen.findByText(pill)).toBeVisible();
    const control = screen.getByRole('button', { name: button });
    expect(control).toHaveProperty('disabled', button !== 'Secure your card');
  });

  it('retains last-good stock and prevents overlapping recovery requests', async () => {
    vi.useFakeTimers();
    const api = client();
    let inFlight = 0;
    let maximumInFlight = 0;
    let releaseRecovery!: (value: Awaited<ReturnType<ApiClient['getSaleStatus']>>) => void;
    vi.mocked(api.getSaleStatus)
      .mockResolvedValueOnce(await timed(saleData({ stockRemaining: 321 })))
      .mockRejectedValueOnce(new ApiClientError('network', 'offline'))
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            inFlight += 1;
            maximumInFlight = Math.max(maximumInFlight, inFlight);
            releaseRecovery = (value) => {
              inFlight -= 1;
              resolve(value);
            };
          }),
      )
      .mockImplementation(() => timed(saleData({ stockRemaining: 123 })));
    render(<App client={api} />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByText('321 / 500 remaining')).toBeVisible();
    await act(async () => vi.advanceTimersByTimeAsync(3000));
    expect(screen.getByRole('alert')).toHaveTextContent('temporarily unreachable');
    expect(screen.getByText('321 / 500 remaining')).toBeVisible();
    const retry = screen.getByRole('button', { name: 'Retry' });
    fireEvent.click(retry);
    fireEvent.click(retry);
    expect(maximumInFlight).toBe(1);
    await act(async () => {
      releaseRecovery(await timed(saleData({ stockRemaining: 123 })));
      await Promise.resolve();
    });
    expect(screen.getByText('123 / 500 remaining')).toBeVisible();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it.each([
    [
      'reserved',
      { purchased: true, order: { status: 'reserved' as const, createdAt: null } },
      'Reservation found — reserved and waiting for durable persistence.',
    ],
    [
      'persisted',
      { purchased: true, order: { status: 'persisted' as const, createdAt: iso } },
      'Reservation found — persisted to the permanent record.',
    ],
    [
      'compensated',
      { purchased: false, order: { status: 'compensated' as const, createdAt: null } },
      'Reservation released — persistence failed safely and the stock was returned. You may try again.',
    ],
    ['absent', { purchased: false, order: null }, 'No reservation found for mia@example.com.'],
  ])('renders exact purchase-status branch: %s', async (_case, status, copy) => {
    const api = client();
    vi.mocked(api.getPurchaseStatus).mockImplementation((userId) =>
      timed({
        userId,
        saleId: 'sale',
        ...status,
        serverTime: iso,
        serverTimeMs: now,
      } as never),
    );
    render(<App client={api} />);
    await screen.findByRole('button', { name: 'Secure your card' });
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'mia@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Check my status' }));
    const result = await screen.findByText(new RegExp(copy.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    expect(result).toBeVisible();
    if (_case === 'persisted') expect(result).toHaveTextContent('Created');
    if (_case === 'absent') expect(result).toHaveTextContent('mia@example.com');
  });

  it('renders the safe status-request failure copy', async () => {
    const api = client();
    vi.mocked(api.getPurchaseStatus).mockRejectedValue(new ApiClientError('network', 'offline'));
    render(<App client={api} />);
    await screen.findByRole('button', { name: 'Secure your card' });
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'mia@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Check my status' }));
    expect(
      await screen.findByText('Reservation status is temporarily unavailable. Try again.'),
    ).toBeVisible();
  });

  it('aborts lookup A on edit and renders only a later B-correlated result', async () => {
    const api = client();
    let signalA: AbortSignal | undefined;
    let resolveA!: (value: Awaited<ReturnType<ApiClient['getPurchaseStatus']>>) => void;
    vi.mocked(api.getPurchaseStatus)
      .mockImplementationOnce((_userId, signal) => {
        signalA = signal;
        return new Promise((resolve) => {
          resolveA = resolve;
        });
      })
      .mockImplementationOnce((userId) =>
        timed({
          userId,
          saleId: 'sale',
          purchased: false,
          order: null,
          serverTime: iso,
          serverTimeMs: now,
        }),
      );
    render(<App client={api} />);
    await screen.findByRole('button', { name: 'Secure your card' });
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'alice@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Check my status' }));
    await waitFor(() => expect(signalA).toBeDefined());
    fireEvent.change(input, { target: { value: 'bob@example.com' } });
    expect(signalA?.aborted).toBe(true);
    expect(screen.queryByText(/Reservation found|No reservation found/)).not.toBeInTheDocument();
    await act(async () => {
      resolveA(
        await timed({
          userId: 'alice@example.com',
          saleId: 'sale',
          purchased: true,
          order: { status: 'reserved', createdAt: null },
          serverTime: iso,
          serverTimeMs: now,
        }),
      );
    });
    fireEvent.click(screen.getByRole('button', { name: 'Check my status' }));
    expect(await screen.findByText(/No reservation found for bob@example\.com/)).toBeVisible();
    expect(screen.queryByText(/alice@example\.com/)).not.toBeInTheDocument();
  });

  it('keeps B visible when invalidated lookup A settles last', async () => {
    const api = client();
    let resolveA!: (value: Awaited<ReturnType<ApiClient['getPurchaseStatus']>>) => void;
    let resolveB!: (value: Awaited<ReturnType<ApiClient['getPurchaseStatus']>>) => void;
    vi.mocked(api.getPurchaseStatus)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveA = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveB = resolve;
          }),
      );
    render(<App client={api} />);
    await screen.findByRole('button', { name: 'Secure your card' });
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'alice@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Check my status' }));
    fireEvent.change(input, { target: { value: 'bob@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Check my status' }));
    await act(async () => {
      resolveB(
        await timed({
          userId: 'bob@example.com',
          saleId: 'sale',
          purchased: true,
          order: { status: 'reserved', createdAt: null },
          serverTime: iso,
          serverTimeMs: now,
        }),
      );
    });
    expect(
      await screen.findByText('Reservation found — reserved and waiting for durable persistence.'),
    ).toBeVisible();
    await act(async () => {
      resolveA(
        await timed({
          userId: 'alice@example.com',
          saleId: 'sale',
          purchased: false,
          order: null,
          serverTime: iso,
          serverTimeMs: now,
        }),
      );
    });
    expect(
      screen.getByText('Reservation found — reserved and waiting for durable persistence.'),
    ).toBeVisible();
    expect(screen.getByRole('button', { name: 'Check my status' })).toBeEnabled();
  });

  it('rejects mismatched status identity and aborts owned lookup on unmount', async () => {
    const api = client();
    vi.mocked(api.getPurchaseStatus).mockImplementationOnce(() =>
      timed({
        userId: 'other@example.com',
        saleId: 'sale',
        purchased: true,
        order: { status: 'reserved', createdAt: null },
        serverTime: iso,
        serverTimeMs: now,
      }),
    );
    const view = render(<App client={api} />);
    await screen.findByRole('button', { name: 'Secure your card' });
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'mia@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Check my status' }));
    expect(
      await screen.findByText('Reservation status is temporarily unavailable. Try again.'),
    ).toBeVisible();
    expect(screen.queryByText(/other@example\.com|reserved and waiting/)).not.toBeInTheDocument();

    let ownedSignal: AbortSignal | undefined;
    let settle!: (value: Awaited<ReturnType<ApiClient['getPurchaseStatus']>>) => void;
    vi.mocked(api.getPurchaseStatus).mockImplementationOnce((_userId, signal) => {
      ownedSignal = signal;
      return new Promise((resolve) => {
        settle = resolve;
      });
    });
    fireEvent.change(input, { target: { value: 'later@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Check my status' }));
    await waitFor(() => expect(ownedSignal).toBeDefined());
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    view.unmount();
    expect(ownedSignal?.aborted).toBe(true);
    await act(async () => {
      settle(
        await timed({
          userId: 'later@example.com',
          saleId: 'sale',
          purchased: false,
          order: null,
          serverTime: iso,
          serverTimeMs: now,
        }),
      );
    });
    expect(consoleError).not.toHaveBeenCalled();
  });

  it.each([
    ['one tick per card', 50, 50, 50, '50 / 50 remaining'],
    ['zero total', 0, 0, 0, '0 / 0 remaining'],
  ])(
    'renders stock-meter edge: %s',
    async (_case, totalStock, stockRemaining, segmentCount, label) => {
      const api = client();
      vi.mocked(api.getSaleStatus).mockResolvedValue(
        await timed(saleData({ totalStock, stockRemaining })),
      );
      render(<App client={api} />);
      expect(await screen.findByText(label)).toBeVisible();
      expect(document.querySelectorAll('.ticks i')).toHaveLength(segmentCount);
      expect(screen.getByText(`${stockRemaining} of ${totalStock} remaining`)).toBeInTheDocument();
    },
  );
});
