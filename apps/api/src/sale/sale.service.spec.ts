// apps/api/src/sale/sale.service.spec.ts
//
// SLICE B unit spec (contract §11.1: `src/**/*.spec.ts`, no containers, no network).
// `SaleRedisStore` is a concrete class from the frozen `@flash/redis` package, so it is
// faked here as a plain object implementing only the two methods `SaleService` calls
// (`status`, `readMetrics`) and cast to the store type — never `ioredis-mock` (banned,
// Phase 1 decision 3 / contract §0.3.3), and never a real Redis connection (that is
// `test/integration/sale-status.integration.spec.ts`'s job, owned by SLICE E).
//
// The sentinel-handling specs below reproduce the EXACT raw values `status.lua` /
// `SaleRedisStore.status()` produce for each case (Phase 1 open issue 3 / contract
// §6.2), not a hand-waved boolean — that is what makes these specs meaningful rather
// than tautological.
import { ServiceUnavailableException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import type { SaleRedisStore } from '@flash/redis';
import type { SaleSnapshot } from '@flash/redis';

import type { ApiEnv } from '../config/env.js';

import { SaleService } from './sale.service.js';

const SALE_ID = 'flash-2026';

function fakeEnv(): ApiEnv {
  return { SALE_ID } as unknown as ApiEnv;
}

function fakeStore(overrides: Partial<SaleRedisStore> = {}): SaleRedisStore {
  return {
    status: vi.fn(),
    readMetrics: vi.fn(),
    ...overrides,
  } as unknown as SaleRedisStore;
}

const ACTIVE_SNAPSHOT: SaleSnapshot = {
  initialized: true,
  saleId: SALE_ID,
  name: 'Aurora — Founders Edition',
  startsAt: '2026-07-22T12:00:00.000Z',
  endsAt: '2026-07-22T13:00:00.000Z',
  startsAtMs: Date.parse('2026-07-22T12:00:00.000Z'),
  endsAtMs: Date.parse('2026-07-22T13:00:00.000Z'),
  totalStock: 500,
  stockRemaining: 342,
  serverTimeMs: Date.parse('2026-07-22T12:05:00.000Z'),
  state: 'active',
};

describe('SaleService', () => {
  describe('getStatus', () => {
    it('maps a healthy, initialized snapshot to the frozen SaleStatusResponse shape', async () => {
      const store = fakeStore({ status: vi.fn().mockResolvedValue(ACTIVE_SNAPSHOT) });
      const service = new SaleService(store, fakeEnv());

      const result = await service.getStatus();

      expect(result).toEqual({
        saleId: ACTIVE_SNAPSHOT.saleId,
        name: ACTIVE_SNAPSHOT.name,
        status: 'active',
        startsAt: ACTIVE_SNAPSHOT.startsAt,
        endsAt: ACTIVE_SNAPSHOT.endsAt,
        startsAtMs: ACTIVE_SNAPSHOT.startsAtMs,
        endsAtMs: ACTIVE_SNAPSHOT.endsAtMs,
        totalStock: ACTIVE_SNAPSHOT.totalStock,
        stockRemaining: ACTIVE_SNAPSHOT.stockRemaining,
        serverTime: new Date(ACTIVE_SNAPSHOT.serverTimeMs).toISOString(),
        serverTimeMs: ACTIVE_SNAPSHOT.serverTimeMs,
      });
      expect(store.status).toHaveBeenCalledWith(SALE_ID);
    });

    it('never-seeded sale (initialized: false) -> 503 NOT_INITIALIZED, never a 200', async () => {
      // Exactly what SaleRedisStore.status() returns for a saleId nobody has seeded:
      // initialized: false, stockRemaining hard-coded to 0 by the store itself (never
      // -1) -- see packages/redis/src/sale-store.ts's `!initialized` branch.
      const neverSeeded: SaleSnapshot = {
        initialized: false,
        saleId: SALE_ID,
        name: '',
        startsAt: '',
        endsAt: '',
        startsAtMs: 0,
        endsAtMs: 0,
        totalStock: 0,
        stockRemaining: 0,
        serverTimeMs: 1_700_000_000_000,
        state: 'upcoming',
      };
      const store = fakeStore({ status: vi.fn().mockResolvedValue(neverSeeded) });
      const service = new SaleService(store, fakeEnv());

      await expect(service.getStatus()).rejects.toBeInstanceOf(ServiceUnavailableException);
      await expect(service.getStatus()).rejects.toMatchObject({
        response: { outcome: 'NOT_INITIALIZED' },
      });
    });

    it('the stockRemaining=-1 sentinel (config present, stock key missing) -> 503, never a clamped 200', async () => {
      // The Phase 1 open issue 3 case: config hash survived, GET stock returned nil, so
      // status.lua's `tonumber(GET stock or '-1')` yields -1 while initialized stays
      // true. deriveSaleState would clamp this to 'sold_out' if SaleService naively
      // rendered `snapshot.state` -- this spec exists specifically to prove it does not.
      const sentinel: SaleSnapshot = {
        ...ACTIVE_SNAPSHOT,
        stockRemaining: -1,
        state: 'sold_out', // what deriveSaleState computed upstream; must never reach the client
      };
      const store = fakeStore({ status: vi.fn().mockResolvedValue(sentinel) });
      const service = new SaleService(store, fakeEnv());

      const err = await service.getStatus().catch((e: unknown) => e);

      expect(err).toBeInstanceOf(ServiceUnavailableException);
      expect((err as ServiceUnavailableException).getResponse()).toEqual({
        outcome: 'NOT_INITIALIZED',
      });
      // Never a 200 with stockRemaining -1 (violates the schema's .nonnegative()) and
      // never a 200 with a silently-clamped 0/'sold_out' either.
    });

    it('a legitimately sold-out sale (stockRemaining: 0, initialized: true) is a normal 200, not 503', async () => {
      const soldOut: SaleSnapshot = { ...ACTIVE_SNAPSHOT, stockRemaining: 0, state: 'sold_out' };
      const store = fakeStore({ status: vi.fn().mockResolvedValue(soldOut) });
      const service = new SaleService(store, fakeEnv());

      const result = await service.getStatus();

      expect(result.status).toBe('sold_out');
      expect(result.stockRemaining).toBe(0);
    });

    it('does not catch a Redis error into a business outcome -- lets it propagate', async () => {
      const boom = new Error('ECONNREFUSED');
      const store = fakeStore({ status: vi.fn().mockRejectedValue(boom) });
      const service = new SaleService(store, fakeEnv());

      await expect(service.getStatus()).rejects.toBe(boom);
    });
  });

  describe('getMetrics', () => {
    it('defaults every SALE_METRIC_FIELDS entry to 0 when the hash is empty', async () => {
      const store = fakeStore({ readMetrics: vi.fn().mockResolvedValue({}) });
      const service = new SaleService(store, fakeEnv());
      const nowMs = 1_700_000_123_456;

      const result = await service.getMetrics(nowMs);

      expect(result).toEqual({
        saleId: SALE_ID,
        metrics: {
          confirmed: 0,
          already_purchased: 0,
          sold_out: 0,
          sale_not_active: 0,
          not_initialized: 0,
          rate_limited: 0,
          invalid_user_id: 0,
        },
        serverTime: new Date(nowMs).toISOString(),
        serverTimeMs: nowMs,
      });
    });

    it('passes through populated fields and still defaults the missing ones', async () => {
      const store = fakeStore({
        readMetrics: vi.fn().mockResolvedValue({ confirmed: 10, sold_out: 490 }),
      });
      const service = new SaleService(store, fakeEnv());

      const result = await service.getMetrics(1_700_000_000_000);

      expect(result.metrics.confirmed).toBe(10);
      expect(result.metrics.sold_out).toBe(490);
      expect(result.metrics.already_purchased).toBe(0);
      expect(result.metrics.invalid_user_id).toBe(0);
    });

    it('uses the clock-derived nowMs it is given, not a Lua TIME read', async () => {
      // contract §5.1(a): /sale/metrics never reaches Lua, so serverTimeMs is
      // Clock.nowMs() supplied by the caller (SaleController), not snapshot.serverTimeMs.
      const store = fakeStore({ readMetrics: vi.fn().mockResolvedValue({}) });
      const service = new SaleService(store, fakeEnv());
      const nowMs = 42;

      const result = await service.getMetrics(nowMs);

      expect(result.serverTimeMs).toBe(42);
      expect(store.readMetrics).toHaveBeenCalledWith(SALE_ID);
    });
  });
});
