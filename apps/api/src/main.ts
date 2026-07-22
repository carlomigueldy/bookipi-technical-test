import 'reflect-metadata';
import type { IncomingMessage } from 'node:http';
import type { Http2ServerRequest } from 'node:http2';
import { Logger as NestLogger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import fastifyCors from '@fastify/cors';
import fastifyHelmet from '@fastify/helmet';
import fastifyRateLimit from '@fastify/rate-limit';
import type { FastifyRequest } from 'fastify';
import { Logger } from 'nestjs-pino';

import { API_GLOBAL_PREFIX } from '@flash/shared';

import { AppModule } from './app.module.js';
import { buildRateLimitedThrowable } from './common/rate-limit-error.js';
import { extractOrGenerateRequestId } from './common/request-id.js';
import { CLOCK, REDIS_LIMIT_CLIENT } from './common/tokens.js';
import { env, type ApiEnv } from './config/env.js';
import type { Clock } from './infra/clock.service.js';
import { installProcessShutdownHandlers } from './infra/process-shutdown.js';

let application: NestFastifyApplication | undefined;

export const HTTP_CONNECTION_TIMEOUT_MS = 5000;
export const HTTP_HEADERS_TIMEOUT_MS = 5000;
export const HTTP_REQUEST_TIMEOUT_MS = 10000;
export const HTTP_KEEP_ALIVE_TIMEOUT_MS = 5000;
export const HTTP_MAX_REQUESTS_PER_SOCKET = 1000;

/** Constructs the one direct-exposure adapter policy shared by prod and tests. */
export function createHttpAdapter(apiEnv: ApiEnv): FastifyAdapter {
  const adapter = new FastifyAdapter({
    connectionTimeout: HTTP_CONNECTION_TIMEOUT_MS,
    requestTimeout: HTTP_REQUEST_TIMEOUT_MS,
    keepAliveTimeout: HTTP_KEEP_ALIVE_TIMEOUT_MS,
    maxRequestsPerSocket: HTTP_MAX_REQUESTS_PER_SOCKET,
    // §7.7 — untrusted `X-Forwarded-For` is a rate-limit bypass; default false.
    trustProxy: apiEnv.TRUST_PROXY,
    // §10.1 — 16KB default; Fastify rejects a larger body before Nest sees it.
    bodyLimit: apiEnv.REQUEST_BODY_LIMIT_BYTES,
    genReqId: (req: IncomingMessage | Http2ServerRequest) =>
      extractOrGenerateRequestId(req.headers['x-request-id']),
  });
  adapter.getInstance().server.headersTimeout = HTTP_HEADERS_TIMEOUT_MS;
  return adapter;
}

/** Registers every application-level plugin/hook on an already-created app. */
export async function configureApp(app: NestFastifyApplication, apiEnv: ApiEnv): Promise<void> {
  app.useLogger(app.get(Logger));
  app.setGlobalPrefix(API_GLOBAL_PREFIX);

  app
    .getHttpAdapter()
    .getInstance()
    .addHook('onSend', async (request, reply, payload) => {
      reply.header('x-request-id', request.id);
      return payload;
    });

  const clock = app.get<Clock>(CLOCK);
  const limiterClient = app.get(REDIS_LIMIT_CLIENT);

  await app.register(fastifyHelmet, {
    contentSecurityPolicy: false,
    hidePoweredBy: true,
    hsts: true,
    noSniff: true,
    frameguard: { action: 'deny' },
    referrerPolicy: { policy: 'no-referrer' },
    crossOriginResourcePolicy: { policy: 'same-site' },
  });

  await app.register(fastifyCors, {
    origin: (origin, callback) => {
      callback(null, origin === apiEnv.CORS_ORIGIN);
    },
    methods: ['GET', 'POST'],
    credentials: false,
    allowedHeaders: ['content-type', 'x-request-id'],
    exposedHeaders: [
      'x-request-id',
      'retry-after',
      'x-ratelimit-limit',
      'x-ratelimit-remaining',
      'x-ratelimit-reset',
    ],
  });

  await app.register(fastifyRateLimit, {
    global: true,
    max: apiEnv.RATE_LIMIT_MAX,
    timeWindow: apiEnv.RATE_LIMIT_WINDOW_MS,
    redis: limiterClient,
    nameSpace: 'rl:ip:',
    skipOnError: true,
    addHeaders: {
      'x-ratelimit-limit': true,
      'x-ratelimit-remaining': true,
      'x-ratelimit-reset': true,
      'retry-after': true,
    },
    addHeadersOnExceeding: {
      'x-ratelimit-limit': true,
      'x-ratelimit-remaining': true,
      'x-ratelimit-reset': true,
    },
    errorResponseBuilder(request: FastifyRequest) {
      return buildRateLimitedThrowable(request, clock, apiEnv);
    },
  });
}

/**
 * Bootstrap — frozen contract §4.2/§4.3: adapter opts, plugins, prefix,
 * shutdown. `bufferLogs: true` + `app.useLogger(app.get(Logger))` is the
 * standard `nestjs-pino` pattern so no bootstrap log line is lost before the
 * real logger is wired in.
 */
export async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, createHttpAdapter(env), {
    bufferLogs: true,
  });
  application = app;
  await configureApp(app, env);

  await app.listen(env.API_PORT, env.API_HOST);

  NestLogger.log(
    `api listening on http://${env.API_HOST}:${env.API_PORT}/${API_GLOBAL_PREFIX}`,
    'Bootstrap',
  );
}

if (require.main === module) {
  // Executable-only process hooks keep importing this module side-effect free.
  installProcessShutdownHandlers({
    close: async () => {
      await application?.close();
    },
    fatal: (message) => NestLogger.fatal(message, 'Bootstrap'),
  });
  void bootstrap();
}
