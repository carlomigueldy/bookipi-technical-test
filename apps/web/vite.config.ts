import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Port comes from the frozen env contract (WEB_PORT, default 5173). strictPort keeps the
// dev server from silently drifting onto another port when 5173 is taken.
export default defineConfig({
  plugins: [react()],
  server: {
    port: Number(process.env.WEB_PORT ?? 5173),
    strictPort: true,
  },
  // @flash/shared builds to CommonJS (see phase-0 contract §9.2 / §14) — pre-bundle it and
  // let the CJS interop plugin see inside it so ESM `import { ... } from '@flash/shared'`
  // resolves correctly for both dev and build.
  optimizeDeps: {
    include: ['@flash/shared'],
  },
  build: {
    commonjsOptions: {
      include: [/node_modules/, /packages[\\/]shared[\\/]dist[\\/]/],
    },
  },
});
