export const PROCESS_WATCHDOG_MS = 5000;

export interface ProcessShutdownDependencies {
  close: () => Promise<void>;
  fatal: (message: string) => void;
  exit?: (code: number) => never | void;
  watchdogMs?: number;
}

/** Owns all process termination paths while leaving direct app.close() untouched. */
export class ProcessShutdownController {
  private shutdownPromise: Promise<void> | null = null;
  private watchdog: ReturnType<typeof setTimeout> | null = null;
  private exitCode = 0;

  constructor(private readonly dependencies: ProcessShutdownDependencies) {}

  shutdown(exitCode: number, trigger: string, reason?: unknown): Promise<void> {
    if (exitCode !== 0) this.exitCode = 1;
    if (reason !== undefined) {
      this.dependencies.fatal(
        `${trigger}: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`,
      );
    }
    this.armWatchdog();

    this.shutdownPromise ??= Promise.resolve()
      .then(() => this.dependencies.close())
      .catch((error: unknown) => {
        this.exitCode = 1;
        this.dependencies.fatal(
          `process shutdown failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
        );
      })
      .then(() => {
        this.clearWatchdog();
        this.exit(this.exitCode);
      });
    return this.shutdownPromise;
  }

  private armWatchdog(): void {
    if (this.watchdog !== null) return;
    this.watchdog = setTimeout(() => {
      this.dependencies.fatal(`process shutdown exceeded ${this.watchdogMs}ms; forcing exit`);
      this.exit(1);
    }, this.watchdogMs);
    this.watchdog.unref?.();
  }

  private clearWatchdog(): void {
    if (this.watchdog === null) return;
    clearTimeout(this.watchdog);
    this.watchdog = null;
  }

  private exit(code: number): void {
    (this.dependencies.exit ?? process.exit)(code);
  }

  private get watchdogMs(): number {
    return this.dependencies.watchdogMs ?? PROCESS_WATCHDOG_MS;
  }
}

export function installProcessShutdownHandlers(
  dependencies: ProcessShutdownDependencies,
): ProcessShutdownController {
  const controller = new ProcessShutdownController(dependencies);
  process.once('SIGTERM', () => void controller.shutdown(0, 'SIGTERM'));
  process.once('SIGINT', () => void controller.shutdown(0, 'SIGINT'));
  process.on('unhandledRejection', (reason) => {
    void controller.shutdown(1, 'unhandled promise rejection', reason);
  });
  return controller;
}
