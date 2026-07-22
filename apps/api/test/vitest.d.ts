// Declares the shape of the context `test/global-setup.ts` hands to every integration
// spec via `project.provide(...)`. Consumed with `import { inject } from 'vitest'`.
// Mirrors `packages/redis/test/vitest.d.ts`'s frozen Phase 1 pattern, extended with
// `postgresUrl` for this package's second datastore.
declare module 'vitest' {
  interface ProvidedContext {
    redisUrl: string;
    postgresUrl: string;
  }
}

export {};
