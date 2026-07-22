import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { WorkerModule } from './worker.module';
import { env } from './config/env';

/**
 * Phase 0: the worker is a Nest HTTP application on the Fastify adapter
 * exposing only /health (contract §13) — no global prefix. It becomes a
 * BullMQ consumer in Phase 3; the health server stays alongside it.
 * Graceful shutdown hooks are enabled now so Phase 3's queue drain can rely
 * on them without a second wiring pass.
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestFastifyApplication>(WorkerModule, new FastifyAdapter());

  app.enableShutdownHooks();

  await app.listen(env.WORKER_HEALTH_PORT, '0.0.0.0');

  Logger.log(
    `worker health listening on http://0.0.0.0:${env.WORKER_HEALTH_PORT}/health`,
    'Bootstrap',
  );
}

void bootstrap();
