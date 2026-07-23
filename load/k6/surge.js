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
      executor: 'ramping-arrival-rate',
      exec: 'buy',
      startRate: 1,
      timeUnit: '1s',
      stages: [
        { duration: '30s', target: 2000 },
        { duration: '60s', target: 2000 },
      ],
      preAllocatedVUs: 500,
      maxVUs: 4000,
    },
    status: {
      executor: 'constant-arrival-rate',
      exec: 'observeStatus',
      rate: 50,
      timeUnit: '1s',
      duration: '90s',
      preAllocatedVUs: 50,
      maxVUs: 150,
    },
    metrics: {
      executor: 'constant-arrival-rate',
      exec: 'observeMetrics',
      rate: 10,
      timeUnit: '1s',
      duration: '90s',
      preAllocatedVUs: 10,
      maxVUs: 30,
    },
  },
  thresholds: frozenThresholds,
};
export function buy() {
  const c = config();
  purchase(userId(`p5_${c.runId.slice(-8)}_surge`, scenario.iterationInTest % 50000), {
    201: 'CONFIRMED',
    409: 'ALREADY_PURCHASED',
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
  return summary(data, 2000);
}
