// apps/api/test/integration/security.integration.spec.ts  [SLICE E]
// Contract §10 — the spec the security reviewer reviews against. §11.9.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type AppHarness, bootHarness } from '../support/app-harness.js';
import { closeHttpAgent, get, post } from '../support/http.js';
import { seedSale } from '../support/seed.js';

interface ApiErrorBody {
  error: string;
  message: string;
  requestId: string;
  serverTime: string;
  serverTimeMs: number;
}

describe('Security surface (contract §10)', () => {
  let harness: AppHarness;

  beforeEach(async () => {
    harness = await bootHarness();
    await seedSale(harness.store, { saleId: harness.saleId, stock: 5 });
  });

  afterEach(async () => {
    await harness.close();
  });

  afterAll(async () => {
    await closeHttpAgent();
  });

  it('unknown route -> 404 with an ApiErrorResponse whose key set is exactly the frozen five', async () => {
    const res = await get<ApiErrorBody>(`${harness.baseUrl}/api/does-not-exist`);

    expect(res.status).toBe(404);
    expect(Object.keys(res.body).sort()).toEqual(
      ['error', 'message', 'requestId', 'serverTime', 'serverTimeMs'].sort(),
    );
    // Nest's default error body must never leak through.
    expect(res.body).not.toHaveProperty('statusCode');
  });

  it('422 body userId echo is truncated/stripped — no <script>, no reflection vector', async () => {
    const malicious = `<script>alert(1)</script>${'a'.repeat(5000)}`;
    const res = await post<{ userId: string }>(`${harness.baseUrl}/api/purchase`, {
      body: { userId: malicious },
    });

    expect(res.status).toBe(422);
    expect(res.body.userId.length).toBeLessThanOrEqual(64);
    expect(res.body.userId).not.toMatch(/[<>/]/);
  });

  it('response headers include the hardened set and omit x-powered-by', async () => {
    const res = await get(`${harness.baseUrl}/api/sale/status`);

    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('inbound malicious x-request-id is rejected and replaced with a UUID matching REQUEST_ID_PATTERN', async () => {
    // NOTE: a raw CRLF (`\n`) inside a header value is rejected by undici's own
    // HTTP client before the request is ever sent (RFC 7230 CRLF-injection
    // guard at the transport layer) — that guard is real and correct, but it
    // means this spec cannot literally put "\n\ninjected" on the wire to prove
    // the API's OWN defense. `../../etc/passwd` alone is already outside
    // REQUEST_ID_PATTERN (`^[A-Za-z0-9_-]{1,64}$` has no `.` or `/`), so it
    // still proves the server-side rejection-and-replacement this spec exists
    // to check, without depending on a transport bug/quirk to get there.
    const malicious = '../../etc/passwd';
    const res = await get(`${harness.baseUrl}/api/sale/status`, {
      headers: { 'x-request-id': malicious },
    });

    const echoed = res.headers['x-request-id'];
    expect(typeof echoed).toBe('string');
    expect(echoed as string).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    expect(echoed).not.toBe(malicious);
  });

  it('a valid inbound x-request-id IS echoed verbatim', async () => {
    const validId = 'test-request-id-123';
    const res = await get(`${harness.baseUrl}/api/sale/status`, {
      headers: { 'x-request-id': validId },
    });

    expect(res.headers['x-request-id']).toBe(validId);
  });

  it('CORS: Origin: https://evil.example receives no access-control-allow-origin header', async () => {
    const res = await get(`${harness.baseUrl}/api/sale/status`, {
      headers: { origin: 'https://evil.example' },
    });

    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('CORS: the configured CORS_ORIGIN DOES receive the allow-origin header', async () => {
    const res = await get(`${harness.baseUrl}/api/sale/status`, {
      headers: { origin: 'http://localhost:5173' },
    });

    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173');
  });

  it('an internal error never leaks a stack, "redis", "ECONNREFUSED", or a file path in the body', async () => {
    // Force a genuine awaited hot-path failure without disconnecting a shared live
    // client. The filter must catch it and never relay the dependency detail.
    const { SALE_REDIS_STORE } =
      (await import('../../src/common/tokens.js')) as typeof import('../../src/common/tokens.js');
    const appStore = harness.get<import('@flash/redis').SaleRedisStore>(SALE_REDIS_STORE);
    vi.spyOn(appStore, 'purchase').mockRejectedValue(
      new Error('redis ECONNREFUSED /home/private/internal.ts'),
    );

    const res = await post<Record<string, unknown>>(`${harness.baseUrl}/api/purchase`, {
      body: { userId: 'internal-error-probe-2026' },
    });

    const raw = JSON.stringify(res.body);
    expect(raw).not.toMatch(/at\s+\S+\s+\(.*:\d+:\d+\)/); // stack trace frame shape
    expect(raw.toLowerCase()).not.toContain('redis');
    expect(raw).not.toContain('ECONNREFUSED');
    expect(raw).not.toMatch(/\/(home|usr|var)\//);
  });
});
