import { describe, expect, it } from 'vitest';
import { API_GLOBAL_PREFIX, HEALTH_PATH, SERVICE_NAMES } from './index';
import type { HealthResponse } from './index';

describe('@flash/shared barrel exports', () => {
  it('exposes the frozen service name list', () => {
    expect(SERVICE_NAMES).toEqual(['api', 'worker', 'web']);
  });

  it('exposes the frozen api prefix and health path', () => {
    expect(API_GLOBAL_PREFIX).toBe('api');
    expect(HEALTH_PATH).toBe('health');
  });

  it('shapes a HealthResponse matching the frozen contract', () => {
    const sample: HealthResponse = {
      status: 'ok',
      service: 'api',
      version: '0.0.0',
      uptimeSeconds: 12.3,
    };

    expect(sample.status).toBe('ok');
  });
});
