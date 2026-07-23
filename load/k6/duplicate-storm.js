import http from 'k6/http';
import { scenario } from 'k6/execution';
import {
  businessChecks,
  config,
  frozenThresholds,
  recordPurchaseResponse,
  saleMetrics,
  saleStatus,
  summary,
  unexpectedResponses,
  userId,
} from './common.js';

export const options = {
  scenarios: {
    purchase: {
      executor: 'shared-iterations',
      exec: 'buy',
      vus: 500,
      iterations: 5000,
      maxDuration: '2m',
    },
    status: {
      executor: 'constant-arrival-rate',
      exec: 'observeStatus',
      rate: 20,
      timeUnit: '1s',
      duration: '120s',
      preAllocatedVUs: 20,
      maxVUs: 60,
    },
    metrics: {
      executor: 'constant-arrival-rate',
      exec: 'observeMetrics',
      rate: 5,
      timeUnit: '1s',
      duration: '120s',
      preAllocatedVUs: 5,
      maxVUs: 15,
    },
  },
  thresholds: frozenThresholds,
};

export function buy() {
  const cfg = config();
  const user = userId(`p5_${cfg.runId.slice(-8)}_dup_r${cfg.repetition}`, scenario.iterationInTest);
  const requests = Array.from({ length: 10 }, () => ({
    method: 'POST',
    url: `${cfg.apiUrl}/purchase`,
    body: JSON.stringify({ userId: user }),
    params: {
      headers: { 'Content-Type': 'application/json' },
      tags: { name: 'purchase' },
      responseCallback: http.expectedStatuses(201, 409),
    },
  }));
  const results = http
    .batch(requests)
    .map((response) =>
      recordPurchaseResponse(response, user, { 201: 'CONFIRMED', 409: 'ALREADY_PURCHASED' }),
    );
  const valid =
    results.filter((result) => result.outcome === 'CONFIRMED').length === 1 &&
    results.filter((result) => result.outcome === 'ALREADY_PURCHASED').length === 9;
  businessChecks.add(valid);
  if (!valid) unexpectedResponses.add(1);
}

export function observeStatus() {
  saleStatus();
}
export function observeMetrics() {
  saleMetrics();
}
export function handleSummary(data) {
  return summary(data, 50000);
}
