// apps/api/src/health/health.service.spec.ts
//
// SLICE D unit spec (contract §11.1: `src/**/*.spec.ts`, no containers, no network).
//
// Every dependency is faked with an object that reproduces the FAILURE MODE itself
// (a rejecting `pgPool.query`, a `store.ping()` that resolves `false`, a `clock.isFresh()`
// that returns `false`) rather than pre-computed booleans handed to the service — the
// service's own branching is what is under test. Real containerized "kill the actual
// dependency and hit /health/ready over HTTP" coverage is
// `test/integration/health.integration.spec.ts`, owned by SLICE E; that file is outside
// this slice's exclusive path (`apps/api/src/health/**`) per the frozen contract §1.
import { describe, expect, it, vi } from 'vitest';

import type { SaleRedisStore, SaleSnapshot } from '@flash/redis';

import type { ApiEnv } from '../config/env.js';
import type { Clock } from '../infra/clock.service.js';
import type { QueueDepthProbe } from '../infra/queue-depth-probe.js';

import { HealthService } from './health.service.js';

const SALE_ID = 'flash-2026';

function fakeEnv(): ApiEnv {
  return { SALE_ID } as unknown as ApiEnv;
}

function fakeClock(overrides: Partial<Clock> = {}): Clock {
  return {
    nowMs: () => 1_700_000_000_000,
    offsetMs: () => -12,
    rttMs: () => 2,
    ageMs: () => 1840,
    isFresh: () => true,
    ...overrides,
  };
}

function fakeStore(overrides: Partial<SaleRedisStore> = {}): SaleRedisStore {
  return {
    ping: vi.fn().mockResolvedValue(true),
    status: vi.fn(),
    ...overrides,
  } as unknown as SaleRedisStore;
}

const HEALTHY_SNAPSHOT: SaleSnapshot = {
  initialized: true,
  saleId: SALE_ID,
  name: 'Aurora',
  startsAt: '2026-07-22T12:00:00.000Z',
  endsAt: '2026-07-22T13:00:00.000Z',
  startsAtMs: 1,
  endsAtMs: 2,
  totalStock: 500,
  stockRemaining: 342,
  serverTimeMs: 3,
  state: 'active',
};

function fakePgPool(overrides: Record<string, unknown> = {}) {
  return {
    query: vi.fn().mockResolvedValue({ rows: [] }),
    ...overrides,
  } as unknown as import('pg').Pool;
}

function fakeQueueDepthProbe(overrides: Record<string, unknown> = {}): QueueDepthProbe {
  return {
    depth: vi.fn().mockResolvedValue({ waiting: 0, active: 0, delayed: 0, failed: 0 }),
    ...overrides,
  } as unknown as QueueDepthProbe;
}

