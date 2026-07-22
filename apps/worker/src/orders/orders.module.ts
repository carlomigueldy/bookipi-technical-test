import { Module } from '@nestjs/common';
import { OrderProcessor } from './order.processor.js';
import { OrderRepository } from './order.repository.js';
import { OrdersConsumer } from './orders.consumer.js';

@Module({
  providers: [OrderRepository, OrderProcessor, OrdersConsumer],
  exports: [OrderRepository, OrderProcessor, OrdersConsumer],
})
export class OrdersModule {}
