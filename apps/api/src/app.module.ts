import { Module } from '@nestjs/common';
import { HealthModule } from './health/health.module';

/**
 * Phase 0 scaffold: only HealthModule is wired. SaleModule and
 * PurchaseModule are out of scope for Phase 0 (contract §0) and land in
 * Phase 2.
 */
@Module({
  imports: [HealthModule],
})
export class AppModule {}
