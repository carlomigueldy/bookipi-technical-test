/**
 * The global exception filter — frozen contract §6.7 point 2, §10.3.
 *
 * Registered ONCE as the app-wide `APP_FILTER` (`app.module.ts`). It is the
 * ONLY place a response body is shaped for an error, and the last line
 * against information disclosure: no stack trace, no raw `Error.message`,
 * no dependency name, no file path, no Zod `issues` array ever reaches a
 * client (§10.3) — while the real cause is always logged server-side with
 * the request id, so an operator can correlate the two.
 *
 * Note what this filter does NOT do: it never renders a `PurchaseOutcome`
 * for `CONFIRMED` / `ALREADY_PURCHASED` / `SOLD_OUT` / `SALE_NOT_STARTED` /
 * `SALE_ENDED` / `NOT_INITIALIZED` (Lua-decided outcomes) — `PurchaseController`
 * (Slice C) builds and returns those directly via `@Res({ passthrough: true })`,
 * so they never become a thrown exception in the first place. This filter
 * only ever sees: (a) `ZodValidationPipe`'s 422 `INVALID_USER_ID`,
 * (b) `PerUserRateLimitGuard`'s 429 `RATE_LIMITED`, (c) `SaleService`'s 503
 * `NOT_INITIALIZED` (`ServiceUnavailableException`), (d) Fastify's own
 * body-parse-stage errors, (e) an unmatched route (404), (f) anything else
 * (500). (a)/(b)/(c) all carry a machine-readable `outcome` field in their
 * exception payload — the dispatch below is driven by that field's presence,
 * not by a hardcoded list of exception classes, so it generalizes to any
 * future outcome-carrying exception without this file changing.
 */
