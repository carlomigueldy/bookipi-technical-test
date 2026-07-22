import {
  HttpException,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
  type ArgumentsHost,
} from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ApiEnv } from '../config/env.js';
import type { Clock } from '../infra/clock.service.js';
import { HttpExceptionFilter } from './http-exception.filter.js';

const FIXED_NOW_MS = Date.parse('2026-07-22T12:00:05.000Z');

function buildEnv(overrides: Partial<ApiEnv> = {}): ApiEnv {
  return {
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent' as ApiEnv['LOG_LEVEL'],
    API_HOST: '127.0.0.1',
    API_PORT: 0,
    CORS_ORIGIN: 'http://localhost:5173',
    DATABASE_URL: 'postgresql://flash:flash@localhost:5433/flash',
    REDIS_URL: 'redis://localhost:6380',
    SALE_ID: 'flash-2026',
    SALE_NAME: 'Aurora',
    SALE_STARTS_AT: '2026-07-22T12:00:00.000Z',
    SALE_ENDS_AT: '2026-07-22T13:00:00.000Z',
    SALE_TOTAL_STOCK: 500,
    RATE_LIMIT_MAX: 20,
    RATE_LIMIT_WINDOW_MS: 1000,
    ORDERS_QUEUE_NAME: 'orders',
    TRUST_PROXY: false,
    REQUEST_BODY_LIMIT_BYTES: 16384,
    RATE_LIMIT_USER_MAX: 5,
    RATE_LIMIT_USER_WINDOW_MS: 1000,
    CLOCK_SYNC_INTERVAL_MS: 5000,
    CLOCK_MAX_STALENESS_MS: 15000,
    CLOCK_GUARD_SKEW_MS: 250,
    ENQUEUE_TIMEOUT_MS: 500,
    PG_POOL_MAX: 10,
    PG_STATEMENT_TIMEOUT_MS: 2000,
    POSTGRES_TEST_URL: '',
    ...overrides,
  };
}

const FIXED_CLOCK: Clock = {
  nowMs: () => FIXED_NOW_MS,
  offsetMs: () => 0,
  rttMs: () => 0,
  ageMs: () => 0,
  isFresh: () => true,
};

interface FakeReply {
  status(code: number): FakeReply;
  send(body: unknown): void;
  statusCode: number | null;
  body: unknown;
}

function fakeHost(requestOverrides: { id?: string; url?: string } = {}): {
  host: ArgumentsHost;
  reply: FakeReply;
} {
  const reply: FakeReply = {
    statusCode: null,
    body: undefined,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    send(body: unknown) {
      this.body = body;
    },
  };
  const request = { id: requestOverrides.id, url: requestOverrides.url ?? '/api/sale/status' };
  const host = {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => reply,
    }),
  } as unknown as ArgumentsHost;
  return { host, reply };
}

