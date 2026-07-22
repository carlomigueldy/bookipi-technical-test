/**
 * Per-user rate limiter — frozen contract `.claude/contracts/phase-2.md` §7.3.
 *
 * Registered per-route with `@UseGuards(PerUserRateLimitGuard)` on
 * `POST /api/purchase` ONLY (§4.3) — it is deliberately NOT an `APP_GUARD`,
 * because a global guard would run on `GET` routes that have no body and no
 * user.
 *
 * Nest guards run AFTER Fastify has parsed the body into `req.body` and
 * BEFORE pipes, so this guard sees an UNVALIDATED `req.body`. It therefore
 * duplicates only the cheapest possible pre-filter of `@flash/shared`'s
 * frozen `USER_ID_*` constants — never a re-declared regex — and defers the
 * real 422 to `ZodValidationPipe` a microsecond later (§6.7).
 *
 */
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { HttpException, Inject, Injectable, Logger } from '@nestjs/common';

import {
  PURCHASE_OUTCOME_HTTP_STATUS,
  USER_ID_MAX_LENGTH,
  USER_ID_MIN_LENGTH,
  USER_ID_PATTERN,
} from '@flash/shared';

import { API_ENV, REDIS_LIMIT_CLIENT } from './tokens.js';

/** FROZEN key prefix (phase-2.md §7.2 / §7.4.4). */
export const RATE_LIMIT_USER_KEY_PREFIX = 'rl:u:';

/**
 * Fallback bucket segment for the vanishingly rare case Fastify hands back no
 * `request.ip` at all (never observed in practice — `trustProxy` always
 * resolves to *some* socket address). Kept distinct from any real IP octet
 * shape so it can never collide with one.
 */
const UNKNOWN_IP_SEGMENT = 'unknown-ip';

/**
 * Minimal structural view of the single ioredis operation this guard uses.
 * A real `ioredis.Redis` instance satisfies it without an adapter.
 */
export interface RedisLimiterClient {
  eval(script: string, numberOfKeys: number, key: string, windowMs: string): Promise<unknown>;
}

export const RATE_LIMIT_USER_SCRIPT = `
local ttl = redis.call('PTTL', KEYS[1])
if ttl < 0 then
  redis.call('SET', KEYS[1], '1', 'PX', ARGV[1])
  return {1, tonumber(ARGV[1])}
end
local count = redis.call('INCR', KEYS[1])
return {count, ttl}
`.trim();

/** Structural subset of `ApiEnv` (`config/env.ts`) this guard depends on. */
export interface PerUserRateLimitEnv {
  SALE_ID: string;
  RATE_LIMIT_USER_MAX: number;
  RATE_LIMIT_USER_WINDOW_MS: number;
}

/** Structural view of the Fastify reply object Nest hands back for this adapter. */
export interface FastifyReplyLike {
  header(name: string, value: string): unknown;
}

/**
 * REVIEW FIX (major, security): the bucket key now includes the caller's own
 * source IP, not just `{saleId}:{userId}` alone.
 *
 * Why: `userId` is asserted by the CLIENT in an unauthenticated request body
 * (PRD §2 scopes real auth out — "user identifier string only, per brief").
 * Before this fix, the bucket `rl:u:{saleId}:{userId}` was keyed ENTIRELY on
 * that attacker-controlled string. Any third party could send a handful of
 * requests per second carrying a *victim's* `userId` and permanently
 * exhaust the victim's own budget for the rest of the sale window — a
 * targeted denial-of-purchase costing the attacker only their OWN per-IP
 * budget, at a victim-to-attacker-request ratio of 1:1. The per-IP limiter
 * (§7.1/§7.2) does not help: the attacker never leaves their own budget.
 *
 * Folding the caller's IP into the key means an attacker spamming a
 * victim's `userId` from a different address burns down a bucket unique to
 * (attacker IP, victim userId) — a completely different key from the one
 * the victim's own traffic, from the victim's own IP, increments. The
 * victim's genuine attempts are therefore never starved by a stranger.
 * `PRD §6.2`'s duplicate-storm scenario (5k users x 10 concurrent retries
 * EACH FROM THAT USER'S OWN CLIENT) is unaffected: those retries still share
 * one (ip, userId) pair and are still bounded exactly as before.
 *
 * CONTRACT ERRATUM: phase-2.md §7.2's Key column literally pins
 * `rl:u:{saleId}:{userId}`. That format is the defect this fix corrects —
 * the same category of "genuine contract defect, discovered empirically and
 * corrected in code" already precedented by `orders-queue.service.ts`'s
 * jobId-separator fix. The frozen PREFIX (`rl:u:`, §7.4.4) is unchanged;
 * only what follows it gains an IP segment. See §7 of the contract for the
 * erratum note.
 */
function buildUserRateLimitKey(saleId: string, ip: string | undefined, userId: string): string {
  return `${RATE_LIMIT_USER_KEY_PREFIX}${saleId}:${ip ?? UNKNOWN_IP_SEGMENT}:${userId}`;
}

/** Exported test-only alias so specs assert against the real key derivation, never a re-typed duplicate. */
export const buildUserRateLimitKeyForTest = buildUserRateLimitKey;

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Extracts a rate-limitable candidate userId from an UNVALIDATED request
 * body — §7.3 steps 1-2, exactly.
 *
 * Returns `null` whenever there is no plausible identity to limit on: the
 * body is missing/non-object, `userId` isn't a string, or the trimmed value
 * fails the identical length/pattern bounds `purchaseRequestSchema` will
 * enforce a moment later via `ZodValidationPipe`. In every `null` case the
 * caller must return `true` (do not rate-limit) — the request is already
 * covered by the per-IP limiter, and the pipe will 422 it.
 */
