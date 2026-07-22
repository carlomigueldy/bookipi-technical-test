import type { ExecutionContext } from '@nestjs/common';
import { HttpException, Logger } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildUserRateLimitKeyForTest,
  extractRateLimitCandidateUserId,
  PerUserRateLimitGuard,
  RATE_LIMIT_USER_SCRIPT,
  type PerUserRateLimitEnv,
  type RedisLimiterClient,
} from './per-user-rate-limit.guard.js';

class FakeRedisLimiterClient implements RedisLimiterClient {
  private readonly store = new Map<string, { count: number; expiresAtMs: number | null }>();
  readonly evalCalls: Array<[string, number, string, string]> = [];
  nowMs = Date.now();

  async eval(
    script: string,
    numberOfKeys: number,
    key: string,
    windowMsRaw: string,
  ): Promise<unknown> {
    this.evalCalls.push([script, numberOfKeys, key, windowMsRaw]);
    const windowMs = Number(windowMsRaw);
    const existing = this.store.get(key);
    const ttl = existing?.expiresAtMs === null ? -1 : (existing?.expiresAtMs ?? 0) - this.nowMs;

    if (!existing || ttl <= 0) {
      this.store.set(key, { count: 1, expiresAtMs: this.nowMs + windowMs });
      return [1, windowMs];
    }

    existing.count += 1;
    return [existing.count, ttl];
  }

  keys(): string[] {
    return [...this.store.keys()];
  }

  ttl(key: string): number {
    const expiresAtMs = this.store.get(key)?.expiresAtMs;
    if (expiresAtMs === null) return -1;
    if (expiresAtMs === undefined) return -2;
    return expiresAtMs - this.nowMs;
  }

  seedPermanent(key: string, count: number): void {
    this.store.set(key, { count, expiresAtMs: null });
  }
}

function fakeExecutionContext(
  body: unknown,
  ip = '127.0.0.1',
): { context: ExecutionContext; headers: Map<string, string> } {
  const headers = new Map<string, string>();
  const reply = {
    header(name: string, value: string) {
      headers.set(name, value);
      return reply;
    },
  };
  const context = {
    switchToHttp: () => ({
      getRequest: () => ({ body, ip }),
      getResponse: () => reply,
    }),
  } as unknown as ExecutionContext;
  return { context, headers };
}

const ENV: PerUserRateLimitEnv = {
  SALE_ID: 'flash-2026',
  RATE_LIMIT_USER_MAX: 5,
  RATE_LIMIT_USER_WINDOW_MS: 1000,
};

function makeGuard(
  redis: RedisLimiterClient,
  env: PerUserRateLimitEnv = ENV,
): PerUserRateLimitGuard {
  return new PerUserRateLimitGuard(redis, env);
}

describe('extractRateLimitCandidateUserId', () => {
  it('returns null for missing, malformed, or schema-implausible identities', () => {
    for (const body of [
      undefined,
      null,
      'not-an-object',
      {},
      { userId: 123 },
      { userId: '' },
      { userId: 'ab' },
      { userId: 'a'.repeat(65) },
      { userId: 'bad char' },
      { userId: '<script>' },
    ]) {
      expect(extractRateLimitCandidateUserId(body)).toBeNull();
    }
  });

  it('trims a plausible identity before returning it', () => {
    expect(extractRateLimitCandidateUserId({ userId: '  alice-01  ' })).toBe('alice-01');
  });
});

