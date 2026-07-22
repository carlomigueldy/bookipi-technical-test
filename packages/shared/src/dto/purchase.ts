/**
 * `POST /api/purchase` request/response DTOs (Phase 1 contract §8.5, PRD §4).
 *
 * The response schema is one envelope shared by every outcome — success and
 * failure alike — so the SPA branches on `status` (the §7 `AttemptOutcome`
 * vocabulary) instead of on HTTP status-code classes. `stockRemaining` is
 * `null` whenever the outcome didn't reach a point where Redis reported a
 * number (422 invalid id, 429 rate-limited, 503 upstream unavailable).
 *
 * Per contract §8.5: this schema is used to derive types and, in tests, to
 * assert `schema.parse(body)` from the *client* side of a request. It is NOT
 * wired into an outbound serializer in Phase 2 — validating every response
 * body at runtime would burn CPU on the hot path for no correctness benefit
 * (the server already knows the shape it just built).
 */
import { z } from 'zod';
import { ATTEMPT_OUTCOMES } from '../results';
import { userIdSchema } from './user-id';

export const purchaseRequestSchema = z.object({ userId: userIdSchema }).strict();
export type PurchaseRequest = z.infer<typeof purchaseRequestSchema>;

export const purchaseResponseSchema = z.object({
  status: z.enum(ATTEMPT_OUTCOMES),
  userId: z.string(),
  saleId: z.string(),
  stockRemaining: z.number().int().nullable(),
  serverTime: z.iso.datetime(),
  serverTimeMs: z.number().int(),
  message: z.string().optional(),
});
export type PurchaseResponse = z.infer<typeof purchaseResponseSchema>;
