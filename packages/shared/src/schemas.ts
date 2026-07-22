// Import-then-export (not `export * from` / `export { X } from`): TypeScript
// compiles both of those re-export forms for CJS targets into a form Rollup's
// commonjs interop (used by apps/web's Vite build) fails to statically resolve
// named imports against (`export *` uses a runtime `__exportStar` for-in loop;
// `export { X } from` uses an `Object.defineProperty` getter that the bundler's
// analysis does not follow). A plain local import + export compiles to a
// simple, statically analyzable `exports.X = mod.X;` assignment instead.
//
// This is the "./schemas" entry point (Phase 1 contract §8.2): the ONLY place
// `zod` is a runtime dependency. `apps/web` must only ever reach these types
// via `import type`, never a value import — that keeps zod out of the browser
// bundle. Never re-export anything from here through `./index.ts` (the "."
// entry), and never import from `./index.ts` here: the two barrels are
// deliberately disjoint so neither slice's barrel edit touches the other's.
import { userIdSchema } from './dto/user-id';
import type { UserId } from './dto/user-id';
import { purchaseRequestSchema, purchaseResponseSchema } from './dto/purchase';
import type { PurchaseRequest, PurchaseResponse } from './dto/purchase';
import { saleStatusResponseSchema } from './dto/sale-status';
import type { SaleStatusResponse } from './dto/sale-status';
import { purchaseStatusParamsSchema, purchaseStatusResponseSchema } from './dto/purchase-status';
import type { PurchaseStatusParams, PurchaseStatusResponse } from './dto/purchase-status';

export {
  userIdSchema,
  purchaseRequestSchema,
  purchaseResponseSchema,
  saleStatusResponseSchema,
  purchaseStatusParamsSchema,
  purchaseStatusResponseSchema,
};
export type {
  UserId,
  PurchaseRequest,
  PurchaseResponse,
  SaleStatusResponse,
  PurchaseStatusParams,
  PurchaseStatusResponse,
};
