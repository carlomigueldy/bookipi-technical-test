import http from 'k6/http';
import { check } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';

export const purchaseDuration = new Trend('purchase_duration', true);
export const purchaseConfirmed = new Counter('purchase_confirmed');
export const purchaseDuplicate = new Counter('purchase_duplicate');
export const purchaseSoldOut = new Counter('purchase_sold_out');
export const purchaseNotStarted = new Counter('purchase_not_started');
export const purchaseEnded = new Counter('purchase_ended');
export const purchaseRateLimited = new Counter('purchase_rate_limited');
export const unexpectedResponses = new Counter('unexpected_responses');
export const windowConfirmedOutside = new Counter('window_confirmed_outside');
export const businessChecks = new Rate('business_checks');

export const frozenThresholds = {
  http_req_failed: ['rate<0.01'],
  'http_req_duration{name:purchase}': ['p(95)<200', 'p(99)<500'],
  'http_req_duration{name:sale_status}': ['p(95)<50'],
  'http_req_duration{name:sale_metrics}': ['p(95)<100'],
  unexpected_responses: ['count==0'],
  business_checks: ['rate==1'],
  window_confirmed_outside: ['count==0'],
  dropped_iterations: ['count==0'],
};

const outcomeByStatus = {
  201: 'CONFIRMED',
  409: 'ALREADY_PURCHASED',
  410: 'SOLD_OUT',
};

export function config() {
  return {
    apiUrl: required('API_URL'),
    runId: required('RUN_ID'),
    saleId: required('SALE_ID'),
    scenario: required('SCENARIO'),
    token: required('SCENARIO_TOKEN'),
    repetition: Number(required('REPETITION')),
    startsAtMs: Number(required('STARTS_AT_MS')),
    endsAtMs: Number(required('ENDS_AT_MS')),
    resultsDir: __ENV.K6_RESULTS_DIR || '/results',
    profile: required('STRESS_PROFILE'),
  };
}

