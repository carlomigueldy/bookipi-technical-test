/**
 * Request-id propagation — frozen contract §10.4.
 *
 * An inbound `x-request-id` is accepted ONLY if it matches
 * `REQUEST_ID_PATTERN`; otherwise a fresh `randomUUID()` is generated. An
 * unvalidated inbound id is a log-injection / log-cardinality vector.
 * `main.ts` wires `extractOrGenerateRequestId` into `nestjs-pino`'s
 * `genReqId`, so Fastify's own `request.id` (what every downstream consumer
 * — controllers, the exception filter — reads) is always this function's
 * output, never a raw client-supplied string.
 */
import { randomUUID } from 'node:crypto';

export const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** `inbound` is whatever `req.headers['x-request-id']` yields — `string | string[] | undefined`. */
export function extractOrGenerateRequestId(inbound: unknown): string {
  const candidate = Array.isArray(inbound) ? inbound[0] : inbound;
  if (typeof candidate === 'string' && REQUEST_ID_PATTERN.test(candidate)) {
    return candidate;
  }
  return randomUUID();
}

/**
 * Reads the already-resolved id back off a Fastify request (`request.id`,
 * populated by `genReqId` — see `main.ts`) with a defensive fallback. Mirrors
 * `purchase/purchase.controller.ts`'s local `requestIdOf` helper (Slice C,
 * written independently before this export existed); kept here too so
 * `HttpExceptionFilter` and any other Slice-A consumer share one
 * implementation rather than a third copy.
 */
export function requestIdFromFastify(request: { id?: unknown }): string {
  return typeof request.id === 'string' && request.id.length > 0 ? request.id : randomUUID();
}