describe('PerUserRateLimitGuard', () => {
  let redis: FakeRedisLimiterClient;

  beforeEach(() => {
    redis = new FakeRedisLimiterClient();
  });

  it('performs zero Redis I/O for invalid identities, bounding key cardinality', async () => {
    const guard = makeGuard(redis);
    for (let index = 0; index < 500; index += 1) {
      const body = { userId: index % 2 === 0 ? `bad user ${index}` : 'x'.repeat(200 + index) };
      await expect(guard.canActivate(fakeExecutionContext(body).context)).resolves.toBe(true);
    }
    expect(redis.evalCalls).toHaveLength(0);
    expect(redis.keys()).toHaveLength(0);
  });

  it('uses exactly one EVAL call with one key and the window as its only argument', async () => {
    const guard = makeGuard(redis);
    const key = buildUserRateLimitKeyForTest(ENV.SALE_ID, '127.0.0.1', 'alice');

    await expect(
      guard.canActivate(fakeExecutionContext({ userId: 'alice' }).context),
    ).resolves.toBe(true);

    expect(redis.evalCalls).toEqual([[RATE_LIMIT_USER_SCRIPT, 1, key, '1000']]);
  });

  it('creates a missing key at count 1 with a finite full-window TTL', async () => {
    const key = buildUserRateLimitKeyForTest(ENV.SALE_ID, '127.0.0.1', 'alice');
    await makeGuard(redis).canActivate(fakeExecutionContext({ userId: 'alice' }).context);
    expect(redis.ttl(key)).toBe(ENV.RATE_LIMIT_USER_WINDOW_MS);
  });

  it('self-heals a permanent legacy key by resetting count to 1 with a finite TTL', async () => {
    const key = buildUserRateLimitKeyForTest(ENV.SALE_ID, '127.0.0.1', 'alice');
    redis.seedPermanent(key, 999);

    await expect(
      makeGuard(redis).canActivate(fakeExecutionContext({ userId: 'alice' }).context),
    ).resolves.toBe(true);
    expect(redis.ttl(key)).toBe(ENV.RATE_LIMIT_USER_WINDOW_MS);
  });

  it('increments an existing key without extending its original fixed window', async () => {
    const guard = makeGuard(redis);
    const context = fakeExecutionContext({ userId: 'alice' }).context;
    const key = buildUserRateLimitKeyForTest(ENV.SALE_ID, '127.0.0.1', 'alice');
    await guard.canActivate(context);
    redis.nowMs += 200;
    await guard.canActivate(context);
    expect(redis.ttl(key)).toBe(800);
  });

  it('resets the counter after the fixed window expires', async () => {
    const guard = makeGuard(redis);
    const context = fakeExecutionContext({ userId: 'alice' }).context;
    for (let index = 0; index < ENV.RATE_LIMIT_USER_MAX; index += 1)
      await guard.canActivate(context);
    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(HttpException);
    redis.nowMs += ENV.RATE_LIMIT_USER_WINDOW_MS + 1;
    await expect(guard.canActivate(context)).resolves.toBe(true);
  });

  it('returns 429 with headers derived from the TTL returned by EVAL', async () => {
    const redisReply: RedisLimiterClient = { eval: vi.fn().mockResolvedValue([6, 321]) };
    const { context, headers } = fakeExecutionContext({ userId: 'alice' });

    await expect(makeGuard(redisReply).canActivate(context)).rejects.toMatchObject({
      status: 429,
      response: { outcome: 'RATE_LIMITED', userId: 'alice' },
    });
    expect(headers).toEqual(
      new Map([
        ['retry-after', '1'],
        ['x-ratelimit-limit', '5'],
        ['x-ratelimit-remaining', '0'],
        ['x-ratelimit-reset', '1'],
      ]),
    );
    expect(redisReply.eval).toHaveBeenCalledTimes(1);
  });

  it('scopes identical userIds into independent source-IP buckets', async () => {
    const guard = makeGuard(redis);
    await guard.canActivate(fakeExecutionContext({ userId: 'victim' }, '10.0.0.1').context);
    await guard.canActivate(fakeExecutionContext({ userId: 'victim' }, '203.0.113.7').context);
    expect(redis.keys().sort()).toEqual(
      [
        buildUserRateLimitKeyForTest(ENV.SALE_ID, '10.0.0.1', 'victim'),
        buildUserRateLimitKeyForTest(ENV.SALE_ID, '203.0.113.7', 'victim'),
      ].sort(),
    );
  });

  it.each([null, [], [1], [1, 1000, 7], ['not-a-count', 1000], [1, 'not-a-ttl'], [1, 0]])(
    'fails open and logs once for malformed EVAL reply %#',
    async (malformedReply) => {
      const warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const client: RedisLimiterClient = { eval: vi.fn().mockResolvedValue(malformedReply) };

      await expect(
        makeGuard(client).canActivate(fakeExecutionContext({ userId: 'alice' }).context),
      ).resolves.toBe(true);
      expect(warnSpy).toHaveBeenCalledOnce();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'ratelimit.store_unavailable' }),
      );
      warnSpy.mockRestore();
    },
  );

  it('fails open on a rejected EVAL without retrying or issuing fallback writes', async () => {
    const warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const evalMock = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const pipelineMock = vi.fn();
    const pexpireMock = vi.fn();
    const client = { eval: evalMock, pipeline: pipelineMock, pexpire: pexpireMock };

    await expect(
      makeGuard(client).canActivate(fakeExecutionContext({ userId: 'alice' }).context),
    ).resolves.toBe(true);
    expect(evalMock).toHaveBeenCalledOnce();
    expect(pipelineMock).not.toHaveBeenCalled();
    expect(pexpireMock).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'ratelimit.store_unavailable' }),
    );
    warnSpy.mockRestore();
  });
});