function required(name) {
  const value = __ENV[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

export function userId(prefix, index) {
  return `${prefix}_${String(index).padStart(6, '0')}`;
}

export function purchase(user, allowed, window) {
  const cfg = config();
  const expectedCodes = [...new Set(Object.keys(allowed).map(Number))];
  const response = http.post(`${cfg.apiUrl}/purchase`, JSON.stringify({ userId: user }), {
    headers: { 'Content-Type': 'application/json' },
    tags: { name: 'purchase' },
    responseCallback: http.expectedStatuses(...expectedCodes),
  });
  return recordPurchaseResponse(response, user, allowed, window);
}

export function recordPurchaseResponse(response, user, allowed, window) {
  const cfg = config();
  purchaseDuration.add(response.timings.duration);
  const body = parseObject(response.body);
  const resolvedAllowed = typeof allowed === 'function' ? allowed(body?.serverTimeMs) : allowed;
  const expectedOutcome = resolvedAllowed[response.status];
  const valid =
    body !== null &&
    expectedOutcome !== undefined &&
    body.status === expectedOutcome &&
    body.saleId === cfg.saleId &&
    body.userId === user &&
    Number.isInteger(body.serverTimeMs);
  check(response, { 'purchase envelope and outcome are valid': () => valid });
  businessChecks.add(valid);
  if (!valid) {
    unexpectedResponses.add(1);
    return { response, body, valid: false, outcome: null };
  }
  const outcome = body.status;
  if (outcome === 'CONFIRMED') purchaseConfirmed.add(1);
  else if (outcome === 'ALREADY_PURCHASED') purchaseDuplicate.add(1);
  else if (outcome === 'SOLD_OUT') purchaseSoldOut.add(1);
  else if (outcome === 'SALE_NOT_STARTED') purchaseNotStarted.add(1);
  else if (outcome === 'SALE_ENDED') purchaseEnded.add(1);
  else if (outcome === 'RATE_LIMITED') purchaseRateLimited.add(1);
  else unexpectedResponses.add(1);
  if (
    outcome === 'CONFIRMED' &&
    window &&
    (body.serverTimeMs < window.startsAtMs || body.serverTimeMs >= window.endsAtMs)
  ) {
    windowConfirmedOutside.add(1);
  }
  return { response, body, valid: true, outcome };
}

export function purchaseAtWindow(user, startsAtMs, endsAtMs) {
  const cfg = config();
  const response = http.post(`${cfg.apiUrl}/purchase`, JSON.stringify({ userId: user }), {
    headers: { 'Content-Type': 'application/json' },
    tags: { name: 'purchase' },
    responseCallback: http.expectedStatuses(201, 403, 410),
  });
  return recordPurchaseResponse(
    response,
    user,
    (serverTimeMs) => allowedForWindow(serverTimeMs, startsAtMs, endsAtMs),
    { startsAtMs, endsAtMs },
  );
}

export function allowedForWindow(serverTimeMs, startsAtMs, endsAtMs) {
  if (serverTimeMs < startsAtMs) return { 403: 'SALE_NOT_STARTED' };
  if (serverTimeMs >= endsAtMs) return { 403: 'SALE_ENDED' };
  return { 201: 'CONFIRMED', 410: 'SOLD_OUT' };
}

export function saleStatus() {
  const cfg = config();
  const response = http.get(`${cfg.apiUrl}/sale/status`, {
    tags: { name: 'sale_status' },
    responseCallback: http.expectedStatuses(200),
  });
  const body = parseObject(response.body);
  const valid =
    response.status === 200 &&
    body !== null &&
    body.saleId === cfg.saleId &&
    Number.isInteger(body.serverTimeMs) &&
    Number.isInteger(body.stockRemaining);
  check(response, { 'sale status envelope is valid': () => valid });
  businessChecks.add(valid);
  if (!valid) unexpectedResponses.add(1);
  return body;
}

export function saleMetrics() {
  const cfg = config();
  const response = http.get(`${cfg.apiUrl}/sale/metrics`, {
    tags: { name: 'sale_metrics' },
    responseCallback: http.expectedStatuses(200),
  });
  const body = parseObject(response.body);
  const valid =
    response.status === 200 &&
    body !== null &&
    body.saleId === cfg.saleId &&
    Number.isInteger(body.serverTimeMs) &&
    typeof body.metrics === 'object';
  check(response, { 'sale metrics envelope is valid': () => valid });
  businessChecks.add(valid);
  if (!valid) unexpectedResponses.add(1);
}

export function apiReadiness() {
  const cfg = config();
  const response = http.get(`${cfg.apiUrl}/health/ready`, {
    tags: { name: 'api_readiness' },
    responseCallback: http.expectedStatuses(200),
  });
  const body = parseObject(response.body);
  const valid = response.status === 200 && body !== null && body.status === 'ok';
  check(response, { 'API readiness envelope is valid': () => valid });
  businessChecks.add(valid);
  if (!valid) unexpectedResponses.add(1);
}

export function parseObject(body) {
  try {
    const value = JSON.parse(body);
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

export function summary(data, target) {
  const cfg = config();
  const count = (name) => data.metrics[name]?.values?.count ?? 0;
  const enriched = {
    ...data,
    phase5: {
      runId: cfg.runId,
      saleId: cfg.saleId,
      scenario: cfg.scenario,
      repetition: cfg.repetition,
      profile: cfg.profile,
      target,
      outcomes: {
        confirmed: count('purchase_confirmed'),
        duplicate: count('purchase_duplicate'),
        soldOut: count('purchase_sold_out'),
        notStarted: count('purchase_not_started'),
        ended: count('purchase_ended'),
        rateLimited: count('purchase_rate_limited'),
      },
    },
  };
  const prefix = `${cfg.resultsDir}/${cfg.scenario}/r${cfg.repetition}`;
  const text = [
    `scenario=${cfg.scenario}`,
    `saleId=${cfg.saleId}`,
    `checks=${data.metrics.checks?.values?.rate ?? 'missing'}`,
    `http_req_failed=${data.metrics.http_req_failed?.values?.rate ?? 'missing'}`,
    `purchase_p95=${data.metrics['http_req_duration{name:purchase}']?.values?.['p(95)'] ?? 'missing'}`,
    `purchase_p99=${data.metrics['http_req_duration{name:purchase}']?.values?.['p(99)'] ?? 'missing'}`,
  ].join('\n');
  return {
    [`${prefix}/k6-summary.json`]: JSON.stringify(enriched, null, 2),
    [`${prefix}/k6-summary.txt`]: `${text}\n`,
    stdout: `${text}\n`,
  };
}

export { outcomeByStatus };
