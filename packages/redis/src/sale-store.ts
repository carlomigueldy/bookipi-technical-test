// packages/redis/src/sale-store.ts
//
// The public Redis-backed store for one flash sale. Frozen public surface per
// .claude/contracts/phase-1.md §5.2. This is the only place `@flash/redis` calls into
// `@flash/shared` at runtime (key builders, `deriveSaleState`, the outcome taxonomy) —
// `types.ts` only imports types from it.
//
// Store-level rules, load-bearing:
//   - `purchase()` / `compensate()` decode the RESP array positionally and validate the
//     returned code against the frozen union; an unrecognised code throws rather than
//     being passed through silently.
//   - This store never catches a Redis error to synthesize a "safe" outcome on the hot
//     path. A Redis failure is an exception; Phase 2 maps it to 503. Swallowing it here
//     would fabricate SOLD_OUT or similar and hide an outage as a business answer.
//     `bumpMetric` is the sole, explicitly-fire-and-forget exception.
import { randomUUID } from 'node:crypto';

import type { Redis } from 'ioredis';

import {
  assertSaleId,
  deriveSaleState,
  OUTCOME_METRIC_FIELD,
  PURCHASE_OUTCOMES,
  saleKeys,
  USER_ID_MAX_LENGTH,
  USER_ID_MIN_LENGTH,
  USER_ID_PATTERN,
  type PurchaseOutcome,
} from '@flash/shared';

import {
  COMPARE_RESTORE_RESERVATION_SCRIPT,
  COMPENSATE_SCRIPT,
  INSPECT_RESERVATION_MEMBERSHIP_SCRIPT,
  PURCHASE_SCRIPT,
  RECONCILE_MEMBERSHIP_SCRIPT,
  RECONCILE_SCRIPT,
  RECONCILE_STATE_SCRIPT,
  SEED_SCRIPT,
  STATUS_SCRIPT,
} from './scripts/registry';
import { runScript } from './scripts/run';
import type {
  BuyerScanPage,
  CompensateOutcome,
  CompensateResult,
  CompareRestoreReservationInput,
  CompareRestoreReservationOutcome,
  CompareRestoreReservationResult,
  PurchaseResult,
  ReconcileOutcome,
  ReconcileResult,
  ReconcileStateOutcome,
  ReconcileStateResult,
  ReservationEntry,
  ReservationMembershipInspection,
  ReservationMembershipOutcome,
  ReservationRestoreInput,
  SaleConfigInput,
  SaleSnapshot,
  SeedOutcome,
  SeedResult,
} from './types';

const SEED_OUTCOMES: readonly SeedOutcome[] = [
  'SEEDED',
  'ALREADY_SEEDED',
  'CONFIG_DRIFT',
  'STOCK_MISSING',
];

const COMPENSATE_OUTCOMES: readonly CompensateOutcome[] = [
  'COMPENSATED',
  'COMPENSATED_CAPPED',
  'NOOP',
];

const RECONCILE_OUTCOMES: readonly ReconcileOutcome[] = ['RECONCILED', 'NOT_INITIALIZED'];

const RECONCILE_STATE_OUTCOMES: readonly ReconcileStateOutcome[] = [
  'RECONCILED',
  'NOT_INITIALIZED',
  'OVERCOMMITTED',
];

const RECONCILE_MEMBERSHIP_OUTCOMES = ['PRESENT', 'ABSENT'] as const;

const COMPARE_RESTORE_RESERVATION_OUTCOMES: readonly CompareRestoreReservationOutcome[] = [
  'RESTORED',
  'ALREADY_MATCHED',
  'CONFLICT',
];

const RESERVATION_MEMBERSHIP_OUTCOMES: readonly ReservationMembershipOutcome[] = [
  'BOTH',
  'NEITHER',
  'BUYER_ONLY',
  'RESERVATION_ONLY',
];

/** Chunk size for the pipelined writes in `restoreReservations`. */
const RESTORE_CHUNK_SIZE = 500;
/** Default HSCAN page size for `scanReservations`. */
const DEFAULT_SCAN_COUNT = 200;

