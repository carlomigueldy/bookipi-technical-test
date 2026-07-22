import { Injectable, Logger } from '@nestjs/common';
import {
  ORDERS_JOB_ATTEMPTS,
  PERSIST_ORDER_JOB_NAME,
  assertOrdersQueueJobPayload,
  buildOrdersJobId,
  type OrdersQueueJobPayload,
} from '@flash/shared';
import type { Job } from 'bullmq';
import { OrderRepository, PersistenceConflictError } from './order.repository.js';

@Injectable()
export class OrderProcessor {
  private readonly logger = new Logger(OrderProcessor.name);
  constructor(private readonly repository: OrderRepository) {}

  async process(job: Job<unknown, unknown, string>): Promise<void> {
    if (job.name !== PERSIST_ORDER_JOB_NAME) throw new Error(`unexpected job name: ${job.name}`);
    assertOrdersQueueJobPayload(job.data);
    const payload: OrdersQueueJobPayload = job.data;
    const expectedId = buildOrdersJobId(payload.saleId, payload.userId);
    if (job.id !== expectedId) throw new Error(`job id mismatch: expected ${expectedId}`);
    if (job.opts.attempts !== ORDERS_JOB_ATTEMPTS)
      throw new Error(`job attempts must equal ${ORDERS_JOB_ATTEMPTS}`);

    const fields = {
      saleId: payload.saleId,
      userId: payload.userId,
      reservationId: payload.reservationId,
      jobId: job.id,
      requestId: payload.requestId,
      attempt: job.attemptsMade + 1,
    };
    try {
      const outcome = await this.repository.persist(payload);
      const event =
        outcome === 'idempotent' || outcome === 'compensated'
          ? 'order.idempotent'
          : 'order.persisted';
      this.logger.log({ event, ...fields });
    } catch (error) {
      if (error instanceof PersistenceConflictError) {
        this.logger.error({
          event: 'order.persistence_conflict',
          ...fields,
          message: error.message,
        });
      }
      this.logger.error({
        event: 'order.failed',
        ...fields,
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }
}
