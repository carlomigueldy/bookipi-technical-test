// apps/api/src/sale/sale.controller.spec.ts
//
// SLICE B unit spec (contract §11.1). Pure Nest testing-module wiring against a mocked
// `SaleService` and a fake `Clock` — the controller's only job is routing + reading the
// clock for `/sale/metrics`, so this spec proves exactly that and nothing about
// `SaleService`'s own logic (covered by sale.service.spec.ts).
import { Test, type TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { SaleStatusResponse } from '@flash/shared/schemas';

import { CLOCK } from '../common/tokens.js';
import type { Clock } from '../infra/clock.service.js';

import { SaleController } from './sale.controller.js';
import { SaleService } from './sale.service.js';

function fakeClock(nowMs: number): Clock {
  return {
    nowMs: () => nowMs,
    offsetMs: () => 0,
    rttMs: () => 0,
    ageMs: () => 0,
    isFresh: () => true,
  };
}

describe('SaleController', () => {
  let controller: SaleController;
  let saleService: { getStatus: ReturnType<typeof vi.fn>; getMetrics: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    saleService = {
      getStatus: vi.fn(),
      getMetrics: vi.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [SaleController],
      providers: [
        { provide: SaleService, useValue: saleService },
        { provide: CLOCK, useValue: fakeClock(1_700_000_000_000) },
      ],
    }).compile();

    controller = module.get(SaleController);
  });

  it('GET status returns whatever SaleService.getStatus() resolves, untouched', async () => {
    const body: SaleStatusResponse = {
      saleId: 'flash-2026',
      name: 'Aurora',
      status: 'active',
      startsAt: '2026-07-22T12:00:00.000Z',
      endsAt: '2026-07-22T13:00:00.000Z',
      startsAtMs: 1,
      endsAtMs: 2,
      totalStock: 500,
      stockRemaining: 10,
      serverTime: '2026-07-22T12:05:00.000Z',
      serverTimeMs: 3,
    };
    saleService.getStatus.mockResolvedValue(body);

    await expect(controller.getStatus()).resolves.toEqual(body);
    expect(saleService.getStatus).toHaveBeenCalledTimes(1);
  });

  it('does not itself decide the 503 branch -- SaleService.getStatus() throwing propagates untouched', async () => {
    const err = new Error('service-level failure');
    saleService.getStatus.mockRejectedValue(err);

    await expect(controller.getStatus()).rejects.toBe(err);
  });

  it('GET metrics passes the injected Clock.nowMs() through to SaleService.getMetrics()', async () => {
    saleService.getMetrics.mockResolvedValue({
      saleId: 'flash-2026',
      metrics: {},
      serverTime: new Date(1_700_000_000_000).toISOString(),
      serverTimeMs: 1_700_000_000_000,
    });

    await controller.getMetrics();

    expect(saleService.getMetrics).toHaveBeenCalledWith(1_700_000_000_000);
  });
});
