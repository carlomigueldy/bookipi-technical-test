import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { API_GLOBAL_PREFIX } from '@flash/shared';
import { AppModule } from './app.module';
import { env } from './config/env';

/**
 * Phase 0: NestJS on the Fastify adapter, Nest's built-in Logger (pino
 * arrives in Phase 2), global prefix `api` so health resolves to
 * `/api/health`.
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter());

  app.setGlobalPrefix(API_GLOBAL_PREFIX);

  await app.listen(env.API_PORT, env.API_HOST);

  Logger.log(
    `api listening on http://${env.API_HOST}:${env.API_PORT}/${API_GLOBAL_PREFIX}`,
    'Bootstrap',
  );
}

void bootstrap();
