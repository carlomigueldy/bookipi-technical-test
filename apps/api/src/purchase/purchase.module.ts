// apps/api/src/purchase/purchase.module.ts  [SLICE C — frozen contract §4.3]
import { Module } from '@nestjs/common';

import { PerUserRateLimitGuard } from '../common/per-user-rate-limit.guard.js';
import { OrdersQueueModule } from '../queue/orders-queue.module.js';

import { PurchaseStatusService } from './purchase-status.service.js';
import { PurchaseController } from './purchase.controller.js';
import { PurchaseService } from './purchase.service.js';

@Module({
  imports: [OrdersQueueModule],
  controllers: [PurchaseController],
  providers: [PurchaseService, PurchaseStatusService, PerUserRateLimitGuard],
})
export class PurchaseModule {}
