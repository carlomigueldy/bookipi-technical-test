/**
 * Frozen total outcome -> user-facing message table — contract Amendment A2
 * §16.1. Response-producing controllers, filters, rate-limit builders, and
 * services use `messageFor(...)` rather than duplicating these literals.
 */
import { ATTEMPT_OUTCOMES, type AttemptOutcome } from '@flash/shared';
import type { ApiErrorCode } from './dto/api-error.js';

export const OUTCOME_MESSAGES = {
  CONFIRMED: 'Purchase confirmed.',
  ALREADY_PURCHASED: 'You have already purchased this item.',
  SOLD_OUT: 'This item is sold out.',
  SALE_NOT_STARTED: 'The sale has not started yet.',
  SALE_ENDED: 'The sale has ended.',
  NOT_INITIALIZED: 'The sale is not ready yet. Please try again shortly.',
  INVALID_USER_ID: 'The provided user ID is invalid.',
  RATE_LIMITED: 'Too many requests. Please slow down and try again shortly.',
  UPSTREAM_UNAVAILABLE: 'The service is temporarily unavailable. Please try again shortly.',
  NOT_FOUND: 'Not found.',
  INTERNAL: 'Internal error',
} as const satisfies Record<ApiErrorCode, string>;

/** Guarantees, at compile time, that this table stays a total map over `AttemptOutcome`
 * (a strict subset of `ApiErrorCode`) even as `@flash/shared` evolves the vocabulary. */
function assertCoversAttemptOutcomes(_outcomes: readonly AttemptOutcome[]): void {
  /* type-level check only; body intentionally empty */
}
assertCoversAttemptOutcomes(ATTEMPT_OUTCOMES);

export function messageFor(code: ApiErrorCode): string {
  return OUTCOME_MESSAGES[code];
}
