import { Module } from '@nestjs/common';
import { RECONCILIATION_STATE } from '../common/tokens.js';
import { OrdersModule } from '../orders/orders.module.js';
import { createReconciliationState, ReconciliationService } from './reconciliation.service.js';

@Module({
  imports: [OrdersModule],
  providers: [
    { provide: RECONCILIATION_STATE, useFactory: createReconciliationState },
    ReconciliationService,
  ],
  exports: [RECONCILIATION_STATE, ReconciliationService],
})
export class ReconciliationModule {}
