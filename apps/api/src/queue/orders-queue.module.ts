// apps/api/src/queue/orders-queue.module.ts
//
// Producer-only BullMQ wiring — frozen contract §4.3, §8.3 and Amendment A4.
// The service owns its raw ioredis/Queue generations; neither is injectable.
// No `Worker`, no `QueueEvents`, no processor is constructed anywhere in this
// module — that is Phase 3's job. Constructing a `Worker` here is a slice
// failure per the frozen contract's out-of-scope table.
import { Module } from '@nestjs/common';

import { OrdersQueueService } from './orders-queue.service.js';

@Module({
  providers: [OrdersQueueService],
  exports: [OrdersQueueService],
})
export class OrdersQueueModule {}
