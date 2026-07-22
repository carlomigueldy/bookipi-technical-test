import type { SaleRedisStore } from '@flash/redis';
import type { OrdersQueueJobPayload } from '@flash/shared';
import type { Pool } from 'pg';

import type { AdvisoryRaceHooks } from '../../src/orders/order.repository.js';

/** Negative control only: deliberately makes the forbidden read/compensate race possible. */
export async function unsafeCompensateAfterRead(
  pool: Pool,
  store: SaleRedisStore,
  payload: OrdersQueueJobPayload,
  hooks: AdvisoryRaceHooks,
): Promise<void> {
  const result = await pool.query('SELECT id FROM orders WHERE user_id=$1', [payload.userId]);
  if (result.rowCount !== 0) return;
  await hooks.afterResolverAbsentRead?.();
  await store.compensate(payload.saleId, payload.userId, payload.reservationId);
}
