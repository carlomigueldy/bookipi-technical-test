/**
 * `GET /api/purchase/:userId` params + response DTOs (Phase 1 contract §8.5,
 * PRD §4). `order` is `null` (not merely absent) when `purchased === false` —
 * one response shape, no optionality branch for the SPA to special-case.
 * `'reserved'` means Redis has recorded the buyer but the async Postgres
 * write (via BullMQ, Phase 3) has not landed yet.
 */
import { z } from 'zod';
import { ORDER_STATUSES } from '../results';
import { userIdSchema } from './user-id';

export const purchaseStatusParamsSchema = z.object({ userId: userIdSchema }).strict();
export type PurchaseStatusParams = z.infer<typeof purchaseStatusParamsSchema>;

export const purchaseStatusResponseSchema = z.object({
  userId: z.string(),
  saleId: z.string(),
  purchased: z.boolean(),
  order: z
    .object({
      status: z.enum(ORDER_STATUSES),
      createdAt: z.iso.datetime().nullable(),
    })
    .nullable(),
  serverTime: z.iso.datetime(),
  serverTimeMs: z.number().int(),
});
export type PurchaseStatusResponse = z.infer<typeof purchaseStatusResponseSchema>;
