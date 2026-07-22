export const SERVICE_NAMES = ['api', 'worker', 'web'] as const;
export type ServiceName = (typeof SERVICE_NAMES)[number];
export const API_GLOBAL_PREFIX = 'api';
export const HEALTH_PATH = 'health';

/**
 * userId validation constants (Phase 1 contract §8.4). Single source of the
 * regex — SLICE 2's `dto/user-id.ts` schema imports these rather than
 * re-declaring them, so the runtime validator and this contract can never
 * drift apart.
 */
export const USER_ID_MIN_LENGTH = 3;
export const USER_ID_MAX_LENGTH = 64;
export const USER_ID_PATTERN = /^[a-zA-Z0-9._@-]+$/;
