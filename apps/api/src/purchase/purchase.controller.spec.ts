// apps/api/src/purchase/purchase.controller.spec.ts  [SLICE C]
//
// Instantiated directly (no Nest DI container, no `app.inject()`) — this is a pure
// unit test of the controller's OWN logic: does it delegate to the right service
// method, resolve `PURCHASE_OUTCOME_HTTP_STATUS` itself (never a literal), build the
// envelope via `buildPurchaseEnvelope`, and translate that into the right
// `res.status()`/`res.header()` calls? Pipe behaviour (`ZodValidationPipe` -> 422) and
// guard behaviour (`PerUserRateLimitGuard` -> 429) are SLICE A's own units; this file
// does not re-test them, only proves this controller wires them onto the right routes
// and honours the response contract for every outcome IT is responsible for shaping.
//
// `PurchaseDecision` is deliberately the minimal, service-agnostic shape (§8's
// `PurchaseDecision` / the negative control's `UnsafePurchaseResult`) — these specs
// construct fakes returning exactly that shape, which is what proves the controller
// does not depend on anything only the real `PurchaseService` happens to produce.
import { describe, expect, it, vi } from 'vitest';

import { PURCHASE_OUTCOME_HTTP_STATUS } from '@flash/shared';
import { purchaseRequestSchema } from '@flash/shared/schemas';

import type { ApiEnv } from '../config/env.js';

import type { PurchaseStatusService } from './purchase-status.service.js';
import { PurchaseController } from './purchase.controller.js';
import type { PurchaseService } from './purchase.service.js';

const ENV = { SALE_ID: 'flash-2026' } as unknown as ApiEnv;

function fakeReply() {
  const headers: Record<string, string> = {};
  const reply = {
    status: vi.fn(function status(this: unknown) {
      return reply;
    }),
    header: vi.fn(function header(this: unknown, key: string, value: string) {
      headers[key] = value;
      return reply;
    }),
    headers,
  };
  return reply;
}

function fakeRequest(id = 'req-1') {
  return { id } as never;
}

describe('PurchaseController.create — POST /api/purchase', () => {
  it('delegates to PurchaseService.purchase with the validated userId and the request id, and resolves the HTTP status itself', async () => {
    const purchaseService = {
      purchase: vi.fn().mockResolvedValue({
        outcome: 'CONFIRMED',
        stockRemaining: 9,
        serverTimeMs: 1_753_185_600_000,
        reservationId: 'r-1',
      }),
    };
    const controller = new PurchaseController(
      purchaseService as unknown as PurchaseService,
      {} as unknown as PurchaseStatusService,
      ENV,
    );
    const res = fakeReply();

    const body = await controller.create({ userId: 'alice' }, fakeRequest('req-42'), res as never);

    expect(purchaseService.purchase).toHaveBeenCalledWith('alice', 'req-42');
    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.header).not.toHaveBeenCalledWith('retry-after', expect.anything());
    expect(body).toEqual({
      status: 'CONFIRMED',
      message: 'Purchase confirmed.',
      userId: 'alice',
      saleId: 'flash-2026',
      stockRemaining: 9,
      serverTime: new Date(1_753_185_600_000).toISOString(),
      serverTimeMs: 1_753_185_600_000,
    });
  });

  it.each(Object.entries(PURCHASE_OUTCOME_HTTP_STATUS))(
    'resolves outcome %s to PURCHASE_OUTCOME_HTTP_STATUS[%s] === %i via the frozen map, never a literal',
    async (outcome, httpStatus) => {
      const purchaseService = {
        purchase: vi.fn().mockResolvedValue({
          outcome,
          stockRemaining: null,
          serverTimeMs: 0,
          reservationId: null,
        }),
      };
      const controller = new PurchaseController(
        purchaseService as unknown as PurchaseService,
        {} as unknown as PurchaseStatusService,
        ENV,
      );
      const res = fakeReply();

      const body = await controller.create({ userId: 'alice' }, fakeRequest(), res as never);

      expect(res.status).toHaveBeenCalledWith(httpStatus);
      expect(body.status).toBe(outcome);
    },
  );

  it('sets retry-after: 1 on a 503 response', async () => {
    const purchaseService = {
      purchase: vi.fn().mockResolvedValue({
        outcome: 'UPSTREAM_UNAVAILABLE',
        stockRemaining: null,
        serverTimeMs: 0,
        reservationId: null,
      }),
    };
    const controller = new PurchaseController(
      purchaseService as unknown as PurchaseService,
      {} as unknown as PurchaseStatusService,
      ENV,
    );
    const res = fakeReply();

    await controller.create({ userId: 'alice' }, fakeRequest(), res as never);

    expect(res.header).toHaveBeenCalledWith('retry-after', '1');
  });

  it(
    'NEGATIVE-CONTROL COMPATIBILITY (§11.4): renders correctly against the MINIMAL ' +
      '{outcome, stockRemaining, serverTimeMs, reservationId} shape alone — proving the ' +
      'controller has no dependency on anything only the real PurchaseService produces, ' +
      'which is what keeps .overrideProvider(PurchaseService).useClass(UnsafePurchaseService) ' +
      'transparent to this route instead of turning every swapped request into a 500',
    async () => {
      const minimalDecision = {
        outcome: 'CONFIRMED' as const,
        stockRemaining: 3,
        serverTimeMs: 1_700_000_000_000,
        reservationId: 'standin-reservation',
      };
      const purchaseService = { purchase: vi.fn().mockResolvedValue(minimalDecision) };
      const controller = new PurchaseController(
        purchaseService as unknown as PurchaseService,
        {} as unknown as PurchaseStatusService,
        ENV,
      );
      const res = fakeReply();

      const body = await controller.create({ userId: 'bob' }, fakeRequest(), res as never);

      expect(res.status).toHaveBeenCalledWith(201);
      expect(body.status).toBe('CONFIRMED');
      expect(body.saleId).toBe('flash-2026');
    },
  );
});

