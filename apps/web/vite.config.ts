import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Port comes from the frozen env contract (WEB_PORT, default 5173). strictPort keeps the
// dev server from silently drifting onto another port when 5173 is taken.
export default defineConfig({
  plugins: [react()],
  // pnpm's `node-linker=isolated` makes `node_modules/@flash/shared` a symlink into the
  // workspace package. Vite's default `preserveSymlinks: false` resolves it to its real
  // path (`packages/shared/dist/...`) *before* Rollup's commonjs interop sees the id, so
  // `build.commonjsOptions.include: [/@flash\/shared/]` below never matches and the CJS
  // package gets imported as if it were ESM (no named exports). Keeping the symlink path
  // intact is what makes that include pattern actually match.
  resolve: {
    preserveSymlinks: true,
  },
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
      include: [/@flash\/shared/, /node_modules/],
    },
  },
});
