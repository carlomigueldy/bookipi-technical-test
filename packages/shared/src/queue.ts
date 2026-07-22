import { USER_ID_MAX_LENGTH, USER_ID_MIN_LENGTH, USER_ID_PATTERN } from './constants';
import { assertSaleId } from './keys';

export const ORDERS_QUEUE_PREFIX = 'bull' as const;
export const PERSIST_ORDER_JOB_NAME = 'persist-order' as const;
export const ORDERS_JOB_ATTEMPTS = 5 as const;
export const ORDERS_JOB_BACKOFF_DELAY_MS = 200 as const;

export interface OrdersQueueJobPayload {
  saleId: string;
  userId: string;
  reservationId: string;
  reservedAtMs: number;
  requestId: string;
}

const PAYLOAD_KEYS = [
  'saleId',
  'userId',
  'reservationId',
  'reservedAtMs',
  'requestId',
] as const satisfies readonly (keyof OrdersQueueJobPayload)[];
const UUID_PATTERN =
  /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/i;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

function assertUserId(userId: unknown): asserts userId is string {
  if (
    typeof userId !== 'string' ||
    userId !== userId.trim() ||
    userId.length < USER_ID_MIN_LENGTH ||
    userId.length > USER_ID_MAX_LENGTH ||
    !USER_ID_PATTERN.test(userId)
  ) {
    throw new TypeError('Invalid orders queue userId');
  }
}

export function buildOrdersJobId(saleId: string, userId: string): string {
  assertSaleId(saleId);
  assertUserId(userId);
  return `${saleId}-${userId}`;
}

export function assertOrdersQueueJobPayload(
  value: unknown,
): asserts value is OrdersQueueJobPayload {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Invalid orders queue job payload');
  }

  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== PAYLOAD_KEYS.length ||
    keys.some(
      (key) =>
        typeof key !== 'string' || !PAYLOAD_KEYS.includes(key as (typeof PAYLOAD_KEYS)[number]),
    )
  ) {
    throw new TypeError('Invalid orders queue job payload keys');
  }

  const payload = value as Record<(typeof PAYLOAD_KEYS)[number], unknown>;
  assertSaleId(payload.saleId as string);
  assertUserId(payload.userId);

  if (typeof payload.reservationId !== 'string' || !UUID_PATTERN.test(payload.reservationId)) {
    throw new TypeError('Invalid orders queue reservationId');
  }
  if (!Number.isSafeInteger(payload.reservedAtMs) || (payload.reservedAtMs as number) < 0) {
    throw new TypeError('Invalid orders queue reservedAtMs');
  }
  if (typeof payload.requestId !== 'string' || !REQUEST_ID_PATTERN.test(payload.requestId)) {
    throw new TypeError('Invalid orders queue requestId');
  }
}
