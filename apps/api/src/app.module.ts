import type { IncomingMessage } from 'node:http';
import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { LoggerModule } from 'nestjs-pino';

import { HttpExceptionFilter } from './common/http-exception.filter.js';
import { extractOrGenerateRequestId } from './common/request-id.js';
import { env } from './config/env.js';

/**
 * `main.ts`'s `FastifyAdapter({ genReqId })` is the AUTHORITATIVE id
 * resolver (§10.4) — it runs once, at request-construction time, and its
 * result becomes Fastify's own `request.id`, which is what the response
 * `onSend` hook, `HttpExceptionFilter`, and `PerUserRateLimitGuard` all read.
 * This function reuses that ALREADY-RESOLVED id when Fastify has attached
 * one (the normal case for every real request) instead of independently
 * re-deriving it — two independent calls to `extractOrGenerateRequestId`
 * would each mint a DIFFERENT random UUID whenever the inbound header is
 * missing/invalid, so pino's logged `reqId` would silently diverge from the
 * id actually echoed on the response. The direct-computation fallback only
 * matters for a request object Fastify itself never touched (not expected
 * in this app's request path, but keeps this function correct in isolation).
 */
function resolveLogRequestId(req: IncomingMessage): string {
  const alreadyResolved = (req as unknown as { id?: unknown }).id;
  if (typeof alreadyResolved === 'string' && alreadyResolved.length > 0) return alreadyResolved;
  return extractOrGenerateRequestId(req.headers['x-request-id']);
}
import { HealthModule } from './health/health.module.js';
import { InfraModule } from './infra/infra.module.js';
import { PurchaseModule } from './purchase/purchase.module.js';
import { SaleModule } from './sale/sale.module.js';

/**
 * Root module — frozen contract §4.3. `InfraModule` is `@Global()` and
 * imported once here; `LoggerModule.forRoot(...)` wires request-id
 * generation (§10.4) into `nestjs-pino`'s `genReqId`, so every log line and
 * every `request.id` Nest/Fastify sees for the rest of the request's
 * lifetime is `extractOrGenerateRequestId`'s output — never a raw,
 * unvalidated client-supplied header. `HttpExceptionFilter` is the single
 * global `APP_FILTER` (§6.7 point 2): the only place a response body is
 * shaped for an error, anywhere in this app.
 */
@Module({
  imports: [
    InfraModule,
    LoggerModule.forRoot({
      pinoHttp: {
        level: env.LOG_LEVEL,
        genReqId: resolveLogRequestId,
        // §10.3 — the raw request body/headers must never be logged verbatim.
        redact: ['req.headers.authorization', 'req.headers.cookie', 'req.body'],
        // §10.5 — a *transport* choice, not a control-flow branch around a
        // guard/validator/limiter/filter, so it does not violate the §0
        // process rule against `NODE_ENV`-conditional security branches.
        transport: env.NODE_ENV === 'development' ? { target: 'pino-pretty' } : undefined,
      },
    }),
    SaleModule,
    PurchaseModule,
    HealthModule,
  ],
  providers: [{ provide: APP_FILTER, useClass: HttpExceptionFilter }],
})
export class AppModule {}