const UUID_PATTERN =
  /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/i;
const COMPARE_RESTORE_INPUT_KEYS = ['userId', 'reservationId', 'reservedAtMs'] as const;

/** Canonical decimal formatting for numeric ARGV: no exponent, no sign padding. */
function canonicalInt(n: number): string {
  return String(Math.trunc(n));
}

function assertMember<T extends string>(value: string, allowed: readonly T[], what: string): T {
  if (!(allowed as readonly string[]).includes(value)) {
    throw new Error(`SaleRedisStore: unrecognised ${what} code from Lua: '${value}'`);
  }
  return value as T;
}

function parseReservationEntry(userId: string, value: string): ReservationEntry {
  const separator = value.indexOf(':');
  if (separator !== -1 && separator !== value.lastIndexOf(':')) {
    throw new Error(`SaleRedisStore: malformed reservation ledger value for user '${userId}'`);
  }

  const reservationId = separator === -1 ? value : value.slice(0, separator);
  if (!UUID_PATTERN.test(reservationId)) {
    throw new Error(`SaleRedisStore: malformed reservation ledger value for user '${userId}'`);
  }

  if (separator === -1) {
    return { userId, reservationId, reservedAtMs: null };
  }

  const timestampText = value.slice(separator + 1);
  const reservedAtMs = Number(timestampText);
  if (!/^\d+$/.test(timestampText) || !Number.isSafeInteger(reservedAtMs) || reservedAtMs < 0) {
    throw new Error(`SaleRedisStore: malformed reservation ledger value for user '${userId}'`);
  }

  return { userId, reservationId, reservedAtMs };
}

function assertReservationMembershipUserId(userId: string): void {
  if (
    typeof userId !== 'string' ||
    userId !== userId.trim() ||
    userId.length < USER_ID_MIN_LENGTH ||
    userId.length > USER_ID_MAX_LENGTH ||
    !USER_ID_PATTERN.test(userId)
  ) {
    throw new TypeError('Invalid reservation-membership userId');
  }
}

function decodeReservationMembershipInspection(
  userId: string,
  raw: unknown,
): ReservationMembershipInspection {
  if (!Array.isArray(raw) || raw.length !== 2 || raw.some((value) => typeof value !== 'string')) {
    throw new Error('SaleRedisStore: malformed reservation-membership tuple from Lua');
  }

  const [rawOutcome, storedValue] = raw as [string, string];
  const outcome = assertMember(
    rawOutcome,
    RESERVATION_MEMBERSHIP_OUTCOMES,
    'reservation-membership',
  );
  const reservationBearing = outcome === 'BOTH' || outcome === 'RESERVATION_ONLY';
  if (reservationBearing === (storedValue.length === 0)) {
    throw new Error('SaleRedisStore: malformed reservation-membership tuple from Lua');
  }

  return {
    outcome,
    reservation: reservationBearing ? parseReservationEntry(userId, storedValue) : null,
  };
}

function assertCompareRestoreReservationInput(
  input: CompareRestoreReservationInput,
): asserts input is CompareRestoreReservationInput {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new TypeError('Invalid compare-and-restore reservation input');
  }

  const keys = Reflect.ownKeys(input);
  if (
    keys.length !== COMPARE_RESTORE_INPUT_KEYS.length ||
    keys.some(
      (key) =>
        typeof key !== 'string' ||
        !COMPARE_RESTORE_INPUT_KEYS.includes(key as (typeof COMPARE_RESTORE_INPUT_KEYS)[number]),
    )
  ) {
    throw new TypeError('Invalid compare-and-restore reservation input keys');
  }

  if (
    typeof input.userId !== 'string' ||
    input.userId !== input.userId.trim() ||
    input.userId.length < USER_ID_MIN_LENGTH ||
    input.userId.length > USER_ID_MAX_LENGTH ||
    !USER_ID_PATTERN.test(input.userId)
  ) {
    throw new TypeError('Invalid compare-and-restore reservation userId');
  }
  if (typeof input.reservationId !== 'string' || !UUID_PATTERN.test(input.reservationId)) {
    throw new TypeError('Invalid compare-and-restore reservation reservationId');
  }
  if (!Number.isSafeInteger(input.reservedAtMs) || input.reservedAtMs < 0) {
    throw new TypeError('Invalid compare-and-restore reservation reservedAtMs');
  }
}

