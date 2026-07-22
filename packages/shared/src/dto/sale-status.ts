/**
 * `GET /api/sale/status` response DTO (Phase 1 contract §8.5, PRD §4).
 *
 * Additive vs the PRD's bare `{ status, startsAt, endsAt, stockRemaining,
 * serverTime }`: `saleId`/`name`/`totalStock` (the SPA's stock meter needs a
 * denominator) and the `*Ms` epoch-millis twins (the countdown must never
 * parse an ISO string on its hot render path). All five of the PRD's
 * original fields are present, unrenamed — this is a superset, not a
 * deviation.
 */
import { z } from 'zod';
import { SALE_STATES } from '../sale-state';

export const saleStatusResponseSchema = z.object({
  saleId: z.string(),
  name: z.string(),
  status: z.enum(SALE_STATES),
  startsAt: z.iso.datetime(),
  endsAt: z.iso.datetime(),
  startsAtMs: z.number().int(),
  endsAtMs: z.number().int(),
  totalStock: z.number().int().nonnegative(),
  stockRemaining: z.number().int().nonnegative(),
  serverTime: z.iso.datetime(),
  serverTimeMs: z.number().int(),
});
export type SaleStatusResponse = z.infer<typeof saleStatusResponseSchema>;