describe('HttpExceptionFilter', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let debugSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    debugSpy = vi.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
  });

  afterEach(() => {
    errorSpy.mockRestore();
    debugSpy.mockRestore();
  });

  describe('unexpected internal errors — the security-critical branch', () => {
    it('a raw Error yields a generic 500 body with NO internal detail (no message, no stack, no dependency name)', () => {
      const filter = new HttpExceptionFilter(FIXED_CLOCK, buildEnv());
      const { host, reply } = fakeHost({ id: 'req-1' });
      const internal = new Error('connect ECONNREFUSED 10.0.0.5:6379 (ioredis)');

      filter.catch(internal, host);

      expect(reply.statusCode).toBe(500);
      expect(reply.body).toEqual({
        error: 'INTERNAL',
        message: 'Internal error',
        requestId: 'req-1',
        serverTime: new Date(FIXED_NOW_MS).toISOString(),
        serverTimeMs: FIXED_NOW_MS,
      });
      // Never in the body:
      expect(JSON.stringify(reply.body)).not.toContain('ECONNREFUSED');
      expect(JSON.stringify(reply.body)).not.toContain('ioredis');
      expect(JSON.stringify(reply.body)).not.toContain('10.0.0.5');
    });

    it('logs the REAL cause (message + stack) server-side, with the request id, on the same unexpected error', () => {
      const filter = new HttpExceptionFilter(FIXED_CLOCK, buildEnv());
      const { host } = fakeHost({ id: 'req-2' });
      const internal = new Error('connect ECONNREFUSED 10.0.0.5:6379');

      filter.catch(internal, host);

      expect(errorSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          requestId: 'req-2',
          err: 'connect ECONNREFUSED 10.0.0.5:6379',
          stack: expect.stringContaining('Error: connect ECONNREFUSED'),
        }),
        'unhandled_exception',
      );
    });

    it('a non-Error thrown value (e.g. a string) is still handled without throwing inside the filter itself', () => {
      const filter = new HttpExceptionFilter(FIXED_CLOCK, buildEnv());
      const { host, reply } = fakeHost({ id: 'req-3' });

      expect(() => filter.catch('some raw thrown string', host)).not.toThrow();
      expect(reply.statusCode).toBe(500);
      expect(reply.body).toMatchObject({ error: 'INTERNAL', message: 'Internal error' });
    });
  });

  describe('validation failures (ZodValidationPipe -> 422 INVALID_USER_ID)', () => {
    it('on POST /api/purchase: renders the purchaseResponseSchema envelope with a sanitized, truncated userId echo', () => {
      const filter = new HttpExceptionFilter(FIXED_CLOCK, buildEnv());
      const { host, reply } = fakeHost({ id: 'req-4', url: '/api/purchase' });
      const raw = '<script>' + 'a'.repeat(100) + '</script>';
      const exception = new UnprocessableEntityException({
        outcome: 'INVALID_USER_ID',
        issues: [{ path: ['userId'], message: 'too long' }],
        rawUserId: raw,
      });

      filter.catch(exception, host);

      expect(reply.statusCode).toBe(422);
      const body = reply.body as Record<string, unknown>;
      expect(body.status).toBe('INVALID_USER_ID');
      expect(body.saleId).toBe('flash-2026');
      expect(body.stockRemaining).toBeNull();
      expect(typeof body.userId).toBe('string');
      expect((body.userId as string).length).toBeLessThanOrEqual(64);
      expect(body.userId).not.toContain('<');
      expect(body.userId).not.toContain('>');
      expect(body.userId).not.toContain('/');
    });

    it('on any other route: renders ApiErrorResponse, error INVALID_USER_ID — never the purchase envelope', () => {
      const filter = new HttpExceptionFilter(FIXED_CLOCK, buildEnv());
      const { host, reply } = fakeHost({ id: 'req-5', url: '/api/purchase/someone' });
      const exception = new UnprocessableEntityException({
        outcome: 'INVALID_USER_ID',
        issues: [],
        rawUserId: 'x',
      });

      filter.catch(exception, host);

      expect(reply.statusCode).toBe(422);
      expect(reply.body).toEqual({
        error: 'INVALID_USER_ID',
        message: expect.any(String),
        requestId: 'req-5',
        serverTime: expect.any(String),
        serverTimeMs: FIXED_NOW_MS,
      });
    });

    it('logs the zod issues at debug — never places them in the response body', () => {
      const filter = new HttpExceptionFilter(FIXED_CLOCK, buildEnv());
      const { host, reply } = fakeHost({ id: 'req-6' });
      const issues = [{ path: ['userId'], message: 'too short' }];
      const exception = new UnprocessableEntityException({
        outcome: 'INVALID_USER_ID',
        issues,
        rawUserId: 'ab',
      });

      filter.catch(exception, host);

      expect(debugSpy).toHaveBeenCalledWith(
        expect.objectContaining({ requestId: 'req-6', issues }),
        'validation.rejected',
      );
      expect(JSON.stringify(reply.body)).not.toContain('too short');
    });

    it('Fastify body-parse-stage failures (malformed JSON, wrong content-type, oversized body) map to 422 INVALID_USER_ID', () => {
      const filter = new HttpExceptionFilter(FIXED_CLOCK, buildEnv());

      const syntaxCase = fakeHost({ id: 'req-7', url: '/api/purchase' });
      filter.catch(new SyntaxError('Unexpected token'), syntaxCase.host);
      expect(syntaxCase.reply.statusCode).toBe(422);
      expect((syntaxCase.reply.body as { status: string }).status).toBe('INVALID_USER_ID');

      const tooLarge = fakeHost({ id: 'req-8', url: '/api/purchase' });
      const err = Object.assign(new Error('body too large'), {
        code: 'FST_ERR_CTP_BODY_TOO_LARGE',
      });
      filter.catch(err, tooLarge.host);
      expect(tooLarge.reply.statusCode).toBe(422);
      expect((tooLarge.reply.body as { status: string }).status).toBe('INVALID_USER_ID');
    });
  });

  describe('rate limiting (PerUserRateLimitGuard -> 429 RATE_LIMITED)', () => {
    it('renders the purchase envelope with the echoed, already-validated userId', () => {
      const filter = new HttpExceptionFilter(FIXED_CLOCK, buildEnv());
      const { host, reply } = fakeHost({ id: 'req-9', url: '/api/purchase' });
      const exception = new HttpException({ outcome: 'RATE_LIMITED', userId: 'alice-01' }, 429);

      filter.catch(exception, host);

      expect(reply.statusCode).toBe(429);
      expect(reply.body).toMatchObject({
        status: 'RATE_LIMITED',
        userId: 'alice-01',
        saleId: 'flash-2026',
        stockRemaining: null,
      });
    });
  });

  describe('404 — unmatched route', () => {
    it('renders ApiErrorResponse with EXACTLY the frozen key set (no Nest default {statusCode,message,error} shape)', () => {
      const filter = new HttpExceptionFilter(FIXED_CLOCK, buildEnv());
      const { host, reply } = fakeHost({ id: 'req-10', url: '/api/does-not-exist' });

      filter.catch(new NotFoundException(), host);

      expect(reply.statusCode).toBe(404);
      expect(Object.keys(reply.body as object).sort()).toEqual(
        ['error', 'message', 'requestId', 'serverTime', 'serverTimeMs'].sort(),
      );
      expect((reply.body as { error: string }).error).toBe('NOT_FOUND');
    });
  });

  describe('defensive fallback — an HttpException this app did not itself construct with an outcome', () => {
    it('never leaks the exception .message; logs it server-side instead', () => {
      const filter = new HttpExceptionFilter(FIXED_CLOCK, buildEnv());
      const { host, reply } = fakeHost({ id: 'req-11' });
      const exception = new HttpException(
        'some internal Nest detail the client must never see',
        400,
      );

      filter.catch(exception, host);

      expect(reply.statusCode).toBe(400);
      expect(JSON.stringify(reply.body)).not.toContain('some internal Nest detail');
      expect(errorSpy).toHaveBeenCalledWith(
        expect.objectContaining({ requestId: 'req-11', status: 400 }),
        'http_exception.unmapped',
      );
    });
  });

  describe('request id handling', () => {
    it('falls back to a fresh id when the request carries none', () => {
      const filter = new HttpExceptionFilter(FIXED_CLOCK, buildEnv());
      const { host, reply } = fakeHost({ id: undefined });

      filter.catch(new NotFoundException(), host);

      const body = reply.body as { requestId: string };
      expect(typeof body.requestId).toBe('string');
      expect(body.requestId.length).toBeGreaterThan(0);
    });

    it('echoes a valid inbound request.id verbatim', () => {
      const filter = new HttpExceptionFilter(FIXED_CLOCK, buildEnv());
      const { host, reply } = fakeHost({ id: 'a-valid-id-123' });

      filter.catch(new NotFoundException(), host);

      expect((reply.body as { requestId: string }).requestId).toBe('a-valid-id-123');
    });
  });
});
