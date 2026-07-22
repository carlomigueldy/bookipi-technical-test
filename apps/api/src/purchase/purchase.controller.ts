// apps/api/src/purchase/purchase.controller.ts  [SLICE C — frozen contract §6.4, §6.5]
//
// `POST /api/purchase`'s response is built HERE, not in the service: `PurchaseService`
// returns the bare decision (§8's `PurchaseDecision`) and this controller is the ONLY
// place that resolves it to an HTTP status (via the frozen `PURCHASE_OUTCOME_HTTP_
// STATUS` map — never an integer literal) and the full envelope (via
// `buildPurchaseEnvelope`).
// This split is deliberate, not cosmetic: the frozen contract's negative control
// (§11.4) works by swapping in a deliberately non-atomic stand-in `PurchaseService`
// (see `test/support/` under Slice E) while driving this SAME controller over real
// HTTP. Keeping the envelope/status resolution here — using only `SALE_ID`
// (independently injected) plus the minimal `{outcome, stockRemaining, serverTimeMs,
// reservationId}` shape both the real and the stand-in service produce — means the
// swap stays transparent: the stand-in implementation's oversold `CONFIRMED`s still
// render as real 201s the money test's negative control can count.
//
// Written via `@Res({ passthrough: true })`, NOT thrown as a Nest exception, because
// the global `HttpExceptionFilter` (SLICE A) has no special-cased knowledge of the
// `PURCHASE_OUTCOME_HTTP_STATUS` map — only `INVALID_USER_ID` (via
// `ZodValidationPipe`) and `RATE_LIMITED` (via the rate-limit plugin /
// `PerUserRateLimitGuard`) are exceptions the filter renders. `passthrough: true`
// preserves normal Nest response handling (the returned value is still sent as the
// JSON body) while letting this controller set the status code and the `Retry-After`
// header explicitly. See NestJS docs, "Library-specific approach".
import { randomUUID } from 'node:crypto';

import { Body, Controller, Get, Inject, Param, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { PURCHASE_OUTCOME_HTTP_STATUS } from '@flash/shared';
import { purchaseRequestSchema, purchaseStatusParamsSchema } from '@flash/shared/schemas';
import type {
  PurchaseRequest,
  PurchaseResponse,
  PurchaseStatusParams,
  PurchaseStatusResponse,
} from '@flash/shared/schemas';

import type { ApiErrorResponse } from '../common/dto/api-error.js';
import { PerUserRateLimitGuard } from '../common/per-user-rate-limit.guard.js';
import { API_ENV } from '../common/tokens.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import type { ApiEnv } from '../config/env.js';

import { PurchaseStatusService } from './purchase-status.service.js';
import { buildPurchaseEnvelope, PurchaseService } from './purchase.service.js';

const RETRY_AFTER_SECONDS = '1';
const PURCHASE_SERVICE_UNAVAILABLE_STATUS = PURCHASE_OUTCOME_HTTP_STATUS.NOT_INITIALIZED;
const PURCHASE_STATUS_SERVICE_UNAVAILABLE_STATUS =
  PURCHASE_OUTCOME_HTTP_STATUS.UPSTREAM_UNAVAILABLE;

/** Fastify natively assigns `request.id` (see `common/request-id.ts`'s `genReqId` — SLICE A); falls back to a fresh UUID only if a request somehow reaches this handler without one. */
function requestIdOf(req: FastifyRequest): string {
  return typeof req.id === 'string' && req.id.length > 0 ? req.id : randomUUID();
}

@Controller('purchase')
export class PurchaseController {
  constructor(
    private readonly purchaseService: PurchaseService,
    private readonly purchaseStatusService: PurchaseStatusService,
    @Inject(API_ENV) private readonly env: ApiEnv,
  ) {}

  @Post()
  @UseGuards(PerUserRateLimitGuard)
  async create(
    @Body(new ZodValidationPipe(purchaseRequestSchema)) body: PurchaseRequest,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) res: FastifyReply,
  ): Promise<PurchaseResponse> {
    const requestId = requestIdOf(req);
    const decision = await this.purchaseService.purchase(body.userId, requestId);
    const httpStatus = PURCHASE_OUTCOME_HTTP_STATUS[decision.outcome];
    const envelope = buildPurchaseEnvelope({
      outcome: decision.outcome,
      userId: body.userId,
      saleId: this.env.SALE_ID,
      stockRemaining: decision.stockRemaining,
      serverTimeMs: decision.serverTimeMs,
    });

    if (httpStatus === PURCHASE_SERVICE_UNAVAILABLE_STATUS) {
      res.header('retry-after', RETRY_AFTER_SECONDS);
    }
    res.status(httpStatus);
    return envelope;
  }

  @Get(':userId')
  async status(
    @Param(new ZodValidationPipe(purchaseStatusParamsSchema)) params: PurchaseStatusParams,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) res: FastifyReply,
  ): Promise<PurchaseStatusResponse | ApiErrorResponse> {
    const requestId = requestIdOf(req);
    const { httpStatus, body } = await this.purchaseStatusService.getStatus(
      params.userId,
      requestId,
    );

    if (httpStatus === PURCHASE_STATUS_SERVICE_UNAVAILABLE_STATUS) {
      res.header('retry-after', RETRY_AFTER_SECONDS);
    }
    res.status(httpStatus);
    return body;
  }
}