export function extractRateLimitCandidateUserId(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const raw = (body as Record<string, unknown>).userId;
  if (typeof raw !== 'string') return null;

  const candidate = raw.trim();
  if (candidate.length < USER_ID_MIN_LENGTH || candidate.length > USER_ID_MAX_LENGTH) return null;
  if (!USER_ID_PATTERN.test(candidate)) return null;

  return candidate;
}

@Injectable()
export class PerUserRateLimitGuard implements CanActivate {
  private readonly logger = new Logger(PerUserRateLimitGuard.name);

  constructor(
    @Inject(REDIS_LIMIT_CLIENT) private readonly redis: RedisLimiterClient,
    @Inject(API_ENV) private readonly env: PerUserRateLimitEnv,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<{ body?: unknown; ip?: string }>();
    const candidate = extractRateLimitCandidateUserId(request.body);
    // No usable identity -> do NOT rate-limit per-user (§7.3 step 1). This is
    // also what keeps key cardinality bounded (§7.4.1): an invalid/junk
    // userId never reaches the Redis I/O below, so it never mints a key.
    if (candidate === null) return true;

    // `request.ip` is the SAME Fastify-derived address the per-IP limiter
    // itself keys on (§7.7 — `trustProxy`-aware; a bare socket address unless
    // an operator has explicitly declared a trusted proxy). Folding it into
    // the per-user key is this file's fix for the third-party-exhaustion
    // finding — see `buildUserRateLimitKey`'s doc comment.
    const key = buildUserRateLimitKey(this.env.SALE_ID, request.ip, candidate);
    const windowMs = this.env.RATE_LIMIT_USER_WINDOW_MS;

    let decision: { count: number; ttlMs: number };
    try {
      decision = await this.incrementAndBound(key, windowMs);
    } catch (err) {
      // §7.6 — fail OPEN, deliberately. The limiter is a stability control,
      // not a correctness control (I1-I4 live in Lua/PG); a limiter-store
      // hiccup must not become a purchase outage.
      this.logger.warn({
        event: 'ratelimit.store_unavailable',
        key,
        err: describeError(err),
      });
      return true;
    }

    if (decision.count <= this.env.RATE_LIMIT_USER_MAX) return true;

    const retryAfterSeconds = Math.max(1, Math.ceil(decision.ttlMs / 1000));
    this.reject(context, retryAfterSeconds, candidate);
  }

  /**
   * A single atomic EVAL creates a finite fixed window, heals legacy keys
   * without a TTL, or increments an existing bucket without extending it.
   * The returned TTL is authoritative for Retry-After, so there is no second
   * Redis request and no partial INCR/PEXPIRE state to compensate.
   */
  private async incrementAndBound(
    key: string,
    windowMs: number,
  ): Promise<{ count: number; ttlMs: number }> {
    const reply = await this.redis.eval(RATE_LIMIT_USER_SCRIPT, 1, key, String(windowMs));
    if (!Array.isArray(reply) || reply.length !== 2) {
      throw new Error('rate limiter EVAL returned a malformed reply');
    }

    const [rawCount, rawTtl] = reply;
    const count = typeof rawCount === 'number' ? rawCount : Number(rawCount);
    const ttlMs = typeof rawTtl === 'number' ? rawTtl : Number(rawTtl);
    if (
      !Number.isFinite(count) ||
      !Number.isInteger(count) ||
      count < 1 ||
      !Number.isFinite(ttlMs) ||
      !Number.isInteger(ttlMs) ||
      ttlMs <= 0
    ) {
      throw new Error('rate limiter EVAL returned a non-numeric reply');
    }

    return { count, ttlMs };
  }

  /** Headers + body shape per §7.5. Always throws. */
  private reject(context: ExecutionContext, retryAfterSeconds: number, candidate: string): never {
    const reply = context.switchToHttp().getResponse<FastifyReplyLike>();
    reply.header('retry-after', String(retryAfterSeconds));
    reply.header('x-ratelimit-limit', String(this.env.RATE_LIMIT_USER_MAX));
    reply.header('x-ratelimit-remaining', '0');
    reply.header('x-ratelimit-reset', String(retryAfterSeconds));

    // Mirrors the ZodValidationPipe convention (§6.7): a payload carrying
    // `{ outcome: 'RATE_LIMITED' }` for `HttpExceptionFilter` to render as
    // the `purchaseResponseSchema` envelope (this guard only ever runs on
    // `POST /api/purchase`, per §4.3) with `status: 'RATE_LIMITED'`,
    // `stockRemaining: null`. `userId` is the ALREADY schema-plausible
    // candidate (§7.3 step 2 already passed) — echoing it lets the filter
    // build a faithful envelope instead of an empty string; purely additive
    // relative to the shape asserted by this file's own spec (`toMatchObject`
    // partial-match), so existing coverage stays green unmodified.
    throw new HttpException(
      { outcome: 'RATE_LIMITED' as const, userId: candidate },
      PURCHASE_OUTCOME_HTTP_STATUS.RATE_LIMITED,
    );
  }
}
