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
      rate: 1000,
      timeUnit: '1s',
      duration: '10s',
      preAllocatedVUs: 250,
      maxVUs: 2000,
    },
    status: {
      executor: 'constant-arrival-rate',
      exec: 'observeStatus',
      rate: 20,
      timeUnit: '1s',
      duration: '10s',
      preAllocatedVUs: 20,
      maxVUs: 60,
    },
    metrics: {
      executor: 'constant-arrival-rate',
      exec: 'observeMetrics',
      rate: 5,
      timeUnit: '1s',
      duration: '10s',
      preAllocatedVUs: 5,
      maxVUs: 15,
    },
  },
  thresholds: frozenThresholds,
};
export function buy() {
  const c = config();
  purchase(userId(`p5_${c.runId.slice(-8)}_sold_r${c.repetition}`, scenario.iterationInTest), {
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
  return summary(data, 1000);
}