describe('HealthService', () => {
  describe('getLiveness', () => {
    it('returns the frozen Phase 0 shape and performs no I/O', () => {
      const service = new HealthService(
        fakeStore(),
        fakePgPool(),
        fakeClock(),
        fakeEnv(),
        fakeQueueDepthProbe(),
      );

      const result = service.getLiveness();

      expect(result).toEqual({
        status: 'ok',
        service: 'api',
        version: '0.0.0',
        uptimeSeconds: expect.any(Number),
      });
    });
  });

  describe('getReadiness', () => {
    it('reports status ok when every check is healthy', async () => {
      const service = new HealthService(
        fakeStore({ status: vi.fn().mockResolvedValue(HEALTHY_SNAPSHOT) }),
        fakePgPool(),
        fakeClock(),
        fakeEnv(),
        fakeQueueDepthProbe(),
      );

      const result = await service.getReadiness('req-1');

      expect(result.healthy).toBe(true);
      expect(result.body.status).toBe('ok');
      expect(result.body.checks.redis).toEqual({ ok: true, latencyMs: expect.any(Number) });
      expect(result.body.checks.clock).toEqual({ ok: true, offsetMs: -12, rttMs: 2, ageMs: 1840 });
      expect(result.body.checks.sale).toEqual({
        ok: true,
        initialized: true,
        stockKeyPresent: true,
      });
      expect(result.body.checks.postgres.ok).toBe(true);
      expect(result.body.checks.queue.ok).toBe(true);
      expect(result.body.requestId).toBe('req-1');
    });

    it('store.ping() resolving false degrades the pod', async () => {
      const service = new HealthService(
        fakeStore({
          ping: vi.fn().mockResolvedValue(false),
          status: vi.fn().mockResolvedValue(HEALTHY_SNAPSHOT),
        }),
        fakePgPool(),
        fakeClock(),
        fakeEnv(),
        fakeQueueDepthProbe(),
      );

      const result = await service.getReadiness('req-2');

      expect(result.healthy).toBe(false);
      expect(result.body.status).toBe('degraded');
      expect(result.body.checks.redis.ok).toBe(false);
    });

    it('store.ping() throwing is treated identically to resolving false', async () => {
      const service = new HealthService(
        fakeStore({
          ping: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
          status: vi.fn().mockResolvedValue(HEALTHY_SNAPSHOT),
        }),
        fakePgPool(),
        fakeClock(),
        fakeEnv(),
        fakeQueueDepthProbe(),
      );

      const result = await service.getReadiness('req-3');

      expect(result.healthy).toBe(false);
      expect(result.body.checks.redis).toEqual({ ok: false, latencyMs: expect.any(Number) });
    });

    it('clock.isFresh() === false degrades the pod (contract §9.3 / §5.3)', async () => {
      const service = new HealthService(
        fakeStore({ status: vi.fn().mockResolvedValue(HEALTHY_SNAPSHOT) }),
        fakePgPool(),
        fakeClock({ isFresh: () => false }),
        fakeEnv(),
        fakeQueueDepthProbe(),
      );

      const result = await service.getReadiness('req-4');

      expect(result.healthy).toBe(false);
      expect(result.body.checks.clock.ok).toBe(false);
    });

    it('never-seeded sale (initialized: false) degrades the pod', async () => {
      const neverSeeded: SaleSnapshot = {
        ...HEALTHY_SNAPSHOT,
        initialized: false,
        stockRemaining: 0,
      };
      const service = new HealthService(
        fakeStore({ status: vi.fn().mockResolvedValue(neverSeeded) }),
        fakePgPool(),
        fakeClock(),
        fakeEnv(),
        fakeQueueDepthProbe(),
      );

      const result = await service.getReadiness('req-5');

      expect(result.healthy).toBe(false);
      expect(result.body.checks.sale).toEqual({
        ok: false,
        initialized: false,
        stockKeyPresent: false,
      });
    });

    it('the stockRemaining=-1 sentinel (config present, stock key missing) degrades the pod', async () => {
      const sentinel: SaleSnapshot = { ...HEALTHY_SNAPSHOT, stockRemaining: -1 };
      const service = new HealthService(
        fakeStore({ status: vi.fn().mockResolvedValue(sentinel) }),
        fakePgPool(),
        fakeClock(),
        fakeEnv(),
        fakeQueueDepthProbe(),
      );

      const result = await service.getReadiness('req-6');

      expect(result.healthy).toBe(false);
      expect(result.body.checks.sale).toEqual({
        ok: false,
        initialized: true,
        stockKeyPresent: false,
      });
    });

    it('uses the independently bounded 750ms Postgres readiness query', async () => {
      const query = vi.fn().mockResolvedValue({ rows: [] });
      const service = new HealthService(
        fakeStore({ status: vi.fn().mockResolvedValue(HEALTHY_SNAPSHOT) }),
        fakePgPool({ query }),
        fakeClock(),
        fakeEnv(),
        fakeQueueDepthProbe(),
      );

      await service.getReadiness('req-pg-timeout');

      expect(query).toHaveBeenCalledExactlyOnceWith({ text: 'SELECT 1', query_timeout: 750 });
    });

    it('a Postgres outage is reported but never degrades the pod (PRD §3.5)', async () => {
      const service = new HealthService(
        fakeStore({ status: vi.fn().mockResolvedValue(HEALTHY_SNAPSHOT) }),
        fakePgPool({ query: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')) }),
        fakeClock(),
        fakeEnv(),
        fakeQueueDepthProbe(),
      );

      const result = await service.getReadiness('req-7');

      expect(result.healthy).toBe(true);
      expect(result.body.status).toBe('ok');
      expect(result.body.checks.postgres.ok).toBe(false);
    });

    it('a queue-depth timeout is reported but never degrades the pod (§17.1)', async () => {
      const depth = vi.fn().mockRejectedValue(new Error('queue depth probe timed out after 750ms'));
      const service = new HealthService(
        fakeStore({ status: vi.fn().mockResolvedValue(HEALTHY_SNAPSHOT) }),
        fakePgPool(),
        fakeClock(),
        fakeEnv(),
        fakeQueueDepthProbe({ depth }),
      );

      const result = await service.getReadiness('req-8');

      expect(depth).toHaveBeenCalledOnce();
      expect(result.healthy).toBe(true);
      expect(result.body.status).toBe('ok');
      expect(result.body.checks.queue).toEqual({
        ok: false,
        waiting: 0,
        active: 0,
        delayed: 0,
        failed: 0,
      });
    });

    it('a check that never settles within the budget is reported ok:false, latencyMs:null', async () => {
      const hangingStore = fakeStore({
        ping: vi.fn().mockReturnValue(new Promise(() => {})), // never resolves
        status: vi.fn().mockResolvedValue(HEALTHY_SNAPSHOT),
      });
      const service = new HealthService(
        hangingStore,
        fakePgPool(),
        fakeClock(),
        fakeEnv(),
        fakeQueueDepthProbe(),
        20, // tiny budget for test speed (constructor's 6th, test-only arg)
      );

      const result = await service.getReadiness('req-9');

      expect(result.body.checks.redis).toEqual({ ok: false, latencyMs: null });
      expect(result.healthy).toBe(false);
    });

    it('uses Clock.nowMs() for serverTime, never a Lua TIME read', async () => {
      const service = new HealthService(
        fakeStore({ status: vi.fn().mockResolvedValue(HEALTHY_SNAPSHOT) }),
        fakePgPool(),
        fakeClock({ nowMs: () => 999 }),
        fakeEnv(),
        fakeQueueDepthProbe(),
      );

      const result = await service.getReadiness('req-10');

      expect(result.body.serverTimeMs).toBe(999);
      expect(result.body.serverTime).toBe(new Date(999).toISOString());
    });
  });
});
