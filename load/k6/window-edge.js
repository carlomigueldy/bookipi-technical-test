import { scenario } from 'k6/execution';
import {
  config,
  frozenThresholds,
  purchaseAtWindow,
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
      rate: 500,
      timeUnit: '1s',
      duration: '20s',
      preAllocatedVUs: 200,
      maxVUs: 1500,
    },
    status: {
      executor: 'constant-arrival-rate',
      exec: 'observeStatus',
      rate: 50,
      timeUnit: '1s',
      duration: '20s',
      preAllocatedVUs: 50,
      maxVUs: 150,
    },
    metrics: {
      executor: 'constant-arrival-rate',
      exec: 'observeMetrics',
      rate: 5,
      timeUnit: '1s',
      duration: '20s',
      preAllocatedVUs: 5,
      maxVUs: 15,
    },
  },
  thresholds: frozenThresholds,
};

export function buy() {
  const cfg = config();
  purchaseAtWindow(
    userId(`p5_${cfg.runId.slice(-8)}_edge_r${cfg.repetition}`, scenario.iterationInTest),
    cfg.startsAtMs,
    cfg.endsAtMs,
  );
}
export function observeStatus() {
  saleStatus();
}
export function observeMetrics() {
  saleMetrics();
}
export function handleSummary(data) {
  return summary(data, 500);
}
