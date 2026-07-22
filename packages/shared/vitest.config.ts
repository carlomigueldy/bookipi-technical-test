import { defineConfig } from 'vitest/config';

// @flash/shared is pure TypeScript (no decorators, no DOM) — no plugins
// needed. Every spec here is a pure-function/schema unit test; none of them
// may start a container or touch the network. Redis-backed specs live in
// @flash/redis, not here (Phase 1 contract §1 test-surface isolation).
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    root: './',
    include: ['src/**/*.spec.ts'],
  },
});