import {
  Catch,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';

import {
  ATTEMPT_OUTCOMES,
  API_GLOBAL_PREFIX,
  USER_ID_MAX_LENGTH,
  USER_ID_PATTERN,
  type AttemptOutcome,
} from '@flash/shared';
import type { PurchaseResponse } from '@flash/shared/schemas';

import { buildApiErrorResponse, type ApiErrorCode } from './dto/api-error.js';
import { messageFor } from './messages.js';
import { requestIdFromFastify } from './request-id.js';
import { API_ENV, CLOCK } from './tokens.js';
import type { ApiEnv } from '../config/env.js';
import type { Clock } from '../infra/clock.service.js';

/** `POST /api/purchase` — the ONE route whose error responses use the
 * `purchaseResponseSchema` envelope instead of `ApiErrorResponse` (§6.4, §7.5). */
const PURCHASE_ROUTE_PATH = `/${API_GLOBAL_PREFIX}/purchase`;

/** Fastify's own content-type/body-parser error codes (§6.7 point 2's table). */
const FASTIFY_BODY_PARSE_ERROR_CODES = new Set([
  'FST_ERR_CTP_INVALID_MEDIA_TYPE',
  'FST_ERR_CTP_EMPTY_JSON_BODY',
  // The actual code Fastify's default JSON content-type parser raises for
  // syntactically-malformed JSON (verified against upstream fastify/fastify
  // source, `lib/content-type-parser.js`'s `defaultJsonParser`) — NOT a bare
  // `SyntaxError` by the time it reaches this filter, and NOT
  // `FST_ERR_CTP_INVALID_MEDIA_TYPE` (that one is for an unrecognised
  // `content-type` header entirely, a different failure mode). Omitting this
  // code left every malformed-JSON purchase falling through to the generic
  // 500 `INTERNAL` branch instead of the frozen 422 `INVALID_USER_ID`.
  'FST_ERR_CTP_INVALID_JSON_BODY',
  'FST_ERR_CTP_BODY_TOO_LARGE',
]);

const ATTEMPT_OUTCOME_SET = new Set<string>(ATTEMPT_OUTCOMES);

function isAttemptOutcome(value: unknown): value is AttemptOutcome {
  return typeof value === 'string' && ATTEMPT_OUTCOME_SET.has(value);
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * `@fastify/rate-limit`'s `onRequest` hook (registered in `main.ts` /
 * `test/support/app-harness.ts`) does `throw params.errorResponseBuilder(...)`
 * — verified against the plugin's own source (upstream fastify/fastify-rate-limit,
 * `rateLimitRequestHandler`). That throw happens BEFORE Nest ever routes the
 * request, but `@nestjs/platform-fastify`'s error handling still funnels it
 * into this filter rather than Fastify's own default error handler, so it
 * reaches `catch()` below as a plain object — NEVER an `HttpException`
 * instance — carrying a non-enumerable numeric `statusCode` (429, or 403 if
 * banned) and the ALREADY-CORRECT frozen envelope
 * (`common/rate-limit-error.ts`'s `buildRateLimitedThrowable`, §6.4/§6.6/§7.5).
 * Recognizing it by its own `RATE_LIMITED` marker (rather than a bare
 * `typeof statusCode === 'number'` check, which could accidentally match an
 * unrelated thrown object) and sending it through verbatim is what makes the
 * limiter's 429 render as 429 instead of falling through to this filter's
 * generic 500 `INTERNAL` branch.
 */
function isRateLimitedEnvelope(
  value: unknown,
): value is (PurchaseResponse | { error: string }) & { statusCode: number } {
  if (typeof value !== 'object' || value === null) return false;
  const rec = value as Record<string, unknown>;
  const isRateLimited = rec.status === 'RATE_LIMITED' || rec.error === 'RATE_LIMITED';
  return isRateLimited && typeof rec.statusCode === 'number';
}

/**
 * The EXACT, fixed messages Fastify's own body/content-type parsing raises
 * (verified against upstream fastify/fastify's `lib/errors.js` — none of
 * these four take template arguments, so the message is always this literal
 * string). Needed because `@nestjs/platform-fastify` re-wraps the RAW
 * Fastify error (which carries a `FST_ERR_CTP_*` `.code`) into a generic
 * `HttpException` whose `.getResponse()` is a bare STRING and whose own
 * `.code` is GONE by the time it reaches this filter (verified empirically:
 * an `HttpException` instance with `keys: ['response','status','options',
 * 'message','name']` — no `.code`, no `.cause`, `.options` empty) — so the
 * `FASTIFY_BODY_PARSE_ERROR_CODES` check below only ever matches an
 * UNWRAPPED error (still possible via other Fastify integration points).
 *
 * Matching on the EXACT message (not just "some HttpException at status
 * 400/413/415") is deliberate and load-bearing: this app's OWN unit spec
 * (`http-exception.filter.spec.ts`, "defensive fallback ... never leaks the
 * exception .message") constructs a generic `new HttpException('some
 * internal Nest detail...', 400)` specifically to prove that an
 * ARBITRARY 400 HttpException stays on the generic fallback path — an
 * earlier, broader status-code-only version of this check (matching ANY
 * string-response HttpException at 400/413/415) broke that exact
 * expectation, which is precisely the false positive an exact-message
 * allowlist is immune to.
 */
const FASTIFY_BODY_PARSE_MESSAGES = new Set([
  "Body is not valid JSON but content-type is set to 'application/json'", // FST_ERR_CTP_INVALID_JSON_BODY, 400
  "Body cannot be empty when content-type is set to 'application/json'", // FST_ERR_CTP_EMPTY_JSON_BODY, 400
  'Request body is too large', // FST_ERR_CTP_BODY_TOO_LARGE, 413
  'Unsupported Media Type', // FST_ERR_CTP_INVALID_MEDIA_TYPE, 415
]);

function isBodyParseFailure(err: unknown): boolean {
  if (err instanceof SyntaxError) return true;
  if (typeof err === 'object' && err !== null && 'code' in err) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'string' && FASTIFY_BODY_PARSE_ERROR_CODES.has(code)) return true;
  }
  if (err instanceof HttpException) {
    const response = err.getResponse();
    if (typeof response === 'string' && FASTIFY_BODY_PARSE_MESSAGES.has(response)) {
      return true;
    }
  }
  return false;
}

function requestPath(request: FastifyRequest): string {
  const url = request.url ?? '';
  const queryIndex = url.indexOf('?');
  return queryIndex === -1 ? url : url.slice(0, queryIndex);
}

/**
 * §10.3: "the response's `userId` field echoes the input truncated to
 * `USER_ID_MAX_LENGTH` and with all characters outside `USER_ID_PATTERN`
 * stripped". Reuses `USER_ID_PATTERN` (a whole-string `+`-quantified
 * pattern) as a per-character tester — a single character trivially
 * satisfies "one or more" — rather than re-declaring a character-class
 * regex, per the same discipline `PerUserRateLimitGuard` names in its own
 * header comment.
 */
function sanitizeUserIdEcho(raw: string): string {
  const truncated = raw.slice(0, USER_ID_MAX_LENGTH);
  let out = '';
  for (const ch of truncated) {
    if (USER_ID_PATTERN.test(ch)) out += ch;
  }
  return out;
}

interface OutcomeExceptionPayload {
  outcome: string;
  issues?: unknown;
  rawUserId?: string;
  userId?: string;
}

function extractOutcomePayload(response: unknown): OutcomeExceptionPayload | null {
  if (typeof response !== 'object' || response === null) return null;
  const rec = response as Record<string, unknown>;
  if (typeof rec.outcome !== 'string') return null;
  return {
    outcome: rec.outcome,
    issues: 'issues' in rec ? rec.issues : undefined,
    rawUserId: typeof rec.rawUserId === 'string' ? rec.rawUserId : undefined,
    userId: typeof rec.userId === 'string' ? rec.userId : undefined,
  };
}

