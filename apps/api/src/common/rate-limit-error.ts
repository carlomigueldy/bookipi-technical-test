/**
 * Shared `@fastify/rate-limit` `errorResponseBuilder` — contract §7.5/§7.6.
 *
 * Extracted into its own module so `main.ts` (the production bootstrap) and
 * `test/support/app-harness.ts` (the integration harness, which builds its
 * OWN `NestFastifyApplication` per contract §11.1 — see that file's header
 * note) share exactly ONE implementation instead of two copies that can
 * silently drift. Before this extraction, the harness's `fastifyRateLimit`
 * registration omitted `errorResponseBuilder` entirely, so a real 429 fell
 * through to `@fastify/rate-limit`'s own default `Error`-throwing behaviour,
 * which `HttpExceptionFilter` cannot render — every 429 case in
 * `rate-limit.integration.spec.ts` observed a 500 instead. Sharing this
 * function is what makes that class of drift structurally impossible going
 * forward.
 *
 * The per-IP limiter's `onRequest` hook runs BEFORE Fastify routes the
 * request — genuinely outside Nest's request-handling pipeline, so this 429
 * never reaches `HttpExceptionFilter`. This builds the exact §6.4/§6.6
 * envelope shape itself (mirroring the filter's own dispatch rule: the
 * purchase envelope on `POST /api/purchase`, `ApiErrorResponse` everywhere
 * else) and returns it as the value `@fastify/rate-limit` throws.
 *
 * `statusCode` is attached NON-ENUMERABLE: Fastify's default error handling
 * reads `.statusCode` off a thrown value to set the HTTP status code, but
 * `reply.send(err)` serializes every ENUMERABLE own property of a plain
 * object — an enumerable `statusCode` would leak into the JSON body and
 * violate the frozen envelope's exact key set. Non-enumerable gets the
 * status applied without polluting the body.
 */
import type { FastifyRequest } from 'fastify';

import { API_GLOBAL_PREFIX } from '@flash/shared';
import type { PurchaseResponse } from '@flash/shared/schemas';

import { buildApiErrorResponse, type ApiErrorResponse } from './dto/api-error.js';
import { messageFor } from './messages.js';
import { requestIdFromFastify } from './request-id.js';
import type { ApiEnv } from '../config/env.js';
import type { Clock } from '../infra/clock.service.js';

/**
 * `POST /api/purchase` — the one route whose 429 body is the
 * `purchaseResponseSchema` envelope instead of `ApiErrorResponse` (§7.5).
 */
export const PURCHASE_ROUTE_PATH = `/${API_GLOBAL_PREFIX}/purchase`;

export function buildRateLimitedThrowable(
  request: FastifyRequest,
  clock: Clock,
  env: Pick<ApiEnv, 'SALE_ID'>,
): PurchaseResponse | ApiErrorResponse {
  const requestId = requestIdFromFastify(request);
  const serverTimeMs = clock.nowMs();
  const path = (request.url ?? '').split('?')[0] ?? '';

  const body: PurchaseResponse | ApiErrorResponse =
    path === PURCHASE_ROUTE_PATH
      ? {
          // At this hook stage the body has not been parsed yet — there is
          // no validated `userId` to echo (§8.1 step 1 runs before step 2).
          status: 'RATE_LIMITED',
          userId: '',
          saleId: env.SALE_ID,
          stockRemaining: null,
          serverTime: new Date(serverTimeMs).toISOString(),
          serverTimeMs,
          message: messageFor('RATE_LIMITED'),
        }
      : buildApiErrorResponse({
          error: 'RATE_LIMITED',
          message: messageFor('RATE_LIMITED'),
          requestId,
          serverTimeMs,
        });

  return Object.defineProperty({ ...body }, 'statusCode', {
    value: 429,
    enumerable: false,
  }) as PurchaseResponse | ApiErrorResponse;
}
