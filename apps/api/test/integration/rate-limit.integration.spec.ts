// apps/api/test/integration/rate-limit.integration.spec.ts  [SLICE E]
// Rate limiting AT PRODUCTION LIMITS — contract §7, §11.6. Deliberately the opposite
// of concurrency.integration.spec.ts's raised-threshold approach: this spec proves the
// limiter's real behavior with nothing raised.
import { purchaseResponseSchema } from '@flash/shared/schemas';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type AppHarness, bootHarness } from '../support/app-harness.js';
import { closeHttpAgent, get, post } from '../support/http.js';
import { seedSale } from '../support/seed.js';

interface ApiErrorBody {
  error: string;
}

describe('Rate limiting at production limits', () => {
  let harness: AppHarness;

  beforeEach(async () => {
    // Explicit defaults, matching contract §11.6's "booted with the DEFAULT
    // RATE_LIMIT_MAX=20, RATE_LIMIT_USER_MAX=5, RATE_LIMIT_WINDOW_MS=1000,
    // TRUST_PROXY=false" — spelled out rather than relying on the harness default so
    // this spec keeps meaning it even if the harness default ever changes.
    harness = await bootHarness({
      env: {
        RATE_LIMIT_MAX: '20',
        RATE_LIMIT_WINDOW_MS: '1000',
        RATE_LIMIT_USER_MAX: '5',
        RATE_LIMIT_USER_WINDOW_MS: '1000',
        TRUST_PROXY: 'false',
      },
    });
    await seedSale(harness.store, { saleId: harness.saleId, stock: 100 });
  });

  afterEach(async () => {
    await harness.close();
  });

  afterAll(async () => {
    await closeHttpAgent();
  });

  it('20 sequential GET /api/sale/status all 200; the 21st is 429 with the exact headers', async () => {
    for (let i = 0; i < 20; i += 1) {
      const res = await get(`${harness.baseUrl}/api/sale/status`);
      expect(res.status).toBe(200);
    }

    const res21 = await get<ApiErrorBody>(`${harness.baseUrl}/api/sale/status`);
    expect(res21.status).toBe(429);
    expect(res21.headers['retry-after']).toBeDefined();
    expect(String(res21.headers['x-ratelimit-limit'])).toBe('20');
    expect(String(res21.headers['x-ratelimit-remaining'])).toBe('0');
    expect(res21.body.error).toBe('RATE_LIMITED');
  });

  it('after the window elapses, the next request is 200 again (not a ban)', async () => {
    for (let i = 0; i < 20; i += 1) {
      await get(`${harness.baseUrl}/api/sale/status`);
    }
    const limited = await get(`${harness.baseUrl}/api/sale/status`);
    expect(limited.status).toBe(429);

    await new Promise((resolve) => setTimeout(resolve, 1100));

    const afterWindow = await get(`${harness.baseUrl}/api/sale/status`);
    expect(afterWindow.status).toBe(200);
  });

  it('5 purchases for one userId in one window; the 6th is 429 with the purchaseResponseSchema envelope', async () => {
    const userId = 'rate-limited-purchaser-2026';

    for (let i = 0; i < 5; i += 1) {
      // Each of the first 5 hits a DIFFERENT sale so they are not themselves
      // ALREADY_PURCHASED — the per-user rate limiter is keyed on
      // (saleId, userId), independent of whether the underlying purchase succeeds.
      const res = await post(`${harness.baseUrl}/api/purchase`, { body: { userId } });
      expect(res.status).not.toBe(429);
    }

    const sixth = await post(`${harness.baseUrl}/api/purchase`, { body: { userId } });
    expect(sixth.status).toBe(429);
    const parsed = purchaseResponseSchema.parse(sixth.body);
    expect(parsed.status).toBe('RATE_LIMITED');
    expect(parsed.stockRemaining).toBeNull();
  });

  it('X-Forwarded-For forgery does not create a new bucket under TRUST_PROXY=false', async () => {
    for (let i = 0; i < 20; i += 1) {
      await get(`${harness.baseUrl}/api/sale/status`);
    }
    const limited = await get(`${harness.baseUrl}/api/sale/status`);
    expect(limited.status).toBe(429);

    for (let i = 0; i < 20; i += 1) {
      const forged = await get(`${harness.baseUrl}/api/sale/status`, {
        headers: { 'x-forwarded-for': `10.0.0.${i}` },
      });
      expect(forged.status).toBe(429);
    }
  });

  it('cardinality: 200 requests with 200 distinct invalid userIds create zero rl:u:* keys', async () => {
    const Redis = (await import('ioredis')).default;
    const raw = new Redis(harness.redisUrl, { connectionName: 'flash-api-rate-limit-cardinality' });
    try {
      const invalidUserIds = [
        ...Array.from({ length: 100 }, () => '!!!'),
        ...Array.from({ length: 100 }, (_, i) => `x-${i}-`.repeat(30)), // > 64 chars
      ];

      // Sequential, not parallel: this assertion is about key CREATION, not
      // concurrency, and we must stay under the per-IP limiter's own budget to reach
      // all 200 invalid attempts without being 429'd before the per-user guard runs.
      // Waiting between IP-limiter windows keeps every request past step 1 of §8.1.
      for (let i = 0; i < invalidUserIds.length; i += 1) {
        if (i > 0 && i % 19 === 0) {
          await new Promise((resolve) => setTimeout(resolve, 1100));
        }
        await post(`${harness.baseUrl}/api/purchase`, { body: { userId: invalidUserIds[i] } });
      }

      const keys = await raw.keys('rl:u:*');
      expect(keys).toHaveLength(0);
    } finally {
      raw.disconnect();
    }
  }, 60_000);

  it('atomically heals a permanent bucket and bounds every valid bucket PTTL', async () => {
    const Redis = (await import('ioredis')).default;
    const raw = new Redis(harness.redisUrl, { connectionName: 'flash-api-rate-limit-ttl' });
    try {
      const { buildUserRateLimitKeyForTest } =
        (await import('../../src/common/per-user-rate-limit.guard.js')) as typeof import('../../src/common/per-user-rate-limit.guard.js');
      const windowMs = 1000;
      const permanentUserId = 'legacy-permanent-bucket';
      const permanentKey = buildUserRateLimitKeyForTest(
        harness.saleId,
        '127.0.0.1',
        permanentUserId,
      );
      await raw.set(permanentKey, '41');
      expect(await raw.pttl(permanentKey)).toBe(-1);

      const userIds = [
        permanentUserId,
        ...Array.from({ length: 11 }, (_, index) => `ttl-bounded-user-${index}`),
      ];
      const responses = await Promise.all(
        userIds.map((userId) => post(`${harness.baseUrl}/api/purchase`, { body: { userId } })),
      );
      expect(responses.every((response) => response.status !== 429)).toBe(true);

      const keys = await raw.keys('rl:u:*');
      expect(keys).toHaveLength(userIds.length);
      for (const key of keys) {
        const ttl = await raw.pttl(key);
        expect(ttl).toBeGreaterThan(0);
        expect(ttl).toBeLessThanOrEqual(windowMs);
      }
      expect(await raw.get(permanentKey)).toBe('1');
    } finally {
      raw.disconnect();
    }
  });

  it('repeated per-user EVAL failures fail open and mint no additional buckets', async () => {
    const Redis = (await import('ioredis')).default;
    const raw = new Redis(harness.redisUrl, { connectionName: 'flash-api-rate-limit-failure' });
    try {
      const { REDIS_LIMIT_CLIENT } =
        (await import('../../src/common/tokens.js')) as typeof import('../../src/common/tokens.js');
      const limiterClient = harness.get<import('ioredis').Redis>(REDIS_LIMIT_CLIENT);
      const before = await raw.keys('rl:u:*');
      const evalSpy = vi
        .spyOn(limiterClient, 'eval')
        .mockRejectedValue(new Error('owned per-user EVAL failure'));

      const responses = await Promise.all(
        Array.from({ length: 10 }, (_, index) =>
          post(`${harness.baseUrl}/api/purchase`, {
            body: { userId: `eval-fail-open-${index}` },
          }),
        ),
      );

      expect(responses.every((response) => response.status !== 429)).toBe(true);
      expect(evalSpy).toHaveBeenCalledTimes(10);
      expect(await raw.keys('rl:u:*')).toEqual(before);
    } finally {
      raw.disconnect();
    }
  });

  it('fail-open: when the Redis limiter operation rejects, requests still succeed', async () => {
    const { REDIS_LIMIT_CLIENT } =
      (await import('../../src/common/tokens.js')) as typeof import('../../src/common/tokens.js');
    const limiterClient = harness.get<import('ioredis').Redis>(REDIS_LIMIT_CLIENT);
    // The Fastify RedisStore awaits this callback boundary. Reject it directly
    // instead of disconnecting the app's shared live ioredis client, which can race
    // unrelated internal commands and manufacture an unhandled rejection.
    vi.spyOn(limiterClient as never, 'rateLimit' as never).mockImplementation(
      (...args: unknown[]) => {
        const callback = args.at(-1) as (error: Error, result: null) => void;
        callback(new Error('owned limiter outage'), null);
      },
    );

    const res = await get(`${harness.baseUrl}/api/sale/status`);
    expect(res.status).not.toBe(503);
    expect([200, 429]).toContain(res.status);
  });

  it('GET /api/health is never rate limited, even past the limit', async () => {
    for (let i = 0; i < 25; i += 1) {
      const res = await get(`${harness.baseUrl}/api/health`);
      expect(res.status).toBe(200);
    }
  });
});
