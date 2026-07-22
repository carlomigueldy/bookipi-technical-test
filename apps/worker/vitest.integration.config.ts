import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export const integrationTestOptions = {
  globals: true,
  environment: 'node' as const,
  root: './',
  include: ['test/integration/**/*.integration.spec.ts'],
  globalSetup: './test/global-setup.ts',
  testTimeout: 120_000,
  hookTimeout: 180_000,
  fileParallelism: false,
  pool: 'forks' as const,
  poolOptions: { forks: { singleFork: true } },
};

export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: integrationTestOptions,
});
