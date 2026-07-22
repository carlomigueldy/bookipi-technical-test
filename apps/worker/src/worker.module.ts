import { Module } from '@nestjs/common';
import { HealthModule } from './health/health.module';

/**
 * Phase 0 scaffold. Per contract §13, the worker is a Nest HTTP application
 * on the Fastify adapter exposing only /health in Phase 0 — it becomes a
 * BullMQ consumer in Phase 3, and the health server stays alongside it.
 */
@Module({
  imports: [HealthModule],
})
export class WorkerModule {}