export class SaleRedisStore {
  constructor(private readonly client: Redis) {}

  /** Idempotent. Safe to call from every pod on every boot. Never resets a live sale. */
  async seed(config: SaleConfigInput): Promise<SeedResult> {
    assertSaleId(config.saleId);

    const startsAtMs = Date.parse(config.startsAt);
    const endsAtMs = Date.parse(config.endsAt);
    if (!Number.isFinite(startsAtMs) || !Number.isFinite(endsAtMs)) {
      throw new RangeError(
        `SaleRedisStore.seed: unparseable ISO timestamp (startsAt='${config.startsAt}', endsAt='${config.endsAt}')`,
      );
    }
    if (endsAtMs <= startsAtMs) {
      throw new RangeError(
        `SaleRedisStore.seed: endsAt (${config.endsAt}) must be after startsAt (${config.startsAt})`,
      );
    }

    const stockRemaining = config.stockRemaining ?? config.totalStock;
    const keys = saleKeys(config.saleId);

    const raw = await runScript<[string, number, number, number, number]>(
      this.client,
      SEED_SCRIPT,
      [keys.config, keys.stock],
      [
        config.saleId,
        config.name,
        config.startsAt,
        config.endsAt,
        canonicalInt(startsAtMs),
        canonicalInt(endsAtMs),
        canonicalInt(config.totalStock),
        canonicalInt(stockRemaining),
      ],
    );

    const [code, stockRemainingOut, totalStockOut, startsAtMsOut, endsAtMsOut] = raw;
    return {
      outcome: assertMember(code, SEED_OUTCOMES, 'seed'),
      stockRemaining: stockRemainingOut,
      totalStock: totalStockOut,
      startsAtMs: startsAtMsOut,
      endsAtMs: endsAtMsOut,
    };
  }

  /**
   * The hot path. One round trip. Upholds I1, I2, I3.
   *
   * POST-FREEZE (.claude/contracts/phase-1.md §11.1/§11.3): generates a fresh
   * `reservationId` client-side (a UUID; no server round trip needed to allocate it)
   * and passes it as ARGV[2]. On CONFIRMED, `purchase.lua` writes it into the
   * reservations hash in the SAME atomic step as the DECR/SADD, giving Phase 3's DLQ
   * handler and boot sweep a durable, matchable identity for this reservation instead
   * of bare Set membership. See `PurchaseResult.reservationId`.
   */
  async purchase(saleId: string, userId: string): Promise<PurchaseResult> {
    assertSaleId(saleId);
    const keys = saleKeys(saleId);
    const reservationId = randomUUID();

    const raw = await runScript<[string, number, number, string]>(
      this.client,
      PURCHASE_SCRIPT,
      [keys.config, keys.stock, keys.buyers, keys.reservations],
      [userId, reservationId],
    );

    const [code, stockRemaining, nowMs, returnedReservationId] = raw;
    const outcome = assertMember(code, PURCHASE_OUTCOMES, 'purchase');
    return {
      outcome,
      stockRemaining,
      serverTimeMs: nowMs,
      reservationId: outcome === 'CONFIRMED' ? returnedReservationId : null,
    };
  }

