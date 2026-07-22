/**
 * The non-purchase error envelope — frozen contract §6.6.
 *
 * Lives in `apps/api`, not `@flash/shared`, because `@flash/shared` is
 * frozen (Phase 1/2 §0.1) and this is an HTTP-layer concern. Every route
 * except `POST /api/purchase`'s outcome-bearing responses renders errors in
 * this shape via the global `HttpExceptionFilter`.
 */
import type { AttemptOutcome } from '@flash/shared';

export type ApiErrorCode = AttemptOutcome | 'NOT_FOUND' | 'INTERNAL';

export interface ApiErrorResponse {
  error: ApiErrorCode;
  message: string;
  requestId: string;
  serverTime: string;
  serverTimeMs: number;
}

export function buildApiErrorResponse(params: {
  error: ApiErrorCode;
  message: string;
  requestId: string;
  serverTimeMs: number;
}): ApiErrorResponse {
  return {
    error: params.error,
    message: params.message,
    requestId: params.requestId,
    serverTime: new Date(params.serverTimeMs).toISOString(),
    serverTimeMs: params.serverTimeMs,
  };
}
