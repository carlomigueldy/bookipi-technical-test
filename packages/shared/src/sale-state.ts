/**
 * Sale state machine (Phase 1 contract §3). A PURE function of
 * `(nowMs, startsAtMs, endsAtMs, stockRemaining)` — no I/O, no clock reads
 * inside it. Time is always injected by the caller so window-edge behavior is
 * testable to the millisecond without fake timers.
 *
 * Scope of authority — critical: this module is PRESENTATIONAL AND ADVISORY
 * ONLY. It powers `GET /sale/status` and the API's cheap fast-path guard. It
 * is NOT the enforcement point for I3 (window enforcement). That enforcement
 * lives inside `purchase.lua` (`@flash/redis`), which is the single
 * serialization point for I1, I2, and I3 together. Treating `deriveSaleState`
 * as the window gate is a misreading of the contract — see §3.1's rejected
 * alternative (a stored, scheduler-advanced `state` field) for why derivation
 * is the only option that cannot lie about a sale that is actually open.
 */

export const SALE_STATES = ['upcoming', 'active', 'sold_out', 'ended'] as const;
export type SaleState = (typeof SALE_STATES)[number];

export interface SaleStateInput {
  /** Server clock, epoch millis. NEVER the client clock. */
  nowMs: number;
  /** Inclusive window start, epoch millis. */
  startsAtMs: number;
  /** Exclusive window end, epoch millis. */
  endsAtMs: number;
  /** Units left. Negative values are treated as 0. */
  stockRemaining: number;
}

/**
 * Validates the three window/clock fields shared by every function in this
 * module. Throws `RangeError` — never returns a default — if any of
 * `nowMs`/`startsAtMs`/`endsAtMs` is not a finite number, or if
 * `endsAtMs <= startsAtMs` (a zero- or negative-length window is not a valid
 * sale window).
 */
function assertValidWindow(nowMs: number, startsAtMs: number, endsAtMs: number): void {
  if (!Number.isFinite(nowMs) || !Number.isFinite(startsAtMs) || !Number.isFinite(endsAtMs)) {
    throw new RangeError(
      `sale-state: nowMs, startsAtMs, and endsAtMs must all be finite numbers ` +
        `(got nowMs=${nowMs}, startsAtMs=${startsAtMs}, endsAtMs=${endsAtMs})`,
    );
  }
  if (endsAtMs <= startsAtMs) {
    throw new RangeError(
      `sale-state: endsAtMs (${endsAtMs}) must be strictly greater than startsAtMs (${startsAtMs})`,
    );
  }
}

/**
 * Total, ordered precedence — implemented exactly as frozen (§3.2):
 *   1. nowMs <  startsAtMs  -> 'upcoming'
 *   2. nowMs >= endsAtMs    -> 'ended'
 *   3. stockRemaining <= 0  -> 'sold_out'
 *   4. otherwise            -> 'active'
 *
 * `ended` beats `sold_out`, and `upcoming` beats `sold_out`: a sale seeded
 * with 0 stock reads `upcoming` until `startsAt`, then `sold_out` once the
 * window opens (PRD §3.4 has no `upcoming -> sold_out` edge).
 */
export function deriveSaleState(input: SaleStateInput): SaleState {
  const { nowMs, startsAtMs, endsAtMs, stockRemaining } = input;
  assertValidWindow(nowMs, startsAtMs, endsAtMs);

  if (nowMs < startsAtMs) {
    return 'upcoming';
  }
  if (nowMs >= endsAtMs) {
    return 'ended';
  }

  const stock = stockRemaining < 0 ? 0 : stockRemaining;
  if (stock <= 0) {
    return 'sold_out';
  }

  return 'active';
}

/** True iff a purchase attempt is permitted by the window alone (ignores stock). */
export function isWithinSaleWindow(nowMs: number, startsAtMs: number, endsAtMs: number): boolean {
  assertValidWindow(nowMs, startsAtMs, endsAtMs);
  return nowMs >= startsAtMs && nowMs < endsAtMs;
}

/** Millis until the next state transition, or null if none is pending (already 'ended'). */
export function msUntilNextTransition(input: SaleStateInput): number | null {
  const state = deriveSaleState(input);
  const { nowMs, startsAtMs, endsAtMs } = input;

  switch (state) {
    case 'upcoming':
      return startsAtMs - nowMs;
    case 'active':
    case 'sold_out':
      return endsAtMs - nowMs;
    case 'ended':
      return null;
  }
}
