// apps/api/src/health/health.module.ts
//
// SLICE D — .claude/contracts/phase-2.md §4.3, amended by §17.1. Every
// `HealthService` dependency, including the observation-only `QUEUE_DEPTH_PROBE`,
// comes from the `@Global()` `InfraModule`; health must never import the producer
// queue module or create/close a client of its own.
import { Module } from '@nestjs/common';

import { HealthController } from './health.controller.js';
import { HealthService } from './health.service.js';

@Module({
  controllers: [HealthController],
  providers: [HealthService],
})
export class HealthModule {}
