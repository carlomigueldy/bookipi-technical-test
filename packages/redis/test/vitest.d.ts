// Declares the shape of the context `test/global-setup.ts` hands to workers via
// `project.provide('redisUrl', ...)`. Consumed with `import { inject } from 'vitest'`.
declare module 'vitest' {
  interface ProvidedContext {
    redisUrl: string;
  }
}

export {};