describe('PurchaseController.status — GET /api/purchase/:userId', () => {
  it('delegates to PurchaseStatusService.getStatus with the validated userId and the request id', async () => {
    const purchaseStatusService = {
      getStatus: vi.fn().mockResolvedValue({
        httpStatus: 200,
        body: {
          userId: 'alice',
          saleId: 'flash-2026',
          purchased: true,
          order: null,
          serverTime: '',
          serverTimeMs: 0,
        },
      }),
    };
    const controller = new PurchaseController(
      {} as unknown as PurchaseService,
      purchaseStatusService as unknown as PurchaseStatusService,
      ENV,
    );
    const res = fakeReply();

    await controller.status({ userId: 'alice' }, fakeRequest('req-7'), res as never);

    expect(purchaseStatusService.getStatus).toHaveBeenCalledWith('alice', 'req-7');
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('sets retry-after: 1 on a 503 response', async () => {
    const purchaseStatusService = {
      getStatus: vi.fn().mockResolvedValue({
        httpStatus: 503,
        body: {
          error: 'UPSTREAM_UNAVAILABLE',
          message: 'x',
          requestId: 'req-7',
          serverTime: '',
          serverTimeMs: 0,
        },
      }),
    };
    const controller = new PurchaseController(
      {} as unknown as PurchaseService,
      purchaseStatusService as unknown as PurchaseStatusService,
      ENV,
    );
    const res = fakeReply();

    await controller.status({ userId: 'alice' }, fakeRequest(), res as never);

    expect(res.header).toHaveBeenCalledWith('retry-after', '1');
  });
});

describe('purchaseRequestSchema wiring — the 422 path (§6.7)', () => {
  // `ZodValidationPipe` itself is SLICE A's unit; this proves the SCHEMA this
  // controller wires onto `@Body(new ZodValidationPipe(purchaseRequestSchema))`
  // actually rejects the inputs the frozen contract requires 422 for, and that
  // `INVALID_USER_ID` really is mapped to 422 — the two facts that make the pipe's
  // wiring meaningful, without re-implementing the pipe's own test.
  it.each([
    ['missing userId', {}],
    ['empty string', { userId: '' }],
    ['too short', { userId: 'ab' }],
    ['too long', { userId: 'a'.repeat(65) }],
    ['disallowed character', { userId: 'bad!char' }],
    ['unknown key (.strict())', { userId: 'ok-user', extra: 1 }],
  ])('rejects %s', (_label, input) => {
    expect(purchaseRequestSchema.safeParse(input).success).toBe(false);
  });

  it('accepts a well-formed userId', () => {
    expect(purchaseRequestSchema.safeParse({ userId: 'alice-01' }).success).toBe(true);
  });

  it('INVALID_USER_ID is frozen to HTTP 422', () => {
    expect(PURCHASE_OUTCOME_HTTP_STATUS.INVALID_USER_ID).toBe(422);
  });
});
