import { scenario } from 'k6/execution';
import {
  config,
  frozenThresholds,
  purchase,
  saleMetrics,
  saleStatus,
  summary,
  userId,
} from './common.js';

export const options = {
  scenarios: {
    purchase: {
      executor: 'constant-arrival-rate',
      exec: 'buy',
      rate: 20,
      timeUnit: '1s',
      duration: '10s',
      preAllocatedVUs: 20,
      maxVUs: 100,
    },
    status: {
      executor: 'constant-arrival-rate',
      exec: 'observeStatus',
      rate: 5,
      timeUnit: '1s',
      duration: '10s',
      preAllocatedVUs: 5,
      maxVUs: 20,
    },
    metrics: {
      executor: 'constant-arrival-rate',
      exec: 'observeMetrics',
      rate: 1,
      timeUnit: '1s',
      duration: '10s',
      preAllocatedVUs: 1,
      maxVUs: 5,
    },
  },
  thresholds: frozenThresholds,
};
export function buy() {
  const c = config();
  purchase(userId(`p5_${c.runId.slice(-8)}_warm`, scenario.iterationInTest), {
    201: 'CONFIRMED',
    410: 'SOLD_OUT',
  });
}
export function observeStatus() {
  saleStatus();
}
export function observeMetrics() {
  saleMetrics();
}
export function handleSummary(data) {
  return summary(data, 20);
}
