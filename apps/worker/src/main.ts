import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { WorkerModule } from './worker.module';
import { env } from './config/env';
import { ReconciliationService } from './reconciliation/reconciliation.service';
import { OrdersConsumer } from './orders/orders.consumer';

let application: NestFastifyApplication | undefined;
let shutdownPromise: Promise<void> | null = null;

/**
 * Phase 0: the worker is a Nest HTTP application on the Fastify adapter
 * exposing only /health (contract §13) — no global prefix. It becomes a
 * BullMQ consumer in Phase 3; the health server stays alongside it.
 * Graceful shutdown hooks are enabled now so Phase 3's queue drain can rely
 * on them without a second wiring pass.
 */
export const WORKER_SHUTDOWN_WATCHDOG_MS = 10_000 as const;

export interface ProcessHandlerOptions {
  shutdownFn?: (exitCode: number) => Promise<void>;
  watchdogMs?: number;
}

export async function superviseWorkerLifecycle(
  reconciliation: Pick<ReconciliationService, 'start' | 'waitForFatal'>,
): Promise<never> {
  await reconciliation.start();
  await reconciliation.waitForFatal();
  throw new Error('worker fatal channel resolved unexpectedly');
}

export async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestFastifyApplication>(WorkerModule, new FastifyAdapter());
  application = app;

  await app.listen(env.WORKER_HEALTH_PORT, '0.0.0.0');

  Logger.log(
    `worker health listening on http://0.0.0.0:${env.WORKER_HEALTH_PORT}/health`,
    'Bootstrap',
  );

  await superviseWorkerLifecycle(app.get(ReconciliationService));
}

export function shutdown(exitCode = 0): Promise<void> {
  shutdownPromise ??= (async () => {
    Logger.log({ event: 'worker.shutdown_started' }, 'Bootstrap');
    const errors: unknown[] = [];
    if (application) {
      try {
        await application.get(ReconciliationService).stop();
      } catch (error) {
        errors.push(error);
      }
      try {
        await application.get(OrdersConsumer).close();
      } catch (error) {
        errors.push(error);
      }
      try {
        await application.close();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) throw new AggregateError(errors, 'worker shutdown failed');
    Logger.log({ event: 'worker.shutdown_completed' }, 'Bootstrap');
    if (exitCode !== 0) process.exitCode = exitCode;
  })();
  return shutdownPromise;
}

export function installProcessHandlers(options: ProcessHandlerOptions = {}): void {
  const shutdownFn = options.shutdownFn ?? shutdown;
  const watchdogMs = options.watchdogMs ?? WORKER_SHUTDOWN_WATCHDOG_MS;
  if (!Number.isFinite(watchdogMs) || watchdogMs <= 0) {
    throw new RangeError('watchdogMs must be a positive finite number');
  }
  let handling = false;
  const handle = (exitCode: number) => {
    if (handling) return;
    handling = true;
    const watchdog = setTimeout(() => {
      process.exit(1);
    }, watchdogMs);
    watchdog.unref?.();
    shutdownFn(exitCode).then(
      () => {
        clearTimeout(watchdog);
        if (exitCode !== 0) process.exit(exitCode);
      },
      () => process.exit(1),
    );
  };
  process.once('SIGTERM', () => handle(0));
  process.once('SIGINT', () => handle(0));
  process.once('unhandledRejection', (reason) => {
    Logger.fatal(reason, 'Bootstrap');
    handle(1);
  });
  process.once('uncaughtException', (error) => {
    Logger.fatal(error, 'Bootstrap');
    handle(1);
  });
}

if (require.main === module) {
  installProcessHandlers();
  bootstrap().catch((error) => {
    Logger.fatal(error, 'Bootstrap');
    shutdown(1).catch(() => process.exit(1));
  });
}
