import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import {
  chmodSync,
  lstatSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const publicationFaults = vi.hoisted(() => ({
  writeNoProgress: false,
  tempSync: false,
  link: false,
  postLinkStat: false,
  parentSync: false,
  unlink: false,
  close: false,
  linkCompleted: false,
  opened: 0,
  closed: 0,
  helperUid: null as bigint | null,
  helperMode: null as bigint | null,
  helperNotFile: false,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      const path = String(args[0]);
      const isTemp = basename(path).startsWith('.audit.json.');
      const isHelper = path === '/usr/bin/ln';
      publicationFaults.opened += 1;
      return new Proxy(handle, {
        get(target, property) {
          if (property === 'close')
            return async () => {
              publicationFaults.closed += 1;
              const result = await target.close();
              if (publicationFaults.close) throw new Error('injected close failure');
              return result;
            };
          if (property === 'write' && isTemp && publicationFaults.writeNoProgress)
            return async () => ({ bytesWritten: 0, buffer: Buffer.alloc(0) });
          if (property === 'sync')
            return async () => {
              if (isTemp && publicationFaults.tempSync)
                throw new Error('injected temp sync failure');
              if (!isTemp && publicationFaults.parentSync)
                throw new Error('injected parent sync failure');
              return target.sync();
            };
          if (property === 'stat' && isHelper)
            return async (...statArgs: Parameters<typeof target.stat>) => {
              const stats = await target.stat(...statArgs);
              return new Proxy(stats, {
                get(statTarget, statProperty, receiver) {
                  if (statProperty === 'uid') return publicationFaults.helperUid ?? 0n;
                  if (statProperty === 'mode' && publicationFaults.helperMode !== null)
                    return publicationFaults.helperMode;
                  if (statProperty === 'isFile' && publicationFaults.helperNotFile)
                    return () => false;
                  return Reflect.get(statTarget, statProperty, receiver);
                },
              });
            };
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    },
    link: async (...args: Parameters<typeof actual.link>) => {
      if (publicationFaults.link) throw new Error('injected link failure');
      const result = await actual.link(...args);
      publicationFaults.linkCompleted = true;
      return result;
    },
    lstat: async (...args: Parameters<typeof actual.lstat>) => {
      if (
        publicationFaults.postLinkStat &&
        publicationFaults.linkCompleted &&
        basename(String(args[0])) === 'audit.json'
      )
        throw new Error('injected post-link stat failure');
      return actual.lstat(...args);
    },
    unlink: async (...args: Parameters<typeof actual.unlink>) => {
      if (publicationFaults.unlink) throw new Error('injected unlink failure');
      return actual.unlink(...args);
    },
  };
});

// @ts-expect-error The L1 runner is intentionally native ESM JavaScript, outside load/tsconfig.
import { derivePosixIdentity, runPackageAudit, runPermissionProbe } from '../scripts/stress.mjs';

import {
  AUDIT_RAW_RESULTS_ROOT,
  closeAuditCliOptions,
  integrityInputPaths,
  evaluateAudit,
  parseAuditCli,
  publishAuditReport,
  validateResultArtifacts,
  waitForConvergence,
  type AuditEvaluationInput,
  type AuditPublicationCapability,
  type AuditOrder,
  type ResultArtifact,
  type Snapshot,
} from './audit.js';
import { MEASURED_STRESS_SCENARIOS, STRESS_SCENARIOS } from './contracts.js';

function fixture(): AuditEvaluationInput {
  const startsAtMs = 1_800_000_000_000;
  const orders: AuditOrder[] = Array.from({ length: 200 }, (_, index) => ({
    id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    userId: `p5_deadbeef_smoke_${String(index).padStart(6, '0')}`,
    status: 'persisted',
    createdAtMs: startsAtMs + index,
  }));
  const buyers = new Set(orders.map((order) => order.userId));
  const reservations = new Map(
    orders.map((order) => [
      order.userId,
      { reservationId: order.id, reservedAtMs: order.createdAtMs },
    ]),
  );
  const sale = {
    id: 'p5-deadbeef-smoke-r1',
    name: 'Phase 5 smoke test',
    totalStock: 200,
    startsAtMs,
    endsAtMs: startsAtMs + 60_000,
  };
  return {
    runId: '20260723000000-deadbeef',
    scenario: 'smoke',
    saleId: sale.id,
    initialStock: 200,
    expectedConfirmed: 200,
    sale,
    apiSale: { ...sale },
    redisSale: { ...sale },
    convergence: {
      elapsedMs: 500,
      apiReady: true,
      workerReady: true,
      queue: { waiting: 0, active: 0, delayed: 0, failed: 0 },
      matchingSnapshots: 2,
      stableIntervalMs: 250,
      finalLiveCollection: true,
      successfulCollections: 3,
      collectionFailures: 0,
    },
    postgres: {
      totalStock: 200,
      persisted: 200,
      compensated: 0,
      reserved: 0,
      duplicateUsersGlobal: 0,
      duplicateUsersInSale: 0,
      outsideWindow: 0,
    },
    redis: { stock: 0, buyers: 200, reservations: 200, metricsConfirmed: 200 },
    orders,
    buyers,
    reservations,
  };
}

function snapshotFixture(): Snapshot {
  const input = fixture();
  return {
    apiReady: true,
    workerReady: true,
    queue: { ...input.convergence.queue },
    sale: { ...input.sale },
    apiSale: { ...input.apiSale },
    redisSale: { ...input.redisSale },
    postgres: { ...input.postgres },
    redis: { ...input.redis },
    orders: input.orders.map((order) => ({ ...order })),
    buyers: new Set(input.buyers),
    reservations: new Map(
      [...input.reservations].map(([userId, reservation]) => [userId, { ...reservation }]),
    ),
    ledgerErrors: [...(input.ledgerErrors ?? [])],
  };
}

function injectedClock() {
  let milliseconds = 0;
  return {
    now: () => milliseconds,
    delay: async (duration: number) => {
      milliseconds += duration;
    },
  };
}

describe('Phase 5 Amendment A5 fail-closed convergence', () => {
  it('A5 — collection failure resets the convergence streak and old snapshot age cannot pass', async () => {
    const clock = injectedClock();
    const stable = snapshotFixture();
    let calls = 0;
    await expect(
      waitForConvergence(
        async () => {
          calls += 1;
          if (calls === 2) throw new Error('temporary Redis failure');
          return stable;
        },
        { deadlineMs: 400, ...clock },
      ),
    ).rejects.toThrow('Convergence deadline expired');
    expect(calls).toBeGreaterThanOrEqual(3);
  });

  it('A5 — two matching snapshots less than 250ms apart do not converge', async () => {
    const clock = injectedClock();
    let calls = 0;
    await expect(
      waitForConvergence(
        async () => {
          calls += 1;
          return snapshotFixture();
        },
        { deadlineMs: 200, ...clock },
      ),
    ).rejects.toThrow('Convergence deadline expired');
    expect(calls).toBe(2);
  });

  it('A5 — changed full identity fingerprint resets the candidate even when counts match', async () => {
    const clock = injectedClock();
    const first = snapshotFixture();
    const changed = snapshotFixture();
    changed.orders[0] = { ...changed.orders[0]!, id: '00000000-0000-4000-9000-000000000000' };
    changed.reservations.set(changed.orders[0]!.userId, {
      reservationId: changed.orders[0]!.id,
      reservedAtMs: changed.orders[0]!.createdAtMs,
    });
    let calls = 0;
    const evidence = await waitForConvergence(
      async () => {
        calls += 1;
        return calls === 1 ? first : changed;
      },
      { deadlineMs: 1500, ...clock },
    );
    expect(calls).toBe(5);
    expect(evidence.snapshot.orders[0]!.id).toBe(changed.orders[0]!.id);
  });

  it('A5 — non-converged complete observation resets the candidate', async () => {
    const clock = injectedClock();
    const stable = snapshotFixture();
    const busy = snapshotFixture();
    busy.queue.active = 1;
    let calls = 0;
    const evidence = await waitForConvergence(
      async () => {
        calls += 1;
        return calls === 2 ? busy : stable;
      },
      { deadlineMs: 1500, ...clock },
    );
    expect(calls).toBe(6);
    expect(evidence.stableIntervalMs).toBeGreaterThanOrEqual(250);
  });

  it('A5 — final live collection failure resets the streak and cannot emit a report', async () => {
    const clock = injectedClock();
    let calls = 0;
    await expect(
      waitForConvergence(
        async () => {
          calls += 1;
          if (calls === 4) throw new Error('final PostgreSQL read failed');
          return snapshotFixture();
        },
        { deadlineMs: 400, ...clock },
      ),
    ).rejects.toThrow('Convergence deadline expired');
    expect(calls).toBe(4);
  });

  it('A5 — final live mismatch resets and requires a new two-snapshot streak', async () => {
    const clock = injectedClock();
    const first = snapshotFixture();
    const changed = snapshotFixture();
    changed.redis.metricsConfirmed += 1;
    let calls = 0;
    const evidence = await waitForConvergence(
      async () => {
        calls += 1;
        return calls <= 3 ? first : changed;
      },
      { deadlineMs: 1500, ...clock },
    );
    expect(calls).toBe(7);
    expect(evidence.snapshot.redis.metricsConfirmed).toBe(changed.redis.metricsConfirmed);
  });

  it('A5 — two spaced matches plus matching final live collection return only the final snapshot', async () => {
    const clock = injectedClock();
    const snapshots = [snapshotFixture(), snapshotFixture(), snapshotFixture(), snapshotFixture()];
    let calls = 0;
    const evidence = await waitForConvergence(async () => snapshots[calls++]!, {
      deadlineMs: 1000,
      ...clock,
    });
    expect(evidence).toMatchObject({
      snapshot: snapshots[3],
      matchingSnapshots: 2,
      stableIntervalMs: 250,
      finalLiveCollection: true,
      successfulCollections: 4,
      collectionFailures: 0,
    });
    expect(evidence.snapshot).toBe(snapshots[3]);
  });

  it('A5 — deadline reports redacted last collection error and never returns retained success', async () => {
    const clock = injectedClock();
    let calls = 0;
    let thrown: Error | undefined;
    try {
      await waitForConvergence(
        async () => {
          calls += 1;
          if (calls === 1) return snapshotFixture();
          throw new Error('postgresql://audit:datastore-password@127.0.0.1:5432/flash unavailable');
        },
        { deadlineMs: 150, ...clock },
      );
    } catch (error) {
      thrown = error as Error;
    }
    expect(thrown?.message).toContain('Convergence deadline expired');
    expect(thrown?.message).toContain('[REDACTED]');
    expect(thrown?.message).not.toContain('datastore-password');
    expect(calls).toBe(2);
  });

  it('A5 — I4 requires two matches, minimum interval, and final live availability evidence', () => {
    const badMatchCount = fixture();
    badMatchCount.convergence.matchingSnapshots = 1 as 2;
    expect(evaluateAudit(badMatchCount).invariants.I4.pass).toBe(false);

    const shortInterval = fixture();
    shortInterval.convergence.stableIntervalMs = 249;
    expect(evaluateAudit(shortInterval).invariants.I4.pass).toBe(false);

    const missingFinalRead = fixture();
    missingFinalRead.convergence.finalLiveCollection = false as true;
    expect(evaluateAudit(missingFinalRead).invariants.I4.pass).toBe(false);
  });
});

describe('Phase 5 audit evaluator mandatory falsification controls', () => {
  it('I1 negative control — rejects stock below zero and persisted above total', () => {
    const input = fixture();
    input.redis.stock = -1;
    input.postgres.persisted = 201;
    expect(evaluateAudit(input).invariants.I1.pass).toBe(false);
  });

  it('I2 negative control — rejects duplicate PG users and buyer/reservation mismatch', () => {
    const input = fixture();
    input.postgres.duplicateUsersGlobal = 1;
    input.postgres.duplicateUsersInSale = 1;
    (input.buyers as Set<string>).delete(input.orders[0]!.userId);
    expect(evaluateAudit(input).invariants.I2.pass).toBe(false);
  });

  it('I3 negative control — rejects start-minus-1ms and exact-end confirmations', () => {
    const input = fixture();
    input.orders = [
      { ...input.orders[0]!, createdAtMs: input.sale.startsAtMs - 1 },
      { ...input.orders[1]!, createdAtMs: input.sale.endsAtMs },
      ...input.orders.slice(2),
    ];
    input.postgres.outsideWindow = 2;
    expect(evaluateAudit(input).invariants.I3.pass).toBe(false);
  });

  it('I4 negative control — rejects confirmation loss, nonzero queue, and unmatched reservation', () => {
    const input = fixture();
    input.expectedConfirmed = 201;
    input.convergence.queue.waiting = 1;
    (input.reservations as Map<string, { reservationId: string; reservedAtMs: number }>).set(
      'p5_deadbeef_smoke_999999',
      { reservationId: 'lost', reservedAtMs: input.sale.startsAtMs },
    );
    input.redis.reservations = 201;
    input.redis.buyers = 201;
    expect(evaluateAudit(input).invariants.I4.pass).toBe(false);
  });

  it('malformed Redis ledger identity/timestamp — fails closed under I4', () => {
    const input = fixture();
    input.ledgerErrors = ['bad identity:timestamp'];
    expect(evaluateAudit(input).invariants.I4.pass).toBe(false);
  });

  it('positive compensated terminal case — I4 accepts returned stock and absent active identity', () => {
    const input = fixture();
    const compensated = input.orders[199]!;
    input.orders = [...input.orders.slice(0, 199), { ...compensated, status: 'compensated' }];
    (input.buyers as Set<string>).delete(compensated.userId);
    (input.reservations as Map<string, { reservationId: string; reservedAtMs: number }>).delete(
      compensated.userId,
    );
    input.postgres.persisted = 199;
    input.postgres.compensated = 1;
    input.redis.stock = 1;
    input.redis.buyers = 199;
    input.redis.reservations = 199;
    expect(evaluateAudit(input).invariants.I4.pass).toBe(true);
  });
});

describe('Phase 5 Amendment A1 warmup discriminator', () => {
  const cli = (
    scenario: string,
    out = join(AUDIT_RAW_RESULTS_ROOT, '20260723000000-deadbeef', 'warmup', 'r1', 'audit.json'),
  ) => [
    '--run-id',
    '20260723000000-deadbeef',
    '--scenario',
    scenario,
    '--sale-id',
    'p5-deadbeef-warm-r1',
    '--initial-stock',
    '200',
    '--expected-confirmed',
    '200',
    '--api-url',
    'http://127.0.0.1:3300',
    '--worker-url',
    'http://127.0.0.1:3301',
    '--database-url',
    'postgresql://flash:flash@127.0.0.1:5543/flash',
    '--redis-url',
    'redis://127.0.0.1:6680',
    '--deadline-ms',
    '120000',
    '--out',
    out,
  ];
  const artifact = (scenario: ResultArtifact['scenario'], repetition: number): ResultArtifact => ({
    scenario,
    repetition,
    pass: true,
    summaryPath: `${scenario}/r${repetition}/k6-summary.json`,
    auditPath: `${scenario}/r${repetition}/audit.json`,
    runtimePath: `${scenario}/r${repetition}/runtime.json`,
  });
  const fullArtifacts = () => [
    artifact('warmup', 1),
    ...(['surge', 'duplicate-storm', 'sold-out', 'window-edge'] as const).flatMap((scenario) =>
      [1, 2, 3].map((repetition) => artifact(scenario, repetition)),
    ),
  ];

  it('A1 — STRESS_SCENARIOS includes warmup and all five measured scenarios exactly', () => {
    expect(STRESS_SCENARIOS).toEqual([
      'warmup',
      'smoke',
      'surge',
      'duplicate-storm',
      'sold-out',
      'window-edge',
    ]);
  });
  it('A1 — MEASURED_STRESS_SCENARIOS excludes warmup exactly', () => {
    expect(MEASURED_STRESS_SCENARIOS).toEqual([
      'smoke',
      'surge',
      'duplicate-storm',
      'sold-out',
      'window-edge',
    ]);
  });
  it('A1 — audit CLI accepts warmup and emits scenario warmup', () => {
    const rawRoot = mkdtempSync(join(tmpdir(), 'phase5-a1-audit-'));
    try {
      mkdirSync(join(rawRoot, '20260723000000-deadbeef', 'warmup', 'r1'), { recursive: true });
      const options = parseAuditCli(
        cli('warmup', join(rawRoot, '20260723000000-deadbeef', 'warmup', 'r1', 'audit.json')),
        { rawResultsRoot: rawRoot },
      );
      try {
        expect(options.scenario).toBe('warmup');
      } finally {
        closeAuditCliOptions(options);
      }
    } finally {
      rmSync(rawRoot, { recursive: true, force: true });
    }
  });
  it('A1 — audit CLI rejects an unknown scenario before datastore connection', () => {
    expect(() => parseAuditCli(cli('unknown'))).toThrow('Invalid scenario');
  });
  it('A1 — full result aggregation requires exactly one passing warmup but excludes it from 12 measured rows and median/worst calculations', () => {
    expect(validateResultArtifacts('full', fullArtifacts())).toHaveLength(12);
    expect(() => validateResultArtifacts('full', fullArtifacts().slice(1))).toThrow('warmup/r1');
  });
  it('A1 — smoke profile rejects or omits warmup and still requires smoke/r1', () => {
    expect(validateResultArtifacts('smoke', [artifact('smoke', 1)])).toHaveLength(1);
    expect(() =>
      validateResultArtifacts('smoke', [artifact('warmup', 1), artifact('smoke', 1)]),
    ).toThrow('must not contain warmup');
  });
  it('A1 — integrity inputs include warmup evidence', () => {
    expect(integrityInputPaths(fullArtifacts())).toEqual(
      expect.arrayContaining([
        'warmup/r1/k6-summary.json',
        'warmup/r1/audit.json',
        'warmup/r1/runtime.json',
      ]),
    );
  });
});

describe('Phase 5 Amendment A10 module-rooted audit output', () => {
  const cli = (runId: string, out: string) => [
    '--run-id',
    runId,
    '--scenario',
    'warmup',
    '--sale-id',
    'p5-deadbeef-warm-r1',
    '--initial-stock',
    '200',
    '--expected-confirmed',
    '200',
    '--api-url',
    'http://127.0.0.1:3300',
    '--worker-url',
    'http://127.0.0.1:3301',
    '--database-url',
    'postgresql://flash:flash@127.0.0.1:5543/flash',
    '--redis-url',
    'redis://127.0.0.1:6680',
    '--deadline-ms',
    '120000',
    '--out',
    out,
  ];

  const temporaryRawRoot = () => {
    const rawRoot = mkdtempSync(join(tmpdir(), 'phase5-a10-audit-'));
    const runId = 'a10-valid-run';
    const runRoot = join(rawRoot, runId);
    mkdirSync(runRoot);
    return { rawRoot, runId, runRoot };
  };

  it.sequential(
    'A10 — module-relative raw root accepts runner absolute output from repo root load cwd and unrelated cwd',
    () => {
      const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
      const loadRoot = fileURLToPath(new URL('.', import.meta.url));
      const unrelatedCwd = mkdtempSync(join(tmpdir(), 'phase5-a10-cwd-'));
      const runId = `a10cwd-${process.pid}-${Date.now().toString(36)}`;
      const runRoot = join(AUDIT_RAW_RESULTS_ROOT, runId);
      const output = join(runRoot, 'warmup', 'r1', 'audit.json');
      const originalCwd = process.cwd();
      mkdirSync(join(runRoot, 'warmup', 'r1'), { recursive: true });
      try {
        for (const cwd of [repositoryRoot, loadRoot, unrelatedCwd]) {
          process.chdir(cwd);
          const options = parseAuditCli(cli(runId, output));
          try {
            expect(options.out).toBe(output);
          } finally {
            closeAuditCliOptions(options);
          }
        }
      } finally {
        process.chdir(originalCwd);
        rmSync(runRoot, { recursive: true, force: true });
        rmSync(unrelatedCwd, { recursive: true, force: true });
      }
    },
  );

  it('A10 — relative audit output is rejected instead of resolved from cwd', () => {
    const fixture = temporaryRawRoot();
    let datastoreFactoryCalls = 0;
    try {
      expect(() => {
        const options = parseAuditCli(cli(fixture.runId, 'warmup/r1/audit.json'), {
          rawResultsRoot: fixture.rawRoot,
        });
        datastoreFactoryCalls += 1;
        return options;
      }).toThrow('Audit output must be absolute');
      expect(datastoreFactoryCalls).toBe(0);
    } finally {
      rmSync(fixture.rawRoot, { recursive: true, force: true });
    }
  });

  it('A10 — traversal sibling-prefix and mismatched run-id output paths are rejected', () => {
    const fixture = temporaryRawRoot();
    const sibling = join(fixture.rawRoot, `${fixture.runId}-sibling`, 'warmup', 'r1', 'audit.json');
    const mismatch = join(fixture.rawRoot, 'a10-other-run', 'warmup', 'r1', 'audit.json');
    const traversal = join(fixture.runRoot, 'warmup', '..', '..', 'escaped', 'audit.json');
    try {
      for (const output of [sibling, mismatch, traversal]) {
        expect(() =>
          parseAuditCli(cli(fixture.runId, output), { rawResultsRoot: fixture.rawRoot }),
        ).toThrow('Audit output must be inside load/results/raw');
      }
    } finally {
      rmSync(fixture.rawRoot, { recursive: true, force: true });
    }
  });

  it('A10 — symlinked output parent escaping the exact run root is rejected', () => {
    const fixture = temporaryRawRoot();
    const outside = mkdtempSync(join(tmpdir(), 'phase5-a10-outside-'));
    const linkedParent = join(fixture.runRoot, 'warmup');
    symlinkSync(outside, linkedParent, 'dir');
    try {
      expect(() =>
        parseAuditCli(cli(fixture.runId, join(linkedParent, 'audit.json')), {
          rawResultsRoot: fixture.rawRoot,
        }),
      ).toThrow('Audit output parent must be inside the exact run directory');
    } finally {
      rmSync(fixture.rawRoot, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('A10 — existing audit output is rejected and never overwritten', () => {
    const fixture = temporaryRawRoot();
    const parent = join(fixture.runRoot, 'warmup', 'r1');
    const output = join(parent, 'audit.json');
    mkdirSync(parent, { recursive: true });
    writeFileSync(output, 'immutable-evidence\n');
    try {
      expect(() =>
        parseAuditCli(cli(fixture.runId, output), { rawResultsRoot: fixture.rawRoot }),
      ).toThrow('Audit output already exists');
      expect(readFileSync(output, 'utf8')).toBe('immutable-evidence\n');
    } finally {
      rmSync(fixture.rawRoot, { recursive: true, force: true });
    }
  });

  it('A10 — valid normalized audit path is returned unchanged before datastore construction', () => {
    const fixture = temporaryRawRoot();
    const parent = join(fixture.runRoot, 'warmup', 'r1');
    mkdirSync(parent, { recursive: true });
    const output = join(parent, 'audit.json');
    const datastoreFactoryCalls = 0;
    try {
      const parsed = parseAuditCli(cli(fixture.runId, output), {
        rawResultsRoot: fixture.rawRoot,
      });
      try {
        expect(parsed.out).toBe(output);
        expect(datastoreFactoryCalls).toBe(0);
      } finally {
        closeAuditCliOptions(parsed);
      }
    } finally {
      rmSync(fixture.rawRoot, { recursive: true, force: true });
    }
  });
});

describe('Phase 5 Amendment A11 inode-pinned audit publication', () => {
  const cli = (runId: string, out: string) => [
    '--run-id',
    runId,
    '--scenario',
    'warmup',
    '--sale-id',
    'p5-deadbeef-warm-r1',
    '--initial-stock',
    '200',
    '--expected-confirmed',
    '200',
    '--api-url',
    'http://127.0.0.1:3300',
    '--worker-url',
    'http://127.0.0.1:3301',
    '--database-url',
    'postgresql://flash:flash@127.0.0.1:5543/flash',
    '--redis-url',
    'redis://127.0.0.1:6680',
    '--deadline-ms',
    '120000',
    '--out',
    out,
  ];

  const temporaryPublication = () => {
    const rawRoot = mkdtempSync(join(tmpdir(), 'phase5-a11-audit-'));
    const runId = 'a11-valid-run';
    const parent = join(rawRoot, runId, 'warmup', 'r1');
    const output = join(parent, 'audit.json');
    mkdirSync(parent, { recursive: true });
    const parsed = parseAuditCli(cli(runId, output), { rawResultsRoot: rawRoot });
    return { rawRoot, runId, parent, output, plan: parsed.publication };
  };

  const resetFaults = () => {
    Object.assign(publicationFaults, {
      writeNoProgress: false,
      tempSync: false,
      link: false,
      postLinkStat: false,
      parentSync: false,
      unlink: false,
      close: false,
      linkCompleted: false,
      opened: 0,
      closed: 0,
      helperUid: null,
      helperMode: null,
      helperNotFile: false,
    });
  };

  beforeEach(resetFaults);
  afterEach(resetFaults);

  it('A11 — parent symlink swap after parse cannot publish outside the validated run', async () => {
    const fixture = temporaryPublication();
    const outside = mkdtempSync(join(tmpdir(), 'phase5-a11-outside-'));
    const movedParent = `${fixture.parent}-validated`;
    try {
      renameSync(fixture.parent, movedParent);
      symlinkSync(outside, fixture.parent, 'dir');
      await expect(publishAuditReport(fixture.plan, 'outside-race\n')).rejects.toThrow();
      expect(() => statSync(join(outside, 'audit.json'))).toThrow();
      expect(() => statSync(join(movedParent, 'audit.json'))).toThrow();
    } finally {
      rmSync(fixture.rawRoot, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('A11 — intervening audit creation is never overwritten by atomic publication', async () => {
    const fixture = temporaryPublication();
    const sentinel = 'immutable-intervening-report\n';
    try {
      await expect(
        publishAuditReport(fixture.plan, 'attacker-must-not-replace\n', {
          beforePublish: () => writeFileSync(fixture.output, sentinel),
        }),
      ).rejects.toThrow('Audit output already exists');
      expect(readFileSync(fixture.output, 'utf8')).toBe(sentinel);
      expect(readdirSync(fixture.parent)).toEqual(['audit.json']);
    } finally {
      rmSync(fixture.rawRoot, { recursive: true, force: true });
    }
  });

  it('A11 — replacement real directory inode is rejected as an ancestor swap', async () => {
    const fixture = temporaryPublication();
    const ancestor = join(fixture.rawRoot, fixture.runId, 'warmup');
    const moved = `${ancestor}-validated`;
    try {
      renameSync(ancestor, moved);
      mkdirSync(join(ancestor, 'r1'), { recursive: true });
      await expect(publishAuditReport(fixture.plan, 'replacement-race\n')).rejects.toThrow(
        'canonical path no longer resolves to held capability',
      );
      expect(readdirSync(join(ancestor, 'r1'))).toEqual([]);
      expect(readdirSync(join(moved, 'r1'))).toEqual([]);
    } finally {
      rmSync(fixture.rawRoot, { recursive: true, force: true });
    }
  });

  it('A11 — three temp-name collisions exhaust bounded budget without removing foreign files', async () => {
    const fixture = temporaryPublication();
    const nonces = [Buffer.alloc(16, 1), Buffer.alloc(16, 2), Buffer.alloc(16, 3)];
    const sentinels = nonces.map((nonce, index) => {
      const name = `.audit.json.${process.pid}.${nonce.toString('hex')}.retained`;
      const path = join(fixture.parent, name);
      writeFileSync(path, `foreign-${index}\n`);
      return { path, bytes: `foreign-${index}\n` };
    });
    let nonceIndex = 0;
    try {
      await expect(
        publishAuditReport(fixture.plan, 'collision\n', {
          randomBytes: () => nonces[nonceIndex++]!,
        }),
      ).rejects.toThrow('Audit temp name collision budget exhausted');
      for (const sentinel of sentinels)
        expect(readFileSync(sentinel.path, 'utf8')).toBe(sentinel.bytes);
      expect(() => statSync(fixture.output)).toThrow();
    } finally {
      rmSync(fixture.rawRoot, { recursive: true, force: true });
    }
  });

  it('A11 — temp write sync and link failures quarantine only the owned temp', async () => {
    for (const fault of ['writeNoProgress', 'tempSync', 'link'] as const) {
      resetFaults();
      const fixture = temporaryPublication();
      const unrelated = join(fixture.parent, `unrelated-${fault}.txt`);
      writeFileSync(unrelated, `keep-${fault}\n`);
      try {
        if (fault === 'link') {
          await expect(
            publishAuditReport(fixture.plan, `failure-${fault}\n`, {
              invokeLinkHelper: () => ({
                status: 1,
                signal: null,
                stderr: 'injected link failure',
              }),
            }),
          ).rejects.toThrow();
        } else {
          publicationFaults[fault] = true;
          await expect(publishAuditReport(fixture.plan, `failure-${fault}\n`)).rejects.toThrow();
        }
        expect(() => statSync(fixture.output)).toThrow();
        expect(readFileSync(unrelated, 'utf8')).toBe(`keep-${fault}\n`);
        const retained = readdirSync(fixture.parent).filter((name) => name.includes('.retained'));
        expect(retained).toHaveLength(1);
        expect(statSync(join(fixture.parent, retained[0]!)).mode & 0o777).toBe(0);
      } finally {
        rmSync(fixture.rawRoot, { recursive: true, force: true });
      }
    }
  });

  it('A11 — successful hard-link publication is atomic complete mode-0400 and retains alias', async () => {
    const fixture = temporaryPublication();
    const bytes = '{\n  "pass": true\n}\n';
    try {
      const receipt = await publishAuditReport(fixture.plan, bytes, {
        randomBytes: () => Buffer.alloc(16, 4),
      });
      expect(readFileSync(fixture.output, 'utf8')).toBe(bytes);
      const stats = statSync(fixture.output);
      expect(stats.isFile()).toBe(true);
      expect(stats.mode & 0o777).toBe(0o400);
      expect(readdirSync(fixture.parent).sort()).toEqual(
        [receipt.retainedTempName, 'audit.json'].sort(),
      );
    } finally {
      rmSync(fixture.rawRoot, { recursive: true, force: true });
    }
  });

  it('A11 — post-link validation or directory-sync failure preserves published immutable output and reports failure', async () => {
    for (const fault of ['postLinkStat', 'parentSync'] as const) {
      resetFaults();
      const fixture = temporaryPublication();
      const bytes = `published-before-${fault}-failure\n`;
      const movedParent = `${fixture.parent}-renamed`;
      let tempName = '';
      try {
        await expect(
          publishAuditReport(fixture.plan, bytes, {
            afterTempSync: (name) => {
              tempName = name;
            },
            invokeLinkHelper: () => {
              linkSync(join(fixture.parent, tempName), fixture.output);
              if (fault === 'postLinkStat') chmodSync(fixture.output, 0o600);
              else renameSync(fixture.parent, movedParent);
              return {
                status: 0,
                signal: null,
                stderr: '',
              };
            },
          }),
        ).rejects.toThrow();
        const publishedOutput =
          fault === 'postLinkStat' ? fixture.output : join(movedParent, 'audit.json');
        if ((statSync(publishedOutput).mode & 0o777) === 0) chmodSync(publishedOutput, 0o400);
        expect(readFileSync(publishedOutput, 'utf8')).toBe(bytes);
        expect(() =>
          writeFileSync(publishedOutput, 'must-not-overwrite\n', { flag: 'wx' }),
        ).toThrow();
        expect(readFileSync(publishedOutput, 'utf8')).toBe(bytes);
      } finally {
        rmSync(fixture.rawRoot, { recursive: true, force: true });
      }
    }
  });

  it('A11 — unsupported platform or unavailable proc fd fails with no path fallback', async () => {
    for (const seams of [
      { platform: 'darwin' as NodeJS.Platform },
      { procFdRoot: join(tmpdir(), 'phase5-a11-missing-proc-fd') },
    ]) {
      const fixture = temporaryPublication();
      try {
        await expect(publishAuditReport(fixture.plan, 'no-fallback\n', seams)).rejects.toThrow();
        expect(readdirSync(fixture.parent)).toEqual([]);
      } finally {
        rmSync(fixture.rawRoot, { recursive: true, force: true });
      }
    }
  });

  it('A11 — repeated publication rejects existing output and preserves first report bytes', async () => {
    const fixture = temporaryPublication();
    const first = 'first-immutable-report\n';
    try {
      await publishAuditReport(fixture.plan, first);
      expect(() =>
        parseAuditCli(cli(fixture.runId, fixture.output), {
          rawResultsRoot: fixture.rawRoot,
        }),
      ).toThrow('Audit output already exists');
      expect(readFileSync(fixture.output, 'utf8')).toBe(first);
    } finally {
      rmSync(fixture.rawRoot, { recursive: true, force: true });
    }
  });

  it('A11 — every directory handle and temp handle closes on success and failure', async () => {
    for (const fault of ['success', 'pre-link', 'post-link'] as const) {
      resetFaults();
      const fixture = temporaryPublication();
      if (fault === 'pre-link') publicationFaults.tempSync = true;
      try {
        if (fault === 'success') await publishAuditReport(fixture.plan, `${fault}\n`);
        else if (fault === 'pre-link') {
          await expect(publishAuditReport(fixture.plan, `${fault}\n`)).rejects.toThrow();
        } else {
          await expect(
            publishAuditReport(fixture.plan, `${fault}\n`, {
              invokeLinkHelper: () => ({ status: 0, signal: null, stderr: '' }),
            }),
          ).rejects.toThrow();
        }
        expect(publicationFaults.opened).toBeGreaterThan(0);
        expect(publicationFaults.closed).toBe(publicationFaults.opened);
      } finally {
        rmSync(fixture.rawRoot, { recursive: true, force: true });
      }
    }
  });
});

describe('Phase 5 Amendment A12 validation-to-publication capability', () => {
  const cli = (runId: string, out: string) => [
    '--run-id',
    runId,
    '--scenario',
    'warmup',
    '--sale-id',
    'p5-deadbeef-warm-r1',
    '--initial-stock',
    '200',
    '--expected-confirmed',
    '200',
    '--api-url',
    'http://127.0.0.1:3300',
    '--worker-url',
    'http://127.0.0.1:3301',
    '--database-url',
    'postgresql://flash:flash@127.0.0.1:5543/flash',
    '--redis-url',
    'redis://127.0.0.1:6680',
    '--deadline-ms',
    '120000',
    '--out',
    out,
  ];

  const temporaryPublication = (prefix = 'phase5-a12-audit-') => {
    const rawRoot = mkdtempSync(join(tmpdir(), prefix));
    const runId = 'a12-valid-run';
    const parent = join(rawRoot, runId, 'warmup', 'r1');
    const output = join(parent, 'audit.json');
    mkdirSync(parent, { recursive: true });
    const options = parseAuditCli(cli(runId, output), { rawResultsRoot: rawRoot });
    return { rawRoot, runId, parent, output, options, capability: options.publication };
  };

  const closeAndRemove = (fixture: ReturnType<typeof temporaryPublication>) => {
    closeAuditCliOptions(fixture.options);
    rmSync(fixture.rawRoot, { recursive: true, force: true });
  };

  const retained = (parent: string) =>
    readdirSync(parent).filter((name) => name.endsWith('.retained'));

  const linkOpenTemp = ({ tempFd, parentFd }: { tempFd: number; parentFd: number }) => {
    const linked = spawnSync(
      '/usr/bin/ln',
      ['-L', '-T', '--', '/proc/self/fd/3', '/proc/self/fd/4/audit.json'],
      {
        encoding: 'utf8',
        env: { LC_ALL: 'C', LANG: 'C' },
        stdio: ['ignore', 'pipe', 'pipe', tempFd, parentFd],
      },
    );
    return {
      status: linked.status,
      signal: linked.signal,
      stderr: `${linked.stdout ?? ''}${linked.stderr ?? ''}`,
    };
  };

  const errorMessages = (error: unknown): string[] => {
    if (!(error instanceof Error)) return [];
    const nested = error instanceof AggregateError ? error.errors.flatMap(errorMessages) : [];
    return [error.message, ...nested, ...errorMessages(error.cause)];
  };

  it('A12 — live tmpfs inode reuse cannot replace the held output-directory capability', async () => {
    const tmpfsRoot = statSync('/dev/shm').isDirectory() ? '/dev/shm' : tmpdir();
    const probeRoot = mkdtempSync(join(tmpfsRoot, 'phase5-a12-reuse-'));
    const probe = join(probeRoot, 'candidate');
    mkdirSync(probe);
    const former = statSync(probe);
    rmSync(probe, { recursive: true });
    let recycled = false;
    for (let index = 0; index < 256; index += 1) {
      mkdirSync(probe);
      const current = statSync(probe);
      if (current.dev === former.dev && current.ino === former.ino) recycled = true;
      rmSync(probe, { recursive: true });
      if (recycled) break;
    }
    if (!recycled)
      console.info('A12: tmpfs inode reuse was not observed within 256 create/remove iterations');
    const fixture = temporaryPublication('phase5-a12-held-');
    try {
      rmSync(fixture.parent, { recursive: true });
      mkdirSync(fixture.parent, { recursive: true });
      await expect(publishAuditReport(fixture.capability, 'held-capability\n')).rejects.toThrow(
        'canonical path no longer resolves to held capability',
      );
      expect(readdirSync(fixture.parent)).toEqual([]);
      expect(typeof recycled).toBe('boolean');
    } finally {
      closeAndRemove(fixture);
      rmSync(probeRoot, { recursive: true, force: true });
    }
  });

  it('A12 — ancestor rename and symlink replacement cannot redirect a held capability', async () => {
    const fixture = temporaryPublication();
    const outside = mkdtempSync(join(tmpdir(), 'phase5-a12-outside-'));
    const ancestor = join(fixture.rawRoot, fixture.runId, 'warmup');
    const moved = `${ancestor}-moved`;
    try {
      renameSync(ancestor, moved);
      symlinkSync(outside, ancestor, 'dir');
      await expect(publishAuditReport(fixture.capability, 'no-redirect\n')).rejects.toThrow(
        'canonical path no longer resolves to held capability',
      );
      expect(readdirSync(outside)).toEqual([]);
      expect(readdirSync(join(moved, 'r1'))).toEqual([]);
    } finally {
      closeAndRemove(fixture);
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('A12 — cleanup name swap never deletes the foreign replacement', async () => {
    const fixture = temporaryPublication();
    let moved = '';
    let foreign = '';
    try {
      await expect(
        publishAuditReport(fixture.capability, 'owned-redacted-report\n', {
          randomBytes: () => Buffer.alloc(16, 0x31),
          afterTempSync: (name) => {
            foreign = join(fixture.parent, name);
            moved = `${foreign}.owned-moved`;
            renameSync(foreign, moved);
            writeFileSync(foreign, 'foreign-sentinel\n', { mode: 0o600 });
          },
          invokeLinkHelper: () => ({ status: 1, signal: null, stderr: 'forced failure' }),
        }),
      ).rejects.toThrow('Audit link helper failed');
      expect(readFileSync(foreign, 'utf8')).toBe('foreign-sentinel\n');
      expect(statSync(moved).mode & 0o777).toBe(0);
      expect(() => statSync(fixture.output)).toThrow();
    } finally {
      closeAndRemove(fixture);
    }
  });

  it('A12 — helper links the open temp capability and refuses a swapped or deleted source name', async () => {
    const success = temporaryPublication();
    try {
      const receipt = await publishAuditReport(success.capability, 'open-descriptor\n');
      expect(readFileSync(success.output, 'utf8')).toBe('open-descriptor\n');
      expect(statSync(join(success.parent, receipt.retainedTempName)).ino).toBe(
        statSync(success.output).ino,
      );
    } finally {
      closeAndRemove(success);
    }

    const swapped = temporaryPublication();
    let foreign = '';
    try {
      await expect(
        publishAuditReport(swapped.capability, 'must-not-link-foreign\n', {
          randomBytes: () => Buffer.alloc(16, 0x32),
          afterTempSync: (name) => {
            foreign = join(swapped.parent, name);
            unlinkSync(foreign);
            writeFileSync(foreign, 'foreign-bytes\n');
          },
        }),
      ).rejects.toThrow();
      expect(readFileSync(foreign, 'utf8')).toBe('foreign-bytes\n');
      expect(() => statSync(swapped.output)).toThrow();
    } finally {
      closeAndRemove(swapped);
    }
  });

  it('A12 — final symlink directory and intervening final both fail without overwrite', async () => {
    for (const kind of ['symlink', 'file'] as const) {
      const fixture = temporaryPublication();
      const outside = mkdtempSync(join(tmpdir(), 'phase5-a12-final-'));
      const sentinel = 'intervening-final\n';
      try {
        await expect(
          publishAuditReport(fixture.capability, 'replacement\n', {
            afterTempSync: () => {
              if (kind === 'symlink') symlinkSync(outside, fixture.output, 'dir');
              else writeFileSync(fixture.output, sentinel);
            },
          }),
        ).rejects.toThrow();
        if (kind === 'symlink') {
          expect(readdirSync(outside)).toEqual([]);
          expect(statSync(fixture.output).isSymbolicLink?.() ?? false).toBe(false);
        } else {
          expect(readFileSync(fixture.output, 'utf8')).toBe(sentinel);
        }
      } finally {
        closeAndRemove(fixture);
        rmSync(outside, { recursive: true, force: true });
      }
    }
  });

  it('A12 — parse failure closes every acquired descriptor', () => {
    const fixture = temporaryPublication();
    closeAndRemove(fixture);
    for (const stage of ['root', 'intermediate', 'parent', 'final'] as const) {
      const rawRoot = mkdtempSync(join(tmpdir(), 'phase5-a12-parse-close-'));
      const runId = 'a12-close-run';
      const parent = join(rawRoot, runId, 'warmup', 'r1');
      const output = join(parent, 'audit.json');
      mkdirSync(parent, { recursive: true });
      const before = readdirSync('/proc/self/fd').length;
      try {
        if (stage === 'final') writeFileSync(output, 'existing\n');
        const actualLstat = lstatSync;
        expect(() =>
          parseAuditCli(cli(runId, output), {
            rawResultsRoot: rawRoot,
            lstatSync: ((path: Parameters<typeof lstatSync>[0], options: never) => {
              const value = String(path);
              if (
                (stage === 'root' && value === rawRoot) ||
                (stage === 'intermediate' && value.endsWith('/warmup')) ||
                (stage === 'parent' && value.endsWith('/r1'))
              )
                throw new Error(`injected ${stage} failure`);
              return actualLstat(path, options as never);
            }) as typeof lstatSync,
          }),
        ).toThrow();
        expect(readdirSync('/proc/self/fd').length).toBe(before);
      } finally {
        rmSync(rawRoot, { recursive: true, force: true });
      }
    }
  });

  it('A12 — convergence and pre-publication CLI failures close the parsed capability', () => {
    for (const stage of ['connection', 'convergence'] as const) {
      const fixture = temporaryPublication();
      try {
        throw new Error(`${stage} failed`);
      } catch (error) {
        expect(String(error)).toContain('failed');
      } finally {
        closeAuditCliOptions(fixture.options);
      }
      expect(fixture.capability.state).toBe('closed');
      rmSync(fixture.rawRoot, { recursive: true, force: true });
    }
    const source = readFileSync(new URL('./audit.ts', import.meta.url), 'utf8');
    const runCli = source.slice(
      source.indexOf('async function runCli()'),
      source.indexOf('function redact'),
    );
    expect(runCli).toContain('finally');
    expect(runCli).toContain('if (options) closeAuditCliOptions(options)');
  });

  it('A12 — programmatic parse users can close without publishing and close is idempotent', () => {
    const fixture = temporaryPublication();
    closeAuditCliOptions(fixture.options);
    closeAuditCliOptions(fixture.options);
    expect(fixture.capability.state).toBe('closed');
    expect(readdirSync(fixture.parent)).toEqual([]);
    rmSync(fixture.rawRoot, { recursive: true, force: true });
  });

  it('A12 — publication consumes its capability on success and every failure', async () => {
    const cases = ['success', 'write', 'sync', 'helper', 'final', 'reachability'] as const;
    for (const failure of cases) {
      Object.assign(publicationFaults, {
        writeNoProgress: false,
        tempSync: false,
        link: false,
        postLinkStat: false,
        parentSync: false,
        unlink: false,
        close: false,
        linkCompleted: false,
        helperUid: null,
        helperMode: null,
        helperNotFile: false,
      });
      const fixture = temporaryPublication();
      try {
        if (failure === 'write') publicationFaults.writeNoProgress = true;
        if (failure === 'sync') publicationFaults.tempSync = true;
        if (failure === 'success') await publishAuditReport(fixture.capability, 'success\n');
        else if (failure === 'helper') {
          await expect(
            publishAuditReport(fixture.capability, 'helper\n', {
              invokeLinkHelper: () => ({ status: 1, signal: null, stderr: 'failure' }),
            }),
          ).rejects.toThrow();
        } else if (failure === 'final') {
          await expect(
            publishAuditReport(fixture.capability, 'final\n', {
              invokeLinkHelper: () => ({ status: 0, signal: null, stderr: '' }),
            }),
          ).rejects.toThrow();
        } else if (failure === 'reachability') {
          await expect(
            publishAuditReport(fixture.capability, 'reachability\n', {
              invokeLinkHelper: ({ tempFd, parentFd }) => {
                const result = spawnSync(
                  '/usr/bin/ln',
                  [
                    '-L',
                    '-T',
                    '--',
                    `/proc/self/fd/${tempFd}`,
                    `/proc/self/fd/${parentFd}/audit.json`,
                  ],
                  { encoding: 'utf8' },
                );
                renameSync(fixture.parent, `${fixture.parent}-moved`);
                return {
                  status: result.status,
                  signal: result.signal,
                  stderr: String(result.stderr ?? ''),
                };
              },
            }),
          ).rejects.toThrow();
        } else {
          await expect(publishAuditReport(fixture.capability, `${failure}\n`)).rejects.toThrow();
        }
        expect(fixture.capability.state).toBe('closed');
      } finally {
        closeAndRemove(fixture);
      }
    }
  });

  it('A12 — forged stale closed and concurrently publishing capabilities fail before mutation', async () => {
    const forged = {
      outputName: 'audit.json',
      canonicalParentPath: '/tmp',
      state: 'open',
      close() {},
    } as AuditPublicationCapability;
    await expect(publishAuditReport(forged, 'forged\n')).rejects.toThrow('Invalid');

    const fixture = temporaryPublication();
    let release!: () => void;
    let entered!: () => void;
    const enteredPromise = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = publishAuditReport(fixture.capability, 'first\n', {
      beforePublish: async () => {
        entered();
        await barrier;
      },
      invokeLinkHelper: () => ({ status: 1, signal: null, stderr: 'stop' }),
    });
    await enteredPromise;
    await expect(publishAuditReport(fixture.capability, 'second\n')).rejects.toThrow('not open');
    release();
    await expect(first).rejects.toThrow();
    await expect(publishAuditReport(fixture.capability, 'stale\n')).rejects.toThrow('not open');
    expect(readdirSync(fixture.parent).filter((name) => name === 'audit.json')).toEqual([]);
    closeAndRemove(fixture);
  });

  it('A12 — two valid parses race safely and only one immutable final wins', async () => {
    const fixture = temporaryPublication();
    const second = parseAuditCli(cli(fixture.runId, fixture.output), {
      rawResultsRoot: fixture.rawRoot,
    });
    try {
      const results = await Promise.allSettled([
        publishAuditReport(fixture.capability, 'first-racer\n'),
        publishAuditReport(second.publication, 'second-racer\n'),
      ]);
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
      expect(['first-racer\n', 'second-racer\n']).toContain(readFileSync(fixture.output, 'utf8'));
      expect(statSync(fixture.output).mode & 0o777).toBe(0o400);
      expect(fixture.capability.state).toBe('closed');
      expect(second.publication.state).toBe('closed');
    } finally {
      closeAuditCliOptions(second);
      closeAndRemove(fixture);
    }
  });

  it('A12 — temp collisions and failures retain only bounded non-writable artifacts', async () => {
    const collision = temporaryPublication();
    const nonces = [Buffer.alloc(16, 1), Buffer.alloc(16, 2), Buffer.alloc(16, 3)];
    try {
      for (const [index, nonce] of nonces.entries())
        writeFileSync(
          join(collision.parent, `.audit.json.${process.pid}.${nonce.toString('hex')}.retained`),
          `foreign-${index}\n`,
        );
      let index = 0;
      await expect(
        publishAuditReport(collision.capability, 'collision\n', {
          randomBytes: () => nonces[index++]!,
        }),
      ).rejects.toThrow('collision budget');
      expect(retained(collision.parent)).toHaveLength(3);
    } finally {
      closeAndRemove(collision);
    }

    const success = temporaryPublication();
    try {
      const receipt = await publishAuditReport(success.capability, 'immutable\n');
      expect(statSync(join(success.parent, receipt.retainedTempName)).mode & 0o777).toBe(0o400);
    } finally {
      closeAndRemove(success);
    }

    const failure = temporaryPublication();
    try {
      await expect(
        publishAuditReport(failure.capability, 'quarantine\n', {
          invokeLinkHelper: () => ({ status: 1, signal: null, stderr: 'no link' }),
        }),
      ).rejects.toThrow();
      expect(retained(failure.parent)).toHaveLength(1);
      expect(statSync(join(failure.parent, retained(failure.parent)[0]!)).mode & 0o777).toBe(0);
    } finally {
      closeAndRemove(failure);
    }
  });

  it('A12 — GNU helper validation spawn timeout signal and oversized output fail closed', async () => {
    const helper = statSync('/usr/bin/ln');
    expect(helper.isFile()).toBe(true);
    expect(helper.mode & 0o022).toBe(0);
    for (const invalid of ['owner', 'mode', 'type'] as const) {
      const fixture = temporaryPublication();
      publicationFaults.helperUid = invalid === 'owner' ? 1n : null;
      publicationFaults.helperMode = invalid === 'mode' ? 0o100777n : null;
      publicationFaults.helperNotFile = invalid === 'type';
      try {
        await expect(
          publishAuditReport(fixture.capability, `invalid-${invalid}\n`, {
            invokeLinkHelper: () => ({ status: 0, signal: null, stderr: '' }),
          }),
        ).rejects.toThrow('trusted root-owned executable');
        expect(() => statSync(fixture.output)).toThrow();
      } finally {
        publicationFaults.helperUid = null;
        publicationFaults.helperMode = null;
        publicationFaults.helperNotFile = false;
        closeAndRemove(fixture);
      }
    }
    const cases = [
      { status: 1, signal: null, stderr: 'nonzero' },
      { status: null, signal: 'SIGKILL' as NodeJS.Signals, stderr: 'timeout' },
      { status: 0, signal: null, stderr: 'x'.repeat(65_537) },
    ];
    for (const result of cases) {
      const fixture = temporaryPublication();
      try {
        await expect(
          publishAuditReport(fixture.capability, 'helper-failure\n', {
            invokeLinkHelper: (invocation) => {
              expect(invocation.tempFd).toBeGreaterThan(2);
              expect(invocation.parentFd).toBeGreaterThan(2);
              expect(invocation.helperFd).toBeGreaterThan(2);
              return result;
            },
          }),
        ).rejects.toThrow();
        expect(() => statSync(fixture.output)).toThrow();
      } finally {
        closeAndRemove(fixture);
      }
    }
    const source = readFileSync(new URL('./audit.ts', import.meta.url), 'utf8');
    expect(source).toContain("'/proc/self/fd/5'");
    expect(source).toContain("['-L', '-T', '--', '/proc/self/fd/3'");
    expect(source).toContain("env: { LC_ALL: 'C', LANG: 'C' }");
    expect(source).toContain('timeout: 5000');
    expect(source).toContain('maxBuffer: 65_536');
  });

  it('A12 — abrupt child exit closes capabilities and never exposes a partial final', () => {
    for (const boundary of ['before-temp', 'partial-temp', 'after-helper']) {
      const fixture = temporaryPublication();
      closeAuditCliOptions(fixture.options);
      const childSource = `
        const fs = require('node:fs');
        const { spawnSync } = require('node:child_process');
        const parent = ${JSON.stringify(fixture.parent)};
        const boundary = ${JSON.stringify(boundary)};
        const parentFd = fs.openSync(parent, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
        if (boundary === 'before-temp') process.exit(21);
        const name = '.audit.json.abrupt.${boundary}.retained';
        const tempFd = fs.openSync('/proc/self/fd/' + parentFd + '/' + name,
          fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
        fs.writeSync(tempFd, boundary === 'partial-temp' ? 'partial' : 'complete-report\\n');
        if (boundary === 'partial-temp') process.exit(22);
        fs.fsyncSync(tempFd);
        fs.fchmodSync(tempFd, 0o400);
        fs.fsyncSync(tempFd);
        const helperFd = fs.openSync('/usr/bin/ln', fs.constants.O_RDONLY);
        const linked = spawnSync('/proc/self/fd/5',
          ['-L', '-T', '--', '/proc/self/fd/3', '/proc/self/fd/4/audit.json'],
          { stdio: ['ignore', 'pipe', 'pipe', tempFd, parentFd, helperFd],
            env: { LC_ALL: 'C', LANG: 'C' }, timeout: 5000 });
        process.exit(linked.status === 0 ? 23 : 93);
      `;
      const child = spawnSync(process.execPath, ['-e', childSource]);
      expect(child.status).toBe(
        boundary === 'before-temp' ? 21 : boundary === 'partial-temp' ? 22 : 23,
      );
      const names = readdirSync(fixture.parent);
      if (boundary === 'before-temp') {
        expect(names).toEqual([]);
      } else if (boundary === 'partial-temp') {
        expect(names).toEqual(['.audit.json.abrupt.partial-temp.retained']);
        expect(() => statSync(fixture.output)).toThrow();
        expect(statSync(join(fixture.parent, names[0]!)).mode & 0o777).toBe(0o600);
      } else {
        expect(readFileSync(fixture.output, 'utf8')).toBe('complete-report\n');
        const temp = statSync(join(fixture.parent, '.audit.json.abrupt.after-helper.retained'));
        const final = statSync(fixture.output);
        expect(temp.ino).toBe(final.ino);
        expect(final.mode & 0o777).toBe(0o400);
      }
      rmSync(fixture.rawRoot, { recursive: true, force: true });
    }
  });

  it('A12 — successful publication is complete atomic mode-0400 and pathname-free after parse', async () => {
    const fixture = temporaryPublication();
    const bytes = '{\n  "pass": true\n}\n';
    try {
      const receipt = await publishAuditReport(fixture.capability, bytes, {
        randomBytes: () => Buffer.alloc(16, 0x7a),
      });
      const finalStat = statSync(fixture.output);
      const tempStat = statSync(join(fixture.parent, receipt.retainedTempName));
      expect(readFileSync(fixture.output, 'utf8')).toBe(bytes);
      expect(finalStat.mode & 0o777).toBe(0o400);
      expect(tempStat.ino).toBe(finalStat.ino);
      expect(tempStat.dev).toBe(finalStat.dev);
      expect(finalStat.nlink).toBeGreaterThanOrEqual(2);
      expect(receipt).toEqual({
        outputName: 'audit.json',
        retainedTempName: `.audit.json.${process.pid}.${'7a'.repeat(16)}.retained`,
      });
      expect(fixture.capability.state).toBe('closed');
      const source = readFileSync(new URL('./audit.ts', import.meta.url), 'utf8');
      const publication = source.slice(
        source.indexOf('export async function publishAuditReport'),
        source.indexOf('export function parseAuditCli'),
      );
      expect(publication).not.toMatch(/\bunlink\s*\(/);
      expect(publication).not.toMatch(/\brename\s*\(/);
      expect(publication).not.toContain('rawRootIdentity');
      expect(publication).not.toContain('directoryChain');
    } finally {
      closeAndRemove(fixture);
    }
  });

  it('A14 — bind-mount-visible alias with unchanged proc readlink rejects before link', async () => {
    const fixture = temporaryPublication('phase5-a14-bind-alias-');
    const held = statSync(fixture.parent, { bigint: true });
    let parentChecks = 0;
    let parentStats = 0;
    let helperCalls = 0;
    try {
      await expect(
        publishAuditReport(fixture.capability, 'bind-visible-alias\n', {
          canonicalPathLstatSync: ((path, options) => {
            if (String(path) !== fixture.parent) return lstatSync(path, options);
            parentChecks += 1;
            const stat = lstatSync(path, { bigint: true });
            if (parentChecks < 3) return stat;
            return new Proxy(stat, {
              get(target, property, receiver) {
                if (property === 'ino') return held.ino + 1n;
                return Reflect.get(target, property, receiver);
              },
            });
          }) as typeof lstatSync,
          canonicalPathStatSync: ((path, _options) => {
            parentStats += 1;
            const stat = statSync(path, { bigint: true });
            if (parentStats < 3) return stat;
            return new Proxy(stat, {
              get(target, property, receiver) {
                if (property === 'ino') return held.ino + 1n;
                return Reflect.get(target, property, receiver);
              },
            });
          }) as typeof statSync,
          invokeLinkHelper: () => {
            helperCalls += 1;
            return { status: 0, signal: null, stderr: '' };
          },
        }),
      ).rejects.toThrow('Audit output parent canonical path no longer resolves to held capability');
      expect(helperCalls).toBe(0);
      expect(() => statSync(fixture.output)).toThrow();
      expect(retained(fixture.parent)).toHaveLength(1);
      expect(statSync(join(fixture.parent, retained(fixture.parent)[0]!)).mode & 0o777).toBe(0);
      expect(fixture.capability.state).toBe('closed');
    } finally {
      closeAndRemove(fixture);
    }
  });

  it('A14 — overlay installed by the link boundary rejects after helper and quarantines the hidden final', async () => {
    const fixture = temporaryPublication('phase5-a14-overlay-link-');
    const held = statSync(fixture.parent, { bigint: true });
    let parentChecks = 0;
    let parentStats = 0;
    try {
      await expect(
        publishAuditReport(fixture.capability, 'hidden-final\n', {
          canonicalPathLstatSync: ((path, options) => {
            if (String(path) !== fixture.parent) return lstatSync(path, options);
            parentChecks += 1;
            const stat = lstatSync(path, { bigint: true });
            if (parentChecks < 4) return stat;
            return new Proxy(stat, {
              get(target, property, receiver) {
                if (property === 'ino') return held.ino + 1n;
                return Reflect.get(target, property, receiver);
              },
            });
          }) as typeof lstatSync,
          canonicalPathStatSync: ((path, _options) => {
            parentStats += 1;
            const stat = statSync(path, { bigint: true });
            if (parentStats < 4) return stat;
            return new Proxy(stat, {
              get(target, property, receiver) {
                if (property === 'ino') return held.ino + 1n;
                return Reflect.get(target, property, receiver);
              },
            });
          }) as typeof statSync,
          invokeLinkHelper: linkOpenTemp,
        }),
      ).rejects.toThrow('Audit output parent canonical path no longer resolves to held capability');
      expect(statSync(fixture.output).mode & 0o777).toBe(0);
      expect(fixture.capability.state).toBe('closed');
    } finally {
      closeAndRemove(fixture);
    }
  });

  it('A14 — canonical parent and final matching held capabilities permit publication', async () => {
    const fixture = temporaryPublication('phase5-a14-match-');
    const bytes = 'canonical-visible\n';
    try {
      const receipt = await publishAuditReport(fixture.capability, bytes, {
        canonicalPathLstatSync: lstatSync,
        canonicalPathStatSync: statSync,
      });
      const finalStat = statSync(fixture.output, { bigint: true });
      const retainedStat = statSync(join(fixture.parent, receipt.retainedTempName), {
        bigint: true,
      });
      expect(finalStat.ino).toBe(retainedStat.ino);
      expect(finalStat.mode & 0o777n).toBe(0o400n);
      expect(readFileSync(fixture.output, 'utf8')).toBe(bytes);
      expect(fixture.capability.state).toBe('closed');
    } finally {
      closeAndRemove(fixture);
    }
  });

  it('A14 — canonical symlink missing path non-directory and stat failure all reject', async () => {
    for (const kind of ['symlink', 'missing', 'non-directory', 'stat-failure'] as const) {
      const fixture = temporaryPublication(`phase5-a14-${kind}-`);
      let helperCalls = 0;
      try {
        const rejected = publishAuditReport(fixture.capability, `${kind}\n`, {
          canonicalPathLstatSync:
            kind === 'missing'
              ? ((() => {
                  throw new Error('injected missing canonical path');
                }) as typeof lstatSync)
              : kind === 'symlink' || kind === 'non-directory'
                ? (((path, _options) => {
                    const stat = lstatSync(path, { bigint: true });
                    return new Proxy(stat, {
                      get(target, property, receiver) {
                        if (property === 'isDirectory') return () => kind !== 'non-directory';
                        if (property === 'isSymbolicLink') return () => kind === 'symlink';
                        return Reflect.get(target, property, receiver);
                      },
                    });
                  }) as typeof lstatSync)
                : lstatSync,
          canonicalPathStatSync:
            kind === 'stat-failure'
              ? ((() => {
                  throw new Error('injected canonical stat failure');
                }) as typeof statSync)
              : statSync,
          invokeLinkHelper: () => {
            helperCalls += 1;
            return { status: 0, signal: null, stderr: '' };
          },
        });
        await expect(rejected).rejects.toThrow(
          'Audit output parent canonical path no longer resolves to held capability',
        );
        await rejected.catch((error: Error) => {
          if (kind === 'missing' || kind === 'stat-failure')
            expect(error.cause).toBeInstanceOf(Error);
        });
        expect(helperCalls).toBe(0);
      } finally {
        closeAndRemove(fixture);
      }
    }
  });

  it('A14 — canonical audit symlink or foreign inode rejects after link', async () => {
    for (const kind of ['symlink', 'foreign'] as const) {
      const fixture = temporaryPublication(`phase5-a14-final-${kind}-`);
      try {
        await expect(
          publishAuditReport(fixture.capability, 'same-size-final\n', {
            canonicalPathLstatSync: ((path, _options) => {
              const stat = lstatSync(path, { bigint: true });
              if (String(path) === fixture.parent) return stat;
              return new Proxy(stat, {
                get(target, property, receiver) {
                  if (property === 'isSymbolicLink') return () => kind === 'symlink';
                  if (property === 'ino' && kind === 'foreign') return stat.ino + 1n;
                  return Reflect.get(target, property, receiver);
                },
              });
            }) as typeof lstatSync,
            canonicalPathStatSync: statSync,
            invokeLinkHelper: linkOpenTemp,
          }),
        ).rejects.toThrow('Canonical audit output does not resolve to the published capability');
        expect(statSync(fixture.output).mode & 0o777).toBe(0);
      } finally {
        closeAndRemove(fixture);
      }
    }
  });

  it('A14 — reachability checks are immediately adjacent to the atomic helper boundary', async () => {
    const fixture = temporaryPublication('phase5-a14-adjacent-');
    const events: string[] = [];
    let parentChecks = 0;
    try {
      await publishAuditReport(fixture.capability, 'adjacent\n', {
        canonicalPathLstatSync: ((path, options) => {
          if (String(path) === fixture.parent) {
            parentChecks += 1;
            if (parentChecks === 3) events.push('canonical-pre');
            if (parentChecks === 4) events.push('canonical-post');
          }
          return lstatSync(path, options);
        }) as typeof lstatSync,
        canonicalPathStatSync: statSync,
        invokeLinkHelper: ({ tempFd, parentFd }) => {
          events.push('helper');
          return linkOpenTemp({ tempFd, parentFd });
        },
      });
      const boundary = events.indexOf('canonical-pre');
      expect(events.slice(boundary, boundary + 3)).toEqual([
        'canonical-pre',
        'helper',
        'canonical-post',
      ]);
    } finally {
      closeAndRemove(fixture);
    }
  });

  it('A14 — post-link reachability plus quarantine and close failures preserve the primary error', async () => {
    const fixture = temporaryPublication('phase5-a14-errors-');
    let parentChecks = 0;
    let parentStats = 0;
    try {
      const rejected = publishAuditReport(fixture.capability, 'aggregate\n', {
        afterTempSync: () => {
          publicationFaults.tempSync = true;
          publicationFaults.close = true;
        },
        canonicalPathLstatSync: ((path, options) => {
          if (String(path) !== fixture.parent) return lstatSync(path, options);
          parentChecks += 1;
          const stat = lstatSync(path, { bigint: true });
          if (parentChecks < 4) return stat;
          return new Proxy(stat, {
            get(target, property, receiver) {
              if (property === 'ino') return stat.ino + 1n;
              return Reflect.get(target, property, receiver);
            },
          });
        }) as typeof lstatSync,
        canonicalPathStatSync: ((path, _options) => {
          parentStats += 1;
          const stat = statSync(path, { bigint: true });
          if (parentStats < 4) return stat;
          return new Proxy(stat, {
            get(target, property, receiver) {
              if (property === 'ino') return stat.ino + 1n;
              return Reflect.get(target, property, receiver);
            },
          });
        }) as typeof statSync,
        invokeLinkHelper: linkOpenTemp,
      });
      await expect(rejected).rejects.toBeInstanceOf(AggregateError);
      await rejected.catch((error: Error) => {
        expect(error).toBeInstanceOf(AggregateError);
        expect(errorMessages(error)).toContain(
          'Audit output parent canonical path no longer resolves to held capability',
        );
      });
      expect(statSync(fixture.output).mode & 0o777).toBe(0);
      expect(fixture.capability.state).toBe('closed');
    } finally {
      publicationFaults.tempSync = false;
      publicationFaults.close = false;
      closeAndRemove(fixture);
    }
  });

  it('A14 — production writes remain descriptor-only while canonical lookups are rejection-only', async () => {
    const fixture = temporaryPublication('phase5-a14-descriptor-only-');
    const canonicalLookups: string[] = [];
    try {
      await publishAuditReport(fixture.capability, 'descriptor-only\n', {
        canonicalPathLstatSync: ((path, options) => {
          canonicalLookups.push(String(path));
          return lstatSync(path, options);
        }) as typeof lstatSync,
        canonicalPathStatSync: ((path, options) => {
          canonicalLookups.push(String(path));
          return statSync(path, options);
        }) as typeof statSync,
      });
      expect(canonicalLookups).toContain(fixture.parent);
      expect(canonicalLookups).toContain(fixture.output);
      const source = readFileSync(new URL('./audit.ts', import.meta.url), 'utf8');
      const publication = source.slice(
        source.indexOf('export async function publishAuditReport'),
        source.indexOf('export function parseAuditCli'),
      );
      expect(publication).not.toMatch(
        /fsPromises\.(?:open|writeFile|link)\(record\.canonicalParentPath/,
      );
      expect(publication).not.toMatch(/\bunlink\s*\(/);
      expect(source).toContain("['-L', '-T', '--', '/proc/self/fd/3'");
      expect(source).toContain('helperStat.uid !== 0n');
      expect(fixture.capability.state).toBe('closed');
    } finally {
      closeAndRemove(fixture);
    }
  });
});

describe('Phase 5 Amendment A3 non-root result mount', () => {
  it('A3 — runner derives non-root POSIX UID and GID and overwrites inherited internal values', () => {
    const identity = derivePosixIdentity(
      () => 1234,
      () => 5678,
      {
        PHASE5_K6_UID: '9999',
        PHASE5_K6_GID: '9999',
      },
    );
    expect(identity).toMatchObject({
      uid: 1234,
      gid: 5678,
      env: { PHASE5_K6_UID: '1234', PHASE5_K6_GID: '5678' },
    });
  });

  it('A3 — missing POSIX identity or UID/GID zero fails before Compose', () => {
    expect(() => derivePosixIdentity(null, () => 1000, {})).toThrow('non-root POSIX UID/GID');
    expect(() =>
      derivePosixIdentity(
        () => 0,
        () => 1000,
        {},
      ),
    ).toThrow('non-root POSIX UID/GID');
    expect(() =>
      derivePosixIdentity(
        () => 1000,
        () => 0,
        {},
      ),
    ).toThrow('non-root POSIX UID/GID');
  });

  it('A3 — rendered k6 service uses exact uid:gid, read-only root, private tmpfs, and read-only scripts', () => {
    const compose = readFileSync(new URL('./docker-compose.yml', import.meta.url), 'utf8');
    expect(compose).toContain(
      "user: '${PHASE5_K6_UID:?PHASE5_K6_UID is required}:${PHASE5_K6_GID:?PHASE5_K6_GID is required}'",
    );
    expect(compose).toContain('read_only: true');
    expect(compose).toContain('/tmp:rw,nosuid,nodev,noexec,mode=1777,size=64m');
    expect(compose).toContain('- ./k6:/scripts:ro');
  });

  it('A3 — successful permission probe removes its file before k6 starts', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'phase5-probe-success-'));
    try {
      const execute = async (_command: string, args: string[]) => {
        expect(args).toContain('PHASE5_PROBE_PATH=/results/warmup/r1/.phase5-write-probe');
        const probe = join(directory, '.phase5-write-probe');
        await writeFile(probe, '');
        await rm(probe);
        return { code: 0, signal: null, stdout: '', stderr: '', timedOut: false };
      };
      const report = await runPermissionProbe({
        project: 'flash-load-contract',
        env: {},
        scenario: 'warmup',
        repetition: 1,
        scenarioDir: directory,
        uid: 1234,
        gid: 5678,
        execute,
      });
      expect(report).toEqual({
        uid: 1234,
        gid: 5678,
        containerExitCode: 0,
        probeCreatedAndRemoved: true,
      });
      expect(JSON.parse(await readFile(join(directory, 'permission-probe.json'), 'utf8'))).toEqual(
        report,
      );
    } finally {
      await rm(directory, { recursive: true });
    }
  });

  it('A3 — failed permission probe prevents k6, sampler, and audit and still requests scoped cleanup', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'phase5-probe-failure-'));
    const k6 = false;
    const sampler = false;
    const audit = false;
    let cleanup = false;
    try {
      await expect(
        runPermissionProbe({
          project: 'flash-load-contract',
          env: {},
          scenario: 'warmup',
          repetition: 1,
          scenarioDir: directory,
          uid: 1234,
          gid: 5678,
          execute: async () => ({
            code: 1,
            signal: null,
            stdout: '',
            stderr: 'denied',
            timedOut: false,
          }),
        }),
      ).rejects.toThrow('permission-preflight failed');
    } finally {
      cleanup = true;
      expect({ k6, sampler, audit, cleanup }).toEqual({
        k6: false,
        sampler: false,
        audit: false,
        cleanup: true,
      });
      const status = JSON.parse(await readFile(join(directory, 'command-status.json'), 'utf8'));
      expect(status).toMatchObject({ permissionProbe: 1, k6: null, sampler: null, audit: null });
      await rm(directory, { recursive: true });
    }
  });

  it('A3 — runner passes an absolute RAW_RESULT_DIR and never invokes chmod, chown, or a shell-joined Docker command', () => {
    const source = readFileSync(new URL('../scripts/stress.mjs', import.meta.url), 'utf8');
    expect(source).toContain('config.runDir = resolve(rawRoot, config.runId)');
    expect(source).toContain('RAW_RESULT_DIR: config.runDir');
    expect(source).toMatch(/execute\(\s*'docker',\s*composeArgs\(/);
    expect(source).not.toMatch(/spawn\(['"](?:chmod|chown)/);
    expect(source).not.toContain('shell: true');
  });

  it('A3 — stale user-supplied PHASE5_K6_UID/GID values cannot override derived identity', () => {
    const identity = derivePosixIdentity(
      () => 2001,
      () => 2002,
      {
        PHASE5_K6_UID: '1',
        PHASE5_K6_GID: '2',
        RAW_RESULT_DIR: '/untrusted',
      },
    );
    expect(identity.env.PHASE5_K6_UID).toBe('2001');
    expect(identity.env.PHASE5_K6_GID).toBe('2002');
  });
});

describe('Phase 5 Amendment A4 executable audit command', () => {
  it('A4 — runner invokes the package audit script through pnpm run with the exact argument boundary', async () => {
    let capturedCommand = '';
    let capturedArgs: string[] = [];
    let capturedOptions: Record<string, unknown> = {};
    await runPackageAudit(
      ['--run-id', '20260723000000-deadbeef', '--scenario', 'smoke'],
      async (command: string, args: string[], options: Record<string, unknown>) => {
        capturedCommand = command;
        capturedArgs = args;
        capturedOptions = options;
        return { code: 0, signal: null, stdout: '', stderr: '', timedOut: false };
      },
    );

    expect(capturedCommand).toBe('pnpm');
    expect(capturedArgs.slice(0, 5)).toEqual([
      '--filter',
      '@flash/load',
      'run',
      'audit',
      '--run-id',
    ]);
    expect(capturedArgs[4]).toBe('--run-id');
    expect(capturedArgs).not.toContain('--');
    expect(
      capturedArgs.some(
        (argument, index) =>
          argument === '--filter' &&
          capturedArgs[index + 1] === '@flash/load' &&
          capturedArgs[index + 2] === 'audit',
      ),
    ).toBe(false);
    expect(capturedOptions).toEqual({ live: true, role: 'audit' });
  });

  it('A7 — real pnpm 11 subprocess forwards --run-id without a literal separator', () => {
    const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
    const result = spawnSync(
      'pnpm',
      ['--filter', '@flash/load', 'run', 'audit', '--run-id', 'a7-forwarding-probe'],
      {
        cwd: repositoryRoot,
        encoding: 'utf8',
        timeout: 10_000,
      },
    );
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    const redactedOutput = output.replace(/([a-z]+:\/\/[^:/\s]+:)[^@\s]+@/gi, '$1[REDACTED]@');

    expect(result.error, redactedOutput).toBeUndefined();
    expect(result.signal, redactedOutput).toBeNull();
    expect(typeof result.status, redactedOutput).toBe('number');
    expect(result.status, redactedOutput).not.toBe(0);
    expect(output, redactedOutput).toContain('tsx audit.ts --run-id a7-forwarding-probe');
    expect(output, redactedOutput).not.toContain('tsx audit.ts -- --run-id');
    expect(output, redactedOutput).toContain('Every audit flag is required exactly once');
    expect(output, redactedOutput).not.toMatch(/ECONN|Redis|Postgres|password|timeout/i);
  });
});
