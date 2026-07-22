/**
 * Redis key builders (Phase 1 contract §4.1, reconfirming Phase 0 §16).
 *
 * `{` and `}` in the key strings below are LITERAL characters, not template
 * placeholder decoration — they are Redis Cluster hash tags. Every key for a
 * given sale must hash to the same slot for `purchase.lua` / `compensate.lua`
 * (both 3-KEY scripts) to be legal and atomic. Do not strip them, and do not
 * "clean up" what looks like double braces.
 *
 * `assertSaleId` is a correctness guard, not hygiene: a saleId containing `{`
 * or `}` would silently split the hash tag and scatter one sale's keys across
 * cluster slots, turning a multi-key script into a CROSSSLOT error at best and
 * a non-atomic decision at worst.
 */

/** Lowercase-start, alnum + `._-`, 1–64 chars total. No `{`, `}`, `:`, whitespace, uppercase. */
export const SALE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** Throws TypeError if `saleId` would corrupt the key space or the hash tag. */
export function assertSaleId(saleId: string): void {
  if (typeof saleId !== 'string' || !SALE_ID_PATTERN.test(saleId)) {
    throw new TypeError(
      `Invalid saleId ${JSON.stringify(saleId)}: must match ${SALE_ID_PATTERN.source} ` +
        '(lowercase alphanumeric, "._-", 1-64 chars, no braces/colons/whitespace)',
    );
  }
}

/** `{${saleId}}` — the Redis Cluster hash tag shared by every key of one sale. */
export function saleHashTag(saleId: string): string {
  assertSaleId(saleId);
  return `{${saleId}}`;
}

export function saleConfigKey(saleId: string): string {
  assertSaleId(saleId);
  return `sale:${saleHashTag(saleId)}:config`;
}

export function saleStockKey(saleId: string): string {
  assertSaleId(saleId);
  return `sale:${saleHashTag(saleId)}:stock`;
}

export function saleBuyersKey(saleId: string): string {
  assertSaleId(saleId);
  return `sale:${saleHashTag(saleId)}:buyers`;
}

export function saleMetricsKey(saleId: string): string {
  assertSaleId(saleId);
  return `sale:${saleHashTag(saleId)}:metrics`;
}

/**
 * `sale:{<id>}:reservations` — hash of `userId -> "<reservationId>:<reservedAtMs>"`.
 *
 * Added post-freeze (Phase 1 remediation, see `.claude/contracts/phase-1.md` §11) to
 * close a gap where `compensate.lua`'s idempotency token was keyed on mere Set
 * membership: a redelivered DLQ job could compensate a *different, later* reservation
 * for the same user (see contract §11.1 for the full failure scenario). This hash
 * gives every CONFIRMED purchase a durable identity that compensation must match
 * before it is allowed to touch stock or the buyers set, and doubles as the pending-
 * persistence ledger I4's boot sweep needs (§11.2/§11.3).
 */
export function saleReservationsKey(saleId: string): string {
  assertSaleId(saleId);
  return `sale:${saleHashTag(saleId)}:reservations`;
}

export interface SaleKeys {
  config: string;
  stock: string;
  buyers: string;
  metrics: string;
  reservations: string;
}

export function saleKeys(saleId: string): SaleKeys {
  assertSaleId(saleId);
  return {
    config: saleConfigKey(saleId),
    stock: saleStockKey(saleId),
    buyers: saleBuyersKey(saleId),
    metrics: saleMetricsKey(saleId),
    reservations: saleReservationsKey(saleId),
  };
}
