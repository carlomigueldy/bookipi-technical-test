export const SERVICE_NAMES = ['api', 'worker', 'web'] as const;
export type ServiceName = (typeof SERVICE_NAMES)[number];
export const API_GLOBAL_PREFIX = 'api';
export const HEALTH_PATH = 'health';