  /**
   * Phase 3 DLQ path. Idempotent by reservation identity, not mere Set membership —
   * see the compensate.lua header comment and .claude/contracts/phase-1.md §11.1
   * (finding 1) for why membership alone is unsafe under re-purchase-after-compensate.
   *
   * `reservationId` MUST be the value returned by the `purchase()` call this
   * compensation is undoing (carried on the BullMQ job in Phase 3). A stale or
   * mismatched `reservationId` — including one for a user who has since legitimately
   * re-purchased — is unconditionally a NOOP; it can never touch stock or the buyers
   * Set for a reservation it does not own.
   */
  async compensate(
    saleId: string,
    userId: string,
    reservationId: string,
  ): Promise<CompensateResult> {
    assertSaleId(saleId);
    const keys = saleKeys(saleId);

    const raw = await runScript<[string, number]>(
      this.client,
      COMPENSATE_SCRIPT,
      [keys.config, keys.stock, keys.buyers, keys.reservations],
      [userId, reservationId],
    );

    const [code, stockRemaining] = raw;
    return {
      outcome: assertMember(code, COMPENSATE_OUTCOMES, 'compensate'),
      stockRemaining,
    };
  }

  /**
   * POST-FREEZE ADDITION (.claude/contracts/phase-1.md §11.2, finding 2). Explicit-
   * intent stock correction for Phase 3's boot reconciliation — the warm-recovery path
   * `seed()`'s EXISTS-config gate cannot perform (config survives a partial AOF
   * replay; `seed()` then reads ALREADY_SEEDED and writes nothing). Never creates a
   * sale: a never-seeded saleId returns NOT_INITIALIZED. Callers MUST derive
   * `stockRemaining` from an authoritative source (Postgres persisted-order count),
   * never from client input.
   */
  async reconcileStock(saleId: string, stockRemaining: number): Promise<ReconcileResult> {
    assertSaleId(saleId);
    const keys = saleKeys(saleId);

    const raw = await runScript<[string, number, number]>(
      this.client,
      RECONCILE_SCRIPT,
      [keys.config, keys.stock],
      [canonicalInt(stockRemaining)],
    );

    const [code, previousStock, newStock] = raw;
    return {
      outcome: assertMember(code, RECONCILE_OUTCOMES, 'reconcile'),
      previousStock,
      newStock,
    };
  }

  /** Atomically derives stock from the authoritative Redis reservations ledger. */
  async reconcileStockFromReservations(saleId: string): Promise<ReconcileStateResult> {
    assertSaleId(saleId);
    const keys = saleKeys(saleId);

    const raw = await runScript<[string, number, number, number, number]>(
      this.client,
      RECONCILE_STATE_SCRIPT,
      [keys.config, keys.stock, keys.reservations],
      [],
    );

    const [code, previousStock, newStock, reservationCount, totalStock] = raw;
    return {
      outcome: assertMember(code, RECONCILE_STATE_OUTCOMES, 'reconcile state'),
      previousStock,
      newStock,
      reservationCount,
      totalStock,
    };
  }

  /** One targeted HGET. Malformed ledger values fail closed. */
  async getReservation(saleId: string, userId: string): Promise<ReservationEntry | null> {
    assertSaleId(saleId);
    const keys = saleKeys(saleId);
    const value = await this.client.hget(keys.reservations, userId);
    return value === null ? null : parseReservationEntry(userId, value);
  }

  /** Atomically inspects one identity across the buyers Set and reservations Hash. */
  async inspectReservationMembership(
    saleId: string,
    userId: string,
  ): Promise<ReservationMembershipInspection> {
    assertSaleId(saleId);
    assertReservationMembershipUserId(userId);
    const keys = saleKeys(saleId);
    const raw = await runScript<unknown>(
      this.client,
      INSPECT_RESERVATION_MEMBERSHIP_SCRIPT,
      [keys.buyers, keys.reservations],
      [userId],
    );
    return decodeReservationMembershipInspection(userId, raw);
  }

  /** Cursor-paged buyer enumeration; never materializes the full Set. */
  async scanBuyers(
    saleId: string,
    cursor: string = '0',
    count: number = DEFAULT_SCAN_COUNT,
  ): Promise<BuyerScanPage> {
    assertSaleId(saleId);
    const keys = saleKeys(saleId);
    const [nextCursor, userIds] = await this.client.sscan(keys.buyers, cursor, 'COUNT', count);
    return { cursor: nextCursor, userIds };
  }

