// packages/redis/src/types.ts
//
// Public result/config shapes for `SaleRedisStore`, frozen per
// .claude/contracts/phase-1.md §5.2. `PurchaseOutcome` and `SaleState` are imported as
// types only from `@flash/shared` — this file never pulls a runtime value from that
// package's ".": `@flash/redis`'s runtime dependency on `@flash/shared` is limited to
// `sale-store.ts`'s use of `deriveSaleState`.
import type { PurchaseOutcome, SaleState } from '@flash/shared';

export interface SaleConfigInput {
  saleId: string;
  name: string;
  /** ISO-8601 UTC */
  startsAt: string;
  /** ISO-8601 UTC */
  endsAt: string;
  totalStock: number;
  /** Defaults to totalStock. Phase 3 reconciliation passes totalStock - persistedOrders. */
  stockRemaining?: number;
}

export type SeedOutcome = 'SEEDED' | 'ALREADY_SEEDED' | 'CONFIG_DRIFT' | 'STOCK_MISSING';

export interface SeedResult {
  outcome: SeedOutcome;
  stockRemaining: number;
  totalStock: number;
  startsAtMs: number;
  endsAtMs: number;
}

export interface PurchaseResult {
  outcome: PurchaseOutcome;
  /** Post-decision remaining stock; -1 only for NOT_INITIALIZED. */
  stockRemaining: number;
  /** Redis TIME at decision — the single clock that judges both status and purchase. */
  serverTimeMs: number;
  /**
   * POST-FREEZE ADDITION (.claude/contracts/phase-1.md §11.1/§11.3). Non-null only when
   * `outcome === 'CONFIRMED'`. Caller-generated identity for this reservation, written
   * atomically into `sale:{<id>}:reservations` alongside the DECR/SADD. Phase 3 MUST
   * carry this on the BullMQ job and pass it back to `compensate()` — compensation is
   * now keyed on matching this id, not on mere buyers-Set membership (finding 1).
   */
  reservationId: string | null;
}

export type CompensateOutcome = 'COMPENSATED' | 'COMPENSATED_CAPPED' | 'NOOP';

export interface CompensateResult {
  outcome: CompensateOutcome;
  stockRemaining: number;
}

/**
 * POST-FREEZE ADDITION (.claude/contracts/phase-1.md §11.2, finding 2). Outcome of
 * `SaleRedisStore.reconcileStock` — the explicit-intent stock correction seed.lua's
 * EXISTS-config gate cannot perform, for Phase 3's warm-recovery boot reconciliation.
 */
export type ReconcileOutcome = 'RECONCILED' | 'NOT_INITIALIZED';

export interface ReconcileResult {
  outcome: ReconcileOutcome;
  /** -1 when the stock key itself was missing (or the sale was never initialized). */
  previousStock: number;
  newStock: number;
}

export type ReconcileStateOutcome = 'RECONCILED' | 'NOT_INITIALIZED' | 'OVERCOMMITTED';

export interface ReconcileStateResult {
  outcome: ReconcileStateOutcome;
  previousStock: number;
  newStock: number;
  reservationCount: number;
  totalStock: number;
}

export interface BuyerScanPage {
  cursor: string;
  userIds: string[];
}

export type CompareRestoreReservationOutcome = 'RESTORED' | 'ALREADY_MATCHED' | 'CONFLICT';

export interface CompareRestoreReservationInput {
  userId: string;
  reservationId: string;
  reservedAtMs: number;
}

export interface CompareRestoreReservationResult {
  outcome: CompareRestoreReservationOutcome;
  current: ReservationEntry | null;
}

/** One entry read back from the reservations hash via `scanReservations`. */
export interface ReservationEntry {
  userId: string;
  reservationId: string;
  /** null if the stored value predates the `:<reservedAtMs>` suffix convention. */
  reservedAtMs: number | null;
}

/** Input to `restoreReservations` — a cold-rebuild record sourced from Postgres. */
export interface ReservationRestoreInput {
  userId: string;
  reservationId: string;
  /** Defaults to Date.now() at restore time if omitted. */
  reservedAtMs?: number;
}

export interface SaleSnapshot {
  initialized: boolean;
  saleId: string;
  name: string;
  startsAt: string;
  endsAt: string;
  startsAtMs: number;
  endsAtMs: number;
  totalStock: number;
  stockRemaining: number;
  serverTimeMs: number;
  state: SaleState;
}
