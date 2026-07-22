// apps/api/src/sale/sale.module.ts
//
// SLICE B — .claude/contracts/phase-2.md §4.3. No `imports:` — `SaleService` consumes
// `InfraModule`'s tokens (`SALE_REDIS_STORE`, `API_ENV`, `CLOCK`), which are global
// (`@Global()`, §4.2) and therefore already visible without a local import here.
import { Module } from '@nestjs/common';

import { SaleController } from './sale.controller.js';
import { SaleService } from './sale.service.js';

@Module({
  controllers: [SaleController],
  providers: [SaleService],
})
export class SaleModule {}