  /** Atomically aligns one buyer membership with the reservation ledger. */
  async reconcileBuyerMembership(saleId: string, userId: string): Promise<'PRESENT' | 'ABSENT'> {
    assertSaleId(saleId);
    const keys = saleKeys(saleId);
    const raw = await runScript<string>(
      this.client,
      RECONCILE_MEMBERSHIP_SCRIPT,
      [keys.buyers, keys.reservations],
      [userId],
    );
    return assertMember(raw, RECONCILE_MEMBERSHIP_OUTCOMES, 'reconcile membership');
  }

  /** Identity-safe atomic restoration for Phase 3 reconciliation. */
  async compareAndRestoreReservation(
    saleId: string,
    input: CompareRestoreReservationInput,
  ): Promise<CompareRestoreReservationResult> {
    assertSaleId(saleId);
    assertCompareRestoreReservationInput(input);
    const keys = saleKeys(saleId);

    const raw = await runScript<[string, string]>(
      this.client,
      COMPARE_RESTORE_RESERVATION_SCRIPT,
      [keys.buyers, keys.reservations],
      [input.userId, input.reservationId, canonicalInt(input.reservedAtMs)],
    );
    const [code, currentValue] = raw;

    return {
      outcome: assertMember(
        code,
        COMPARE_RESTORE_RESERVATION_OUTCOMES,
        'compare-and-restore reservation',
      ),
      current: parseReservationEntry(input.userId, currentValue),
    };
  }

  /**
   * POST-FREEZE ADDITION (.claude/contracts/phase-1.md §11.2, finding 2). Cursor-paged
   * enumeration of the reservations hash via HSCAN — the primitive Phase 3's I4 boot
   * sweep needs and that §5.1's forbidden-command list (which bans SMEMBERS/HGETALL,
   * not SSCAN/HSCAN) already permits. O(1) per call, bounded by `count`, never blocks
   * the server the way a single SMEMBERS/HGETALL over a large container would (see the
   * `redis-connections` skill). Start with `cursor: '0'`; a returned cursor of `'0'`
   * means the scan is complete.
   */
  async scanReservations(
    saleId: string,
    cursor: string = '0',
    count: number = DEFAULT_SCAN_COUNT,
  ): Promise<{ cursor: string; entries: ReservationEntry[] }> {
    assertSaleId(saleId);
    const keys = saleKeys(saleId);

    const [nextCursor, flat] = await this.client.hscan(keys.reservations, cursor, 'COUNT', count);

    const entries: ReservationEntry[] = [];
    for (let i = 0; i < flat.length; i += 2) {
      const userId = flat[i]!;
      const value = flat[i + 1]!;
      entries.push(parseReservationEntry(userId, value));
    }

    return { cursor: nextCursor, entries };
  }

  /**
   * POST-FREEZE ADDITION (.claude/contracts/phase-1.md §11.2, finding 2). Cold-rebuild
   * primitive for Phase 3's I4 boot sweep ("diff Redis buyers set vs PG orders + queue;
   * re-enqueue missing" — PRD §3.5): restores both the buyers Set (the I2 guard) and
   * the reservations hash (the compensation-identity ledger) from an authoritative
   * source (Postgres persisted + reserved orders). Chunked, pipelined SADD + HSET —
   * no Lua atomicity requirement here because this runs once, offline, against a
   * caller-verified snapshot, not concurrently with live traffic.
   */
  async restoreReservations(
    saleId: string,
    entries: readonly ReservationRestoreInput[],
  ): Promise<void> {
    assertSaleId(saleId);
    if (entries.length === 0) return;
    const keys = saleKeys(saleId);

    for (let i = 0; i < entries.length; i += RESTORE_CHUNK_SIZE) {
      const chunk = entries.slice(i, i + RESTORE_CHUNK_SIZE);
      const pipeline = this.client.pipeline();
      for (const entry of chunk) {
        pipeline.sadd(keys.buyers, entry.userId);
        const reservedAtMs = entry.reservedAtMs ?? Date.now();
        pipeline.hset(keys.reservations, entry.userId, `${entry.reservationId}:${reservedAtMs}`);
      }
      const results = await pipeline.exec();
      if (results === null) {
        throw new Error(
          'SaleRedisStore.restoreReservations: pipeline aborted (connection not ready)',
        );
      }
      for (const [err] of results) {
        if (err) throw err;
      }
    }
  }