@Injectable()
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  constructor(
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(API_ENV) private readonly env: ApiEnv,
  ) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const request = ctx.getRequest<FastifyRequest>();
    const reply = ctx.getResponse<FastifyReply>();

    const requestId = requestIdFromFastify(request);
    const serverTimeMs = this.clock.nowMs();
    const path = requestPath(request);

    // (d) Fastify's own content-type/body-parser errors — occur inside the
    // per-route handler Nest wraps, so they DO reach this filter, but are
    // never `HttpException` instances. Contract §6.7 point 2 maps all of
    // these to 422 INVALID_USER_ID: the body was syntactically or
    // structurally wrong before Nest's own validation ever ran.
    if (isBodyParseFailure(exception)) {
      this.logger.debug({ requestId, err: describeError(exception) }, 'body_parse.rejected');
      this.respond(
        reply,
        HttpStatus.UNPROCESSABLE_ENTITY,
        'INVALID_USER_ID',
        path,
        requestId,
        serverTimeMs,
        '',
      );
      return;
    }

    // (b) — `@fastify/rate-limit`'s thrown 429/403, already a complete, correct
    // envelope built by `buildRateLimitedThrowable` — see that function's own
    // comment and `isRateLimitedEnvelope`'s header comment above.
    if (isRateLimitedEnvelope(exception)) {
      void reply.status(exception.statusCode).send(exception);
      return;
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const payload = extractOutcomePayload(exception.getResponse());

      // (a)/(b)/(c) — any exception carrying a machine-readable `outcome`
      // (ZodValidationPipe's INVALID_USER_ID, PerUserRateLimitGuard's
      // RATE_LIMITED, SaleService's NOT_INITIALIZED, or any future
      // outcome-carrying exception built the same way).
      if (payload && isAttemptOutcome(payload.outcome)) {
        if (payload.issues !== undefined) {
          this.logger.debug({ requestId, issues: payload.issues }, 'validation.rejected');
        }
        const echoUserId =
          payload.outcome === 'INVALID_USER_ID'
            ? sanitizeUserIdEcho(payload.rawUserId ?? '')
            : (payload.userId ?? '');
        this.respond(reply, status, payload.outcome, path, requestId, serverTimeMs, echoUserId);
        return;
      }

      // (e) — an unmatched route.
      if (exception instanceof NotFoundException) {
        this.sendApiError(reply, HttpStatus.NOT_FOUND, 'NOT_FOUND', requestId, serverTimeMs);
        return;
      }

      // Defensive fallback: an `HttpException` this app did not itself
      // construct with an `outcome` payload. Never leak its `.message` —
      // log it server-side and render the generic envelope at its own
      // status code (falling back to 500 for anything outside the valid
      // HTTP status range).
      this.logger.error(
        { requestId, status, err: describeError(exception) },
        'http_exception.unmapped',
      );
      const safeStatus = status >= 400 && status < 600 ? status : HttpStatus.INTERNAL_SERVER_ERROR;
      this.sendApiError(reply, safeStatus, 'INTERNAL', requestId, serverTimeMs);
      return;
    }

    // (f) — genuinely unexpected: a raw ioredis/pg error, a programming
    // error, anything not wrapped in an HttpException. The ONLY branch that
    // logs a stack trace — and it NEVER reaches the response body (§10.3).
    this.logger.error(
      {
        requestId,
        err: describeError(exception),
        stack: exception instanceof Error ? exception.stack : undefined,
      },
      'unhandled_exception',
    );
    this.sendApiError(reply, HttpStatus.INTERNAL_SERVER_ERROR, 'INTERNAL', requestId, serverTimeMs);
  }

  /** Dispatches an outcome-bearing response to the correct envelope shape (§6.4/§7.5 vs §6.6). */
  private respond(
    reply: FastifyReply,
    status: number,
    outcome: AttemptOutcome,
    path: string,
    requestId: string,
    serverTimeMs: number,
    userId: string,
  ): void {
    if (path === PURCHASE_ROUTE_PATH) {
      const body: PurchaseResponse = {
        status: outcome,
        userId,
        saleId: this.env.SALE_ID,
        stockRemaining: null,
        serverTime: new Date(serverTimeMs).toISOString(),
        serverTimeMs,
        message: messageFor(outcome),
      };
      void reply.status(status).send(body);
      return;
    }
    this.sendApiError(reply, status, outcome, requestId, serverTimeMs);
  }

  private sendApiError(
    reply: FastifyReply,
    status: number,
    error: ApiErrorCode,
    requestId: string,
    serverTimeMs: number,
  ): void {
    const body = buildApiErrorResponse({
      error,
      message: messageFor(error),
      requestId,
      serverTimeMs,
    });
    void reply.status(status).send(body);
  }
}
