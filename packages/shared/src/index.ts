// Import-then-export (not `export * from` / `export { X } from`): TypeScript
// compiles both of those re-export forms for CJS targets into a form Rollup's
// commonjs interop (used by apps/web's Vite build) fails to statically resolve
// named imports against (`export *` uses a runtime `__exportStar` for-in loop;
// `export { X } from` uses an `Object.defineProperty` getter that the bundler's
// analysis does not follow). A plain local import + export compiles to a
// simple, statically analyzable `exports.X = mod.X;` assignment instead.
import {
  SERVICE_NAMES,
  API_GLOBAL_PREFIX,
  HEALTH_PATH,
  USER_ID_MIN_LENGTH,
  USER_ID_MAX_LENGTH,
  USER_ID_PATTERN,
} from './constants';
import type { ServiceName } from './constants';
import type { HealthStatus, HealthResponse } from './health';
import {
  SALE_ID_PATTERN,
  assertSaleId,
  saleHashTag,
  saleConfigKey,
  saleStockKey,
  saleBuyersKey,
  saleMetricsKey,
  saleReservationsKey,
  saleKeys,
} from './keys';
import type { SaleKeys } from './keys';
import {
  SALE_STATES,
  deriveSaleState,
  isWithinSaleWindow,
  msUntilNextTransition,
} from './sale-state';
import type { SaleState, SaleStateInput } from './sale-state';
import {
  PURCHASE_OUTCOMES,
  REQUEST_OUTCOMES,
  ATTEMPT_OUTCOMES,
  ORDER_STATUSES,
  PURCHASE_OUTCOME_HTTP_STATUS,
  SALE_NOT_ACTIVE_OUTCOMES,
  isSuccessOutcome,
  SALE_METRIC_FIELDS,
  OUTCOME_METRIC_FIELD,
} from './results';
import type {
  PurchaseOutcome,
  RequestOutcome,
  AttemptOutcome,
  OrderStatus,
  SaleMetricField,
} from './results';
import {
  ORDERS_QUEUE_PREFIX,
  PERSIST_ORDER_JOB_NAME,
  ORDERS_JOB_ATTEMPTS,
  ORDERS_JOB_BACKOFF_DELAY_MS,
  buildOrdersJobId,
  assertOrdersQueueJobPayload,
} from './queue';
import type { OrdersQueueJobPayload } from './queue';

export {
  SERVICE_NAMES,
  API_GLOBAL_PREFIX,
  HEALTH_PATH,
  USER_ID_MIN_LENGTH,
  USER_ID_MAX_LENGTH,
  USER_ID_PATTERN,
  SALE_ID_PATTERN,
  assertSaleId,
  saleHashTag,
  saleConfigKey,
  saleStockKey,
  saleBuyersKey,
  saleMetricsKey,
  saleReservationsKey,
  saleKeys,
  SALE_STATES,
  deriveSaleState,
  isWithinSaleWindow,
  msUntilNextTransition,
  PURCHASE_OUTCOMES,
  REQUEST_OUTCOMES,
  ATTEMPT_OUTCOMES,
  ORDER_STATUSES,
  PURCHASE_OUTCOME_HTTP_STATUS,
  SALE_NOT_ACTIVE_OUTCOMES,
  isSuccessOutcome,
  SALE_METRIC_FIELDS,
  OUTCOME_METRIC_FIELD,
  ORDERS_QUEUE_PREFIX,
  PERSIST_ORDER_JOB_NAME,
  ORDERS_JOB_ATTEMPTS,
  ORDERS_JOB_BACKOFF_DELAY_MS,
  buildOrdersJobId,
  assertOrdersQueueJobPayload,
};
export type {
  ServiceName,
  HealthStatus,
  HealthResponse,
  SaleKeys,
  SaleState,
  SaleStateInput,
  PurchaseOutcome,
  RequestOutcome,
  AttemptOutcome,
  OrderStatus,
  SaleMetricField,
  OrdersQueueJobPayload,
};
