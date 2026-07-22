import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';
import { integrationTestOptions } from './vitest.integration.config';

const integration = process.argv.includes('integration');

export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: integration
    ? integrationTestOptions
    : {
        globals: true,
        environment: 'node',
        root: './',
        exclude: ['test/**', '**/node_modules/**', '**/dist/**'],
      },
});
