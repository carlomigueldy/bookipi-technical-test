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
      rate: 200,
      timeUnit: '1s',
      duration: '30s',
      preAllocatedVUs: 100,
      maxVUs: 750,
    },
    status: {
      executor: 'constant-arrival-rate',
      exec: 'observeStatus',
      rate: 10,
      timeUnit: '1s',
      duration: '30s',
      preAllocatedVUs: 10,
      maxVUs: 30,
    },
    metrics: {
      executor: 'constant-arrival-rate',
      exec: 'observeMetrics',
      rate: 2,
      timeUnit: '1s',
      duration: '30s',
      preAllocatedVUs: 2,
      maxVUs: 10,
    },
  },
  thresholds: frozenThresholds,
};
export function buy() {
  const c = config();
  purchase(userId(`p5_${c.runId.slice(-8)}_smoke_r${c.repetition}`, scenario.iterationInTest), {
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
  return summary(data, 200);
}
