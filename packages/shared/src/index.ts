// Import-then-export (not `export * from` / `export { X } from`): TypeScript
// compiles both of those re-export forms for CJS targets into a form Rollup's
// commonjs interop (used by apps/web's Vite build) fails to statically resolve
// named imports against (`export *` uses a runtime `__exportStar` for-in loop;
// `export { X } from` uses an `Object.defineProperty` getter that the bundler's
// analysis does not follow). A plain local import + export compiles to a
// simple, statically analyzable `exports.X = mod.X;` assignment instead.
import { SERVICE_NAMES, API_GLOBAL_PREFIX, HEALTH_PATH } from './constants';
import type { ServiceName } from './constants';
import type { HealthStatus, HealthResponse } from './health';

export { SERVICE_NAMES, API_GLOBAL_PREFIX, HEALTH_PATH };
export type { ServiceName, HealthStatus, HealthResponse };
