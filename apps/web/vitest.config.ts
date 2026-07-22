import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Mirrors vite.config.ts's CJS interop settings so @flash/shared resolves the same way
// under Vitest as it does under the dev server / build.
export default defineConfig({
  plugins: [react()],
  optimizeDeps: {
    include: ['@flash/shared'],
  },
  build: {
    commonjsOptions: {
      include: [/node_modules/, /packages[\\/]shared[\\/]dist[\\/]/],
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    root: './',
    include: ['src/**/*.spec.ts', 'src/**/*.spec.tsx', 'src/**/*.test.tsx'],
    restoreMocks: true,
    clearMocks: true,
  },
});