  /** One round trip, one clock. Backs GET /sale/status. */
  async status(saleId: string): Promise<SaleSnapshot> {
    assertSaleId(saleId);
    const keys = saleKeys(saleId);

    const raw = await runScript<
      [number, number, number, number, number, number, string, string, string]
    >(this.client, STATUS_SCRIPT, [keys.config, keys.stock], []);

    const [
      nowMs,
      initializedFlag,
      stockRemaining,
      totalStock,
      startsAtMs,
      endsAtMs,
      name,
      startsAt,
      endsAt,
    ] = raw;
    const initialized = initializedFlag === 1;

    if (!initialized) {
      // The contract does not pin a `SaleState` for an unconfigured sale (deriveSaleState
      // requires endsAtMs > startsAtMs, which a -1/-1 sentinel pair violates by
      // construction). 'upcoming' is the closest honest reading — a sale nobody has
      // seeded has certainly not started — and is consistent with the precedent in
      // .claude/contracts/phase-1.md §3.2 that 'upcoming' beats other states when a sale
      // has not truly begun. Flagged to the architect as a contract gap, not a silent
      // choice; see this slice's completion report.
      return {
        initialized: false,
        saleId,
        name: '',
        startsAt: '',
        endsAt: '',
        startsAtMs: 0,
        endsAtMs: 0,
        totalStock: 0,
        stockRemaining: 0,
        serverTimeMs: nowMs,
        state: 'upcoming',
      };
    }

    return {
      initialized: true,
      saleId,
      name,
      startsAt,
      endsAt,
      startsAtMs,
      endsAtMs,
      totalStock,
      stockRemaining,
      serverTimeMs: nowMs,
      state: deriveSaleState({ nowMs, startsAtMs, endsAtMs, stockRemaining }),
    };
  }

  /** SISMEMBER. Backs GET /purchase/:userId's Redis half. O(1), safe on the hot path. */
  async hasPurchased(saleId: string, userId: string): Promise<boolean> {
    assertSaleId(saleId);
    const keys = saleKeys(saleId);
    const result = await this.client.sismember(keys.buyers, userId);
    return result === 1;
  }

  /** HINCRBY on the metrics hash. Fire-and-forget; never throws to the caller. */
  async bumpMetric(
    saleId: string,
    outcome: PurchaseOutcome | 'RATE_LIMITED' | 'INVALID_USER_ID',
  ): Promise<void> {
    try {
      assertSaleId(saleId);
      const keys = saleKeys(saleId);
      const field = OUTCOME_METRIC_FIELD[outcome];
      await this.client.hincrby(keys.metrics, field, 1);
    } catch {
      // Deliberately swallowed: metrics are observability, not a correctness path.
      // A dropped metric increment must never surface as a purchase failure.
    }
  }

  /** HGETALL — the hash has <= 7 fields, so this is O(1) in practice. */
  async readMetrics(saleId: string): Promise<Record<string, number>> {
    assertSaleId(saleId);
    const keys = saleKeys(saleId);
    const raw = await this.client.hgetall(keys.metrics);
    const result: Record<string, number> = {};
    for (const [field, value] of Object.entries(raw)) {
      result[field] = Number(value);
    }
    return result;
  }

  async ping(): Promise<boolean> {
    try {
      const reply = await this.client.ping();
      return reply === 'PONG';
    } catch {
      return false;
    }
  }

  /**
   * TEST / OPS ONLY. DELs config, stock, buyers, metrics for one sale.
   * MUST NOT be exposed on any HTTP route in any phase.
   */
  async reset(saleId: string): Promise<void> {
    assertSaleId(saleId);
    const keys = saleKeys(saleId);
    await this.client.del(keys.config, keys.stock, keys.buyers, keys.metrics, keys.reservations);
  }
}
