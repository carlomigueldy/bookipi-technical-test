// apps/api/src/sale/sale.controller.ts
//
// SLICE B — .claude/contracts/phase-2.md §6.1, §6.3.
//
// `GET /api/sale/status` and `GET /api/sale/metrics`. Both routes are read-only, take
// no body/params/query, and rely solely on the per-IP limiter (no route-specific rate
// limiting here — contract §7.2's per-IP row covers "every /api/* route").
//
// No HTTP status literal appears in this file: the 200 the SPA sees on both routes is
// Nest's Fastify-adapter default for a GET handler that returns normally, and the unavailable
// sentinel path is a thrown `ServiceUnavailableException` (built in `SaleService`,
// §6.2) rendered by the global `HttpExceptionFilter` — never constructed here.
import { Controller, Get, Inject } from '@nestjs/common';

import type { SaleStatusResponse } from '@flash/shared/schemas';

import { CLOCK } from '../common/tokens.js';
import type { Clock } from '../infra/clock.service.js';

import { SaleService, type SaleMetricsResponse } from './sale.service.js';

@Controller('sale')
export class SaleController {
  constructor(
    private readonly saleService: SaleService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  @Get('status')
  async getStatus(): Promise<SaleStatusResponse> {
    return this.saleService.getStatus();
  }

  @Get('metrics')
  async getMetrics(): Promise<SaleMetricsResponse> {
    return this.saleService.getMetrics(this.clock.nowMs());
  }
}
