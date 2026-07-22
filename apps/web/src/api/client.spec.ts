import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiClientError, createApiClient } from './client';

const iso = '2026-07-23T04:00:00.000Z';
const sale = {
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
const response = (body: unknown, status: number, retry = '') =>
  ({
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockResolvedValue(body),
    headers: new Headers(retry ? { 'Retry-After': retry } : {}),
  }) as unknown as Response;

describe('API client', () => {
  afterEach(() => vi.useRealTimers());

  it('normalizes URLs and sends exact methods/body', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(response(sale, 200))
      .mockResolvedValueOnce(
        response(
          {
            status: 'CONFIRMED',
            userId: 'mia',
            saleId: 'sale',
            stockRemaining: 3,
            serverTime: iso,
            serverTimeMs: 1,
          },
          201,
        ),
      );
    const client = createApiClient({ baseUrl: 'http://api.test/api///', fetchImpl });
    await client.getSaleStatus();
    await client.purchase(' mia ');
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('http://api.test/api/sale/status');
    expect(fetchImpl.mock.calls[1]?.[1]).toMatchObject({
      method: 'POST',
      body: JSON.stringify({ userId: 'mia' }),
    });
  });
  it('encodes status identities', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      response(
        {
          userId: 'a@b',
          saleId: 'sale',
          purchased: false,
          order: null,
          serverTime: iso,
          serverTimeMs: 1,
        },
        200,
      ),
    );
    await createApiClient({ baseUrl: 'http://x/api', fetchImpl }).getPurchaseStatus('a@b');
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('http://x/api/purchase/a%40b');
  });
  it('returns safe typed failures', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('secret'));
    const client = createApiClient({ fetchImpl });
    await expect(client.getSaleStatus()).rejects.toEqual(
      expect.objectContaining({ kind: 'network', message: 'The service could not be reached.' }),
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('aborts one GET at the frozen 4,000 ms timeout', async () => {
    vi.useFakeTimers();
    let requestSignal: AbortSignal | undefined;
    const fetchImpl = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => {
      requestSignal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        requestSignal?.addEventListener('abort', () =>
          reject(new DOMException('Aborted', 'AbortError')),
        );
      });
    });
    const pending = createApiClient({ fetchImpl }).getSaleStatus();
    const rejection = expect(pending).rejects.toEqual(expect.objectContaining({ kind: 'timeout' }));
    await vi.advanceTimersByTimeAsync(4000);
    await rejection;
    expect(requestSignal?.aborted).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('propagates one external abort with the safe network contract', async () => {
    const external = new AbortController();
    let requestSignal: AbortSignal | undefined;
    const fetchImpl = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => {
      requestSignal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        requestSignal?.addEventListener('abort', () =>
          reject(new DOMException('Aborted', 'AbortError')),
        );
      });
    });
    const pending = createApiClient({ fetchImpl }).getSaleStatus(external.signal);
    const rejection = expect(pending).rejects.toEqual(
      expect.objectContaining({
        kind: 'network',
        message: 'The service could not be reached.',
      } satisfies Partial<ApiClientError>),
    );
    external.abort('test');
    await rejection;
    expect(requestSignal?.aborted).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('never retries a rejected purchase transport', async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn().mockRejectedValue(new Error('offline'));
    const pending = createApiClient({ fetchImpl }).purchase('mia');
    const rejection = expect(pending).rejects.toEqual(expect.objectContaining({ kind: 'network' }));
    await rejection;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('accepts exactly 201 plus a valid CONFIRMED envelope', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      response(
        {
          status: 'CONFIRMED',
          userId: 'mia',
          saleId: 'sale',
          stockRemaining: 3,
          serverTime: iso,
          serverTimeMs: 1,
        },
        201,
      ),
    );
    await expect(createApiClient({ fetchImpl }).purchase('mia')).resolves.toEqual(
      expect.objectContaining({ data: expect.objectContaining({ status: 'CONFIRMED' }) }),
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([200, 202, 400, 409, 500])(
    'rejects HTTP %i plus valid CONFIRMED as invalid-response',
    async (status) => {
      const fetchImpl = vi.fn().mockResolvedValue(
        response(
          {
            status: 'CONFIRMED',
            userId: 'mia',
            saleId: 'sale',
            stockRemaining: 3,
            serverTime: iso,
            serverTimeMs: 1,
          },
          status,
        ),
      );
      await expect(createApiClient({ fetchImpl }).purchase('mia')).rejects.toEqual(
        expect.objectContaining({ kind: 'invalid-response' }),
      );
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    ['0', 0],
    ['2', 2],
    ['99', 10],
    ['00', 0],
  ])('accepts strict Retry-After %s as %s with one request', async (header, expected) => {
    const fetchImpl = vi.fn().mockResolvedValue(
      response(
        {
          ...sale,
          status: 'RATE_LIMITED',
          userId: 'mia',
          stockRemaining: 4,
        },
        429,
        header,
      ),
    );
    const result = await createApiClient({ fetchImpl }).purchase('mia');
    expect(result.retryAfterSeconds).toBe(expected);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each(['-5', '+2', '2.5', '2junk', '1e2', '999999999999999999999999999999'])(
    'rejects invalid Retry-After %s with one request',
    async (header) => {
      const fetchImpl = vi.fn().mockResolvedValue(
        response(
          {
            ...sale,
            status: 'RATE_LIMITED',
            userId: 'mia',
            stockRemaining: 4,
          },
          429,
          header,
        ),
      );
      const result = await createApiClient({ fetchImpl }).purchase('mia');
      expect(result.retryAfterSeconds).toBeUndefined();
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    },
  );

  it('rejects invalid JSON as one invalid-response request', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockRejectedValue(new SyntaxError('private parser detail')),
      headers: new Headers(),
    } as unknown as Response);
    await expect(createApiClient({ fetchImpl }).getSaleStatus()).rejects.toEqual(
      expect.objectContaining({ kind: 'invalid-response' }),
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('rejects a malformed endpoint payload as one invalid-response request', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response({ ...sale, stockRemaining: 99 }, 200));
    await expect(createApiClient({ fetchImpl }).getSaleStatus()).rejects.toEqual(
      expect.objectContaining({ kind: 'invalid-response' }),
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
