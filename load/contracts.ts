export const STRESS_SCENARIOS = [
  'warmup',
  'smoke',
  'surge',
  'duplicate-storm',
  'sold-out',
  'window-edge',
] as const;
export type StressScenario = (typeof STRESS_SCENARIOS)[number];

export const MEASURED_STRESS_SCENARIOS = [
  'smoke',
  'surge',
  'duplicate-storm',
  'sold-out',
  'window-edge',
] as const satisfies readonly Exclude<StressScenario, 'warmup'>[];
export type MeasuredStressScenario = (typeof MEASURED_STRESS_SCENARIOS)[number];

export interface InvariantResult {
  pass: boolean;
  evidence: readonly string[];
}

export interface AuditReport {
  schemaVersion: 1;
  runId: string;
  scenario: StressScenario;
  saleId: string;
  auditedAt: string;
  expectedConfirmed: number;
  convergence: {
    elapsedMs: number;
    apiReady: boolean;
    workerReady: boolean;
    queue: { waiting: number; active: number; delayed: number; failed: number };
    matchingSnapshots: 2;
    stableIntervalMs: number;
    finalLiveCollection: true;
    successfulCollections: number;
    collectionFailures: number;
  };
  postgres: {
    totalStock: number;
    persisted: number;
    compensated: number;
    reserved: number;
    duplicateUsersGlobal: number;
    duplicateUsersInSale: number;
    outsideWindow: number;
  };
  redis: {
    stock: number;
    buyers: number;
    reservations: number;
    metricsConfirmed: number;
  };
  invariants: {
    I1: InvariantResult;
    I2: InvariantResult;
    I3: InvariantResult;
    I4: InvariantResult;
  };
  pass: boolean;
}
