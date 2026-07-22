/**
 * Result & error taxonomy (Phase 1 contract §7). One vocabulary, shared by
 * Redis (`@flash/redis`), the API, the worker, and the web client. Phase 2
 * maps this vocabulary to HTTP responses; it does not invent new members.
 */

/** Outcomes `purchase.lua` can return. */
export const PURCHASE_OUTCOMES = [
  'CONFIRMED',
  'ALREADY_PURCHASED',
  'SOLD_OUT',
  'SALE_NOT_STARTED',
  'SALE_ENDED',
  'NOT_INITIALIZED',
] as const;
export type PurchaseOutcome = (typeof PURCHASE_OUTCOMES)[number];

/** Outcomes produced above the Redis layer. Never returned by Lua. */
export const REQUEST_OUTCOMES = [
  'INVALID_USER_ID',
  'RATE_LIMITED',
  'UPSTREAM_UNAVAILABLE',
] as const;
export type RequestOutcome = (typeof REQUEST_OUTCOMES)[number];

/** The full vocabulary. Used by `z.enum(...)` in the DTO layer — a readonly string tuple. */
export const ATTEMPT_OUTCOMES = [...PURCHASE_OUTCOMES, ...REQUEST_OUTCOMES] as const;
export type AttemptOutcome = (typeof ATTEMPT_OUTCOMES)[number];

/** Order lifecycle states — mirrors the Postgres enum 1:1. */
export const ORDER_STATUSES = ['reserved', 'persisted', 'compensated'] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

/**
 * HTTP status mapping (§7 table), total over every `AttemptOutcome`. The
 * `satisfies Record<AttemptOutcome, number>` clause makes an unmapped outcome
 * a compile error rather than a runtime surprise — adding a 10th outcome
 * without a status code here fails `typecheck`, not a request in production.
 */
export const PURCHASE_OUTCOME_HTTP_STATUS = {
  CONFIRMED: 201,
  ALREADY_PURCHASED: 409,
  SOLD_OUT: 410,
  SALE_NOT_STARTED: 403,
  SALE_ENDED: 403,
  NOT_INITIALIZED: 503,
  INVALID_USER_ID: 422,
  RATE_LIMITED: 429,
  UPSTREAM_UNAVAILABLE: 503,
} as const satisfies Record<AttemptOutcome, number>;

/** The two outcomes that both mean "the window is closed", split for the SPA's discriminator. */
export const SALE_NOT_ACTIVE_OUTCOMES = ['SALE_NOT_STARTED', 'SALE_ENDED'] as const;

export function isSuccessOutcome(o: AttemptOutcome): o is 'CONFIRMED' {
  return o === 'CONFIRMED';
}

/**
 * Fields on the `sale:{id}:metrics` hash (Phase 0 §16's frozen five, plus the
 * `not_initialized` / `invalid_user_id` additive fields from §0.2 / §7).
 */
export const SALE_METRIC_FIELDS = [
  'confirmed',
  'already_purchased',
  'sold_out',
  'sale_not_active',
  'not_initialized',
  'rate_limited',
  'invalid_user_id',
] as const;
export type SaleMetricField = (typeof SALE_METRIC_FIELDS)[number];

/**
 * Maps every `AttemptOutcome` to the metric field it increments.
 * `SALE_NOT_STARTED` and `SALE_ENDED` both fold into `sale_not_active`,
 * preserving Phase 0 §16's frozen field names.
 *
 * `UPSTREAM_UNAVAILABLE` has no dedicated field in the frozen §7
 * `SALE_METRIC_FIELDS` tuple — the contract's prose only walks through eight
 * of the nine `AttemptOutcome` members when explaining this mapping. Per
 * `@flash/redis`'s frozen `SaleRedisStore.bumpMetric` signature
 * (`PurchaseOutcome | 'RATE_LIMITED' | 'INVALID_USER_ID'`), `UPSTREAM_UNAVAILABLE`
 * is deliberately never passed to `bumpMetric` in the first place — it means
 * Redis itself is unreachable, so there is no hash to increment. This entry
 * exists solely to satisfy the `satisfies Record<AttemptOutcome, ...>`
 * compile-time totality check; it maps to `not_initialized` as the closest
 * existing "datastore was not in a servable state" signal. Flagged as a
 * contract ambiguity in the slice's return value rather than silently
 * inventing a new metric field name.
 */
export const OUTCOME_METRIC_FIELD = {
  CONFIRMED: 'confirmed',
  ALREADY_PURCHASED: 'already_purchased',
  SOLD_OUT: 'sold_out',
  SALE_NOT_STARTED: 'sale_not_active',
  SALE_ENDED: 'sale_not_active',
  NOT_INITIALIZED: 'not_initialized',
  INVALID_USER_ID: 'invalid_user_id',
  RATE_LIMITED: 'rate_limited',
  UPSTREAM_UNAVAILABLE: 'not_initialized',
} as const satisfies Record<AttemptOutcome, SaleMetricField>;
