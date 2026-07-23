import { EventEmitter } from 'node:events';
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import {
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';

// @ts-expect-error The production runner is intentionally plain Node ESM.
import * as stress from '../scripts/stress.mjs';

const {
  COMMAND_STATUS_TEMPLATE,
  CONTAINER_STATS_HEADER,
  CORE_STATS_SERVICES,
  K6_DISCOVERY_GRACE_MS,
  PHASE5_IMPLEMENTATION_INPUTS,
  STATS_MAX_COMPLETION_GAP_MS,
  WORKLOAD_STATS_SERVICE,
  command,
  computeImplementationDigest,
  createChildRegistry,
  formatComposeLogEvidence,
  formatRedisSlowlogEvidence,
  normalizeDockerStats,
  signalExitCode,
  startSamplers,
  updateCommandStatus,
  validateCommandResult,
  validateComposeLogEvidence,
  validateContainerInspection,
  validateEvidenceInventory,
  validatePostgresStats,
  validateRedisInfo,
  validateSamplerEvidence,
} = stress;

const iso = (offset: number) => new Date(1_800_000_000_000 + offset).toISOString();
const jsonl = (rows: unknown[]) => `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`;
const httpRow = (timestamp: string, body: object, status = 200) => ({
  timestamp,
  status,
  latencyMs: 1,
  body,
});

async function samplerFixture(
  overrides: {
    worker?: unknown[] | string;
    api?: unknown[] | string;
    metrics?: unknown[] | string;
    stats?: string;
    runtime?: object;
  } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), 'phase5-sampler-'));
  const saleId = 'p5-12345678-surge-r1';
  const api = overrides.api ?? [
    httpRow(iso(1), { status: 'ok', service: 'api', queue: { waiting: 1 } }),
  ];
  const worker = overrides.worker ?? [
    httpRow(iso(2), {
      status: 'ok',
      service: 'worker',
      checks: { bootstrapReconciled: true, consumerReady: true, reconciliationHealthy: true },
      activeJobs: 2,
      failedJobs: 0,
    }),
  ];
  const metrics = overrides.metrics ?? [
    httpRow(iso(3), {
      saleId,
      metrics: { confirmed: 0 },
      serverTime: iso(3),
      serverTimeMs: Date.parse(iso(3)),
    }),
  ];
  const project = 'flash-load-test';
  const statsRow = (timestamp: string, service: string, containerProject = project) =>
    [
      timestamp,
      service,
      `${containerProject}-${service}-1`,
      '1%',
      '1MiB',
      '2MiB',
      '0B / 0B',
      '0B / 0B',
    ]
      .map((value) => `"${value}"`)
      .join(',');
  const statsRows = [
    ...CORE_STATS_SERVICES.map((service: string) => statsRow(iso(2), service)),
    ...[...CORE_STATS_SERVICES, WORKLOAD_STATS_SERVICE].map((service: string) =>
      statsRow(iso(3), service),
    ),
    ...[...CORE_STATS_SERVICES, WORKLOAD_STATS_SERVICE].map((service: string) =>
      statsRow(iso(4), service),
    ),
    ...CORE_STATS_SERVICES.map((service: string) => statsRow(iso(6), service)),
  ];
  const runtime = {
    saleId,
    project,
    workloadStartedAt: iso(0),
    samplerStartedAt: iso(1),
    workloadSettledAt: iso(5),
    samplerStoppedAt: iso(7),
    ...(overrides.runtime ?? {}),
  };
  await Promise.all([
    writeFile(join(directory, 'runtime.json'), JSON.stringify(runtime)),
    writeFile(join(directory, 'api-readiness.jsonl'), typeof api === 'string' ? api : jsonl(api)),
    writeFile(
      join(directory, 'worker-readiness.jsonl'),
      typeof worker === 'string' ? worker : jsonl(worker),
    ),
    writeFile(
      join(directory, 'sale-metrics.jsonl'),
      typeof metrics === 'string' ? metrics : jsonl(metrics),
    ),
    writeFile(
      join(directory, 'container-stats.csv'),
      overrides.stats ?? `${CONTAINER_STATS_HEADER}\n${statsRows.join('\n')}\n`,
    ),
  ]);
  return directory;
}

function statsCsv(
  groups: Array<{ timestamp: string; services: readonly string[]; project?: string }>,
) {
  const rows = groups.flatMap(({ timestamp, services, project = 'flash-load-test' }) =>
    services.map((service) =>
      [timestamp, service, `${project}-${service}-1`, '1%', '1MiB', '2MiB', '0B / 0B', '0B / 0B']
        .map((value) => `"${value}"`)
        .join(','),
    ),
  );
  return `${CONTAINER_STATS_HEADER}\n${rows.join('\n')}\n`;
}

const core = [...CORE_STATS_SERVICES] as string[];
const complete = [...CORE_STATS_SERVICES, WORKLOAD_STATS_SERVICE] as string[];

async function inventoryFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'phase5-inventory-'));
  const objectFiles = [
    'k6-summary.json',
    'audit.json',
    'runtime.json',
    'postgres-before.json',
    'postgres-after.json',
  ];
  const textFiles = [
    'k6-summary.txt',
    'compose-config.yml',
    'container-stats.csv',
    'api-readiness.jsonl',
    'worker-readiness.jsonl',
    'sale-metrics.jsonl',
    'redis-info-before.txt',
    'redis-info-after.txt',
    'redis-slowlog.txt',
  ];
  await Promise.all([
    ...objectFiles.map((name) => writeFile(join(directory, name), '{}\n')),
    ...textFiles.map((name) => writeFile(join(directory, name), 'evidence\n')),
    writeFile(
      join(directory, 'api.log'),
      formatComposeLogEvidence(
        'api',
        { code: 0, signal: null, timedOut: false, stdout: '', stderr: '' },
        iso(0),
      ),
    ),
    writeFile(
      join(directory, 'worker.log'),
      formatComposeLogEvidence(
        'worker',
        { code: 0, signal: null, timedOut: false, stdout: '', stderr: '' },
        iso(0),
      ),
    ),
    writeFile(join(directory, 'container-inspect.json'), '[{}]\n'),
    writeFile(
      join(directory, 'command-status.json'),
      `${JSON.stringify({
        ...COMMAND_STATUS_TEMPLATE,
        ...Object.fromEntries(
          Object.keys(COMMAND_STATUS_TEMPLATE)
            .filter((key) => key !== 'cleanup')
            .map((key) => [key, 0]),
        ),
      })}\n`,
    ),
  ]);
  return directory;
}

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  exitCode: number | null = null;
  kills: string[] = [];
  kill(signal: string) {
    this.kills.push(signal);
    return true;
  }
}

describe('A5 harness hardening', () => {
  it('A5 — post-initial worker 503 fails even when terminal audit is healthy', async () => {
    const directory = await samplerFixture({ worker: [httpRow(iso(2), { status: 'error' }, 503)] });
    await expect(validateSamplerEvidence(directory, iso(1))).rejects.toThrow(
      /Worker readiness degraded/,
    );
  });

  it('A5 — worker transport failure and malformed readiness envelope fail closed', async () => {
    const transport = { timestamp: iso(1), status: 0, latencyMs: 1, error: 'refused' };
    await expect(
      validateSamplerEvidence(await samplerFixture({ worker: [transport] }), iso(1)),
    ).rejects.toThrow(/degraded/);
    await expect(
      validateSamplerEvidence(
        await samplerFixture({
          worker: [httpRow(iso(1), { status: 'ok', service: 'worker', checks: {} })],
        }),
        iso(1),
      ),
    ).rejects.toThrow(/degraded/);
  });

  it('A5 — healthy worker samples permit transient nonzero active jobs during load', async () => {
    const report = await validateSamplerEvidence(await samplerFixture(), iso(1));
    expect(report).toEqual({
      apiSamples: 1,
      workerSamples: 1,
      metricSamples: 1,
      statsSamples: 4,
      statsPreWorkloadSamples: 1,
      statsActiveSamples: 2,
      statsPostWorkloadSamples: 1,
      firstK6ObservedAt: iso(3),
      lastK6ObservedAt: iso(4),
      maxStatsCompletionGapMs: 2,
      workerDegradedSamples: 0,
    });
  });

  it('A5 — empty truncated nonmonotonic or pre-start readiness evidence is rejected', async () => {
    for (const worker of [
      '',
      '{}',
      jsonl([httpRow(iso(2), {}), httpRow(iso(1), {})]),
      jsonl([httpRow(iso(-1), {})]),
    ])
      await expect(
        validateSamplerEvidence(await samplerFixture({ worker }), iso(1)),
      ).rejects.toThrow();
  });

  it('A5 — API and sale-metrics availability/schema are parsed without treating metric lag as failure', async () => {
    await expect(
      validateSamplerEvidence(
        await samplerFixture({
          metrics: [
            httpRow(iso(3), {
              saleId: 'wrong',
              metrics: { confirmed: 999 },
              serverTime: iso(3),
              serverTimeMs: Date.parse(iso(3)),
            }),
          ],
        }),
        iso(1),
      ),
    ).rejects.toThrow(/sale mismatch/);
    await expect(
      validateSamplerEvidence(
        await samplerFixture({ api: [httpRow(iso(1), { status: 'bad', service: 'api' })] }),
        iso(1),
      ),
    ).rejects.toThrow(/API readiness degraded/);
    await expect(validateSamplerEvidence(await samplerFixture(), iso(1))).resolves.toMatchObject({
      metricSamples: 1,
    });
  });

  it('A5 — deterministic digest manifest is exact sorted unique and covers L1 L2 A4 and T1 inputs', () => {
    expect(PHASE5_IMPLEMENTATION_INPUTS).toHaveLength(47);
    expect(PHASE5_IMPLEMENTATION_INPUTS).toEqual(
      [...PHASE5_IMPLEMENTATION_INPUTS].sort((a, b) =>
        Buffer.compare(Buffer.from(a), Buffer.from(b)),
      ),
    );
    expect(new Set(PHASE5_IMPLEMENTATION_INPUTS).size).toBe(47);
    expect(PHASE5_IMPLEMENTATION_INPUTS).toEqual(
      expect.arrayContaining([
        'load/audit.ts',
        '.github/workflows/ci.yml',
        'packages/redis/src/sale-store.ts',
        'apps/api/src/config/env.schema.ts',
      ]),
    );
  });

  it('A5 — digest includes clean and untracked static inputs and changes when any input byte changes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'phase5-digest-'));
    await writeFile(join(directory, 'a'), 'one');
    await writeFile(join(directory, 'b'), 'two');
    const first = await computeImplementationDigest(directory, ['a', 'b']);
    await writeFile(join(directory, 'b'), 'three');
    expect(await computeImplementationDigest(directory, ['a', 'b'])).not.toBe(first);
  });

  it('A5 — missing unreadable symlink-escaping or non-file digest input fails before Compose', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'phase5-digest-bad-'));
    await mkdir(join(directory, 'dir'));
    await writeFile(join(directory, 'a'), 'x');
    await symlink('/tmp', join(directory, 'link'));
    await expect(computeImplementationDigest(directory, ['missing'])).rejects.toThrow();
    await expect(computeImplementationDigest(directory, ['dir'])).rejects.toThrow(/regular file/);
    await expect(computeImplementationDigest(directory, ['link'])).rejects.toThrow(/regular file/);
    await expect(computeImplementationDigest(directory, ['../escape'])).rejects.toThrow(/Unsafe/);
    await expect(
      computeImplementationDigest(directory, ['a'], {
        lstat,
        realpath,
        readFile: async () => {
          throw new Error('EACCES');
        },
      }),
    ).rejects.toThrow('EACCES');
  });

  it('A5 — simultaneous workload audit sampler and observability children retain independent roles', () => {
    const registry = createChildRegistry();
    const children = ['workload', 'audit', 'sampler', 'observability'].map((role) => {
      const child = new FakeChild();
      registry.register(child, role, Promise.resolve());
      return child;
    });
    expect(registry.roles()).toEqual(['workload', 'audit', 'sampler', 'observability']);
    registry.remove(children[1]);
    expect(registry.roles()).toEqual(['workload', 'sampler', 'observability']);
  });

  it('A5 — child completion removes only itself and spawn error settles once', async () => {
    const registry = createChildRegistry();
    const first = new FakeChild();
    const second = new FakeChild();
    const spawn = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second);
    const one = command('x', [], { role: 'workload', registry, spawn });
    const two = command('x', [], { role: 'audit', registry, spawn });
    first.exitCode = 0;
    first.emit('close', 0, null);
    await one;
    expect(registry.roles()).toEqual(['audit']);
    second.emit('error', new Error('spawn'));
    second.emit('close', 1, null);
    await expect(two).rejects.toThrow('spawn');
    expect(registry.roles()).toEqual([]);
  });

  it('A5 — SIGTERM aborts waits and signals every live non-cleanup child then force-kills survivors', async () => {
    const registry = createChildRegistry();
    const children = ['workload', 'audit', 'sampler'].map(() => new FakeChild());
    for (const child of children) {
      child.kill = (signal: string) => {
        child.kills.push(signal);
        if (signal === 'SIGKILL') {
          child.exitCode = 137;
          child.emit('close');
        }
        return true;
      };
    }
    const settlements = children.map(
      (child) => new Promise<void>((resolve) => child.once('close', resolve)),
    );
    children.forEach((child, index) =>
      registry.register(child, ['workload', 'audit', 'sampler'][index], settlements[index]),
    );
    await registry.terminateNonCleanup({
      forceDelayMs: 0,
      delay: (callback: () => void) => callback(),
    });
    children.forEach((child) => expect(child.kills).toEqual(['SIGTERM', 'SIGKILL']));
  });

  it('A5 — interruption allows exactly one bounded validated cleanup and no other new child', async () => {
    const registry = createChildRegistry();
    const cleanup = new FakeChild();
    registry.claimSpawn('cleanup');
    registry.register(cleanup, 'cleanup', Promise.resolve());
    await registry.terminateNonCleanup({ forceDelayMs: 0 });
    expect(cleanup.kills).toEqual([]);
    expect(registry.roles()).toEqual(['cleanup']);
    await expect(command('x', [], { role: 'invalid', spawn: () => cleanup })).rejects.toThrow(
      /Invalid child role/,
    );
  });

  it('A5 — sampler stop aborts its tick awaits settlement closes streams and leaves no child', async () => {
    const streams: PassThrough[] = [];
    const response = (body: object) => ({ status: 200, json: async () => body });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response({ status: 'ok', service: 'api' }))
      .mockResolvedValueOnce(
        response({
          status: 'ok',
          service: 'worker',
          checks: { bootstrapReconciled: true, consumerReady: true, reconciliationHealthy: true },
        }),
      )
      .mockResolvedValueOnce(
        response({
          saleId: 'x',
          metrics: {},
          serverTime: iso(1),
          serverTimeMs: Date.parse(iso(1)),
        }),
      );
    const stats = ['redis', 'postgres', 'api', 'worker', 'k6']
      .map((service) =>
        JSON.stringify({
          Name: `p-${service}-1`,
          CPUPerc: '1%',
          MemUsage: '1 / 2',
          NetIO: '0 / 0',
          BlockIO: '0 / 0',
        }),
      )
      .join('\n');
    const stop = startSamplers({ apiUrl: 'a', workerUrl: 'w', project: 'p', env: {} }, '/tmp', {
      createWriteStream: () => {
        const stream = new PassThrough();
        stream.resume();
        streams.push(stream);
        return stream;
      },
      fetch: fetchMock,
      execute: async () => ({ code: 0, signal: null, timedOut: false, stdout: stats, stderr: '' }),
      setInterval: (callback: () => void) => {
        callback();
        return 1;
      },
      clearInterval: vi.fn(),
    });
    await expect(stop()).resolves.toBe(0);
    expect(streams.every((stream) => stream.writableEnded)).toBe(true);
  });

  it('A5 — sampler command failure records nonzero status and aborts workload promptly', async () => {
    expect(() =>
      validateCommandResult('sampler', {
        code: 7,
        signal: null,
        timedOut: false,
        stdout: '',
        stderr: '',
      }),
    ).toThrow(/status=7/);
    expect(signalExitCode({ code: null, signal: 'SIGTERM' })).toBeGreaterThan(128);
    const failed = vi.fn();
    const response = (body: object) => ({ status: 200, json: async () => body });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response({ status: 'ok', service: 'api' }))
      .mockResolvedValueOnce(
        response({
          status: 'ok',
          service: 'worker',
          checks: {
            bootstrapReconciled: true,
            consumerReady: true,
            reconciliationHealthy: true,
          },
        }),
      )
      .mockResolvedValueOnce(response({ saleId: 'x' }));
    const stop = startSamplers(
      { apiUrl: 'a', workerUrl: 'w', project: 'p', env: {}, onFailure: failed },
      '/tmp',
      {
        createWriteStream: () => {
          const stream = new PassThrough();
          stream.resume();
          return stream;
        },
        fetch: fetchMock,
        execute: async () => ({
          code: 9,
          signal: null,
          timedOut: false,
          stdout: '',
          stderr: 'failed',
        }),
        setInterval: (callback: () => void) => {
          callback();
          return 1;
        },
        clearInterval: vi.fn(),
      },
    );
    await vi.waitFor(() => expect(failed).toHaveBeenCalledOnce());
    await expect(stop()).resolves.toBe(1);
  });

  it('A5 — nonzero timeout signal empty or malformed mandatory observability output fails closed', () => {
    expect(() =>
      validateCommandResult('x', { code: 1, signal: null, timedOut: false, stdout: '' }),
    ).toThrow();
    expect(() =>
      validateCommandResult('x', { code: 0, signal: null, timedOut: true, stdout: 'x' }),
    ).toThrow();
    expect(() =>
      validateCommandResult('x', { code: 0, signal: null, timedOut: false, stdout: '' }),
    ).toThrow();
    expect(() => validateRedisInfo('Memory', '# Wrong\na:1')).toThrow();
    expect(() => validatePostgresStats('{}')).toThrow();
    expect(() => normalizeDockerStats('{}', iso(1), 'p')).toThrow();
    expect(() => validateComposeLogEvidence('api', 'not timestamped')).toThrow();
    expect(() => validateContainerInspection(['id'], '{}')).toThrow();
  });

  it('A5 — valid empty slowlog and latency results produce explicit nonempty evidence', () => {
    expect(
      validateCommandResult(
        'slowlog',
        { code: 0, signal: null, timedOut: false, stdout: '' },
        { allowEmpty: true },
      ),
    ).toBe('');
    expect(formatRedisSlowlogEvidence('0', '', '')).toContain('(no slowlog entries)');
    expect(formatRedisSlowlogEvidence('0', '', '')).toContain('(no latency events)');
  });

  it('A5 — command status preserves real stage codes null skipped stages and final cleanup code', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'phase5-status-'));
    const path = join(directory, 'status.json');
    await updateCommandStatus(path, { k6: 143 });
    const partial = JSON.parse(await readFile(path, 'utf8'));
    expect(partial.k6).toBe(143);
    expect(partial.audit).toBeNull();
    await updateCommandStatus(path, { cleanup: 0 });
    expect(JSON.parse(await readFile(path, 'utf8')).cleanup).toBe(0);
  });

  it('A5 — required evidence inventory rejects missing empty symlink or structurally invalid files', async () => {
    await expect(
      validateEvidenceInventory(await mkdtemp(join(tmpdir(), 'phase5-empty-'))),
    ).rejects.toThrow();
    const empty = await inventoryFixture();
    await writeFile(join(empty, 'api.log'), '');
    await expect(validateEvidenceInventory(empty)).rejects.toThrow(/api.log/);
    const linked = await inventoryFixture();
    await writeFile(join(linked, 'target'), 'x');
    await unlink(join(linked, 'worker.log'));
    await symlink(join(linked, 'target'), join(linked, 'worker.log'));
    await expect(validateEvidenceInventory(linked)).rejects.toThrow(/worker.log/);
    const malformed = await inventoryFixture();
    await writeFile(join(malformed, 'runtime.json'), '[]\n');
    await expect(validateEvidenceInventory(malformed)).rejects.toThrow(/runtime.json/);
    expect(Object.keys(COMMAND_STATUS_TEMPLATE)).toHaveLength(12);
  });

  it('A9 — settled drain does not memoize across workload then audit termination epochs', async () => {
    const registry = createChildRegistry();
    const workload = new FakeChild();
    workload.kill = (signal: string) => {
      workload.kills.push(signal);
      workload.exitCode = 143;
      queueMicrotask(() => workload.emit('close', null, 'SIGTERM'));
      return true;
    };
    const workloadCommand = command('workload', [], {
      role: 'workload',
      registry,
      spawn: () => workload,
    });
    await registry.terminateNonCleanup();
    await workloadCommand;
    expect(registry.epoch()).toBe(1);
    expect(registry.state()).toBe('open');

    const audit = new FakeChild();
    audit.kill = (signal: string) => {
      audit.kills.push(signal);
      audit.exitCode = 143;
      queueMicrotask(() => audit.emit('close', null, 'SIGTERM'));
      return true;
    };
    const auditCommand = command('audit', [], { role: 'audit', registry, spawn: () => audit });
    await registry.terminateNonCleanup();
    await auditCommand;
    expect(registry.epoch()).toBe(2);
    expect(audit.kills).toEqual(['SIGTERM']);
  });

  it('A9 — concurrent nonterminal termination calls coalesce and signal epoch targets once', async () => {
    const registry = createChildRegistry();
    const child = new FakeChild();
    const childCommand = command('workload', [], {
      role: 'workload',
      registry,
      spawn: () => child,
    });
    const first = registry.terminateNonCleanup();
    const second = registry.terminateNonCleanup();
    expect(second).toBe(first);
    expect(child.kills).toEqual(['SIGTERM']);
    child.exitCode = 143;
    child.emit('close', null, 'SIGTERM');
    await Promise.all([first, childCommand]);
    expect(registry.epoch()).toBe(1);
  });

  it('A9 — non-cleanup spawn is refused during drain before spawn executes', async () => {
    const registry = createChildRegistry();
    const child = new FakeChild();
    const childCommand = command('workload', [], {
      role: 'workload',
      registry,
      spawn: () => child,
    });
    const drain = registry.terminateNonCleanup();
    const spawnAttempt = vi.fn(() => new FakeChild());
    await expect(
      command('audit', [], { role: 'audit', registry, spawn: spawnAttempt }),
    ).rejects.toThrow('Child registry is draining; non-cleanup spawn refused');
    expect(spawnAttempt).not.toHaveBeenCalled();
    child.exitCode = 143;
    child.emit('close', null, 'SIGTERM');
    await Promise.all([drain, childCommand]);
  });

  it('A9 — completed nonterminal drain reopens registry for a deliberate diagnostic epoch', async () => {
    const registry = createChildRegistry();
    await registry.terminateNonCleanup({ forceDelayMs: 0 });
    expect(registry.state()).toBe('open');
    const diagnostic = new FakeChild();
    const diagnosticCommand = command('audit', [], {
      role: 'audit',
      registry,
      spawn: () => diagnostic,
    });
    diagnostic.exitCode = 0;
    diagnostic.emit('close', 0, null);
    await expect(diagnosticCommand).resolves.toMatchObject({ code: 0 });
  });

  it('A9 — terminal request permanently refuses future non-cleanup spawn but permits one cleanup', async () => {
    const registry = createChildRegistry();
    await registry.terminateNonCleanup({ terminal: true, forceDelayMs: 0 });
    expect(registry.state()).toBe('terminal');
    const spawnAttempt = vi.fn(() => new FakeChild());
    await expect(
      command('audit', [], { role: 'audit', registry, spawn: spawnAttempt }),
    ).rejects.toThrow('Child registry is terminal; non-cleanup spawn refused');
    expect(spawnAttempt).not.toHaveBeenCalled();
    const cleanup = new FakeChild();
    const cleanupCommand = command('cleanup', [], {
      role: 'cleanup',
      registry,
      spawn: () => cleanup,
    });
    cleanup.exitCode = 0;
    cleanup.emit('close', 0, null);
    await expect(cleanupCommand).resolves.toMatchObject({ code: 0 });
    await expect(
      command('cleanup', [], { role: 'cleanup', registry, spawn: spawnAttempt }),
    ).rejects.toThrow('Cleanup child already claimed');
  });

  it('A9 — terminal request upgrades an active nonterminal drain and second signal force-kills survivors', async () => {
    const registry = createChildRegistry();
    const child = new FakeChild();
    child.kill = (signal: string) => {
      child.kills.push(signal);
      if (signal === 'SIGKILL') {
        child.exitCode = 137;
        child.emit('close', null, 'SIGKILL');
      }
      return true;
    };
    const childCommand = command('workload', [], {
      role: 'workload',
      registry,
      spawn: () => child,
    });
    const first = registry.terminateNonCleanup({ terminal: false });
    const upgraded = registry.terminateNonCleanup({ terminal: true });
    const expedited = registry.terminateNonCleanup({ terminal: true, forceDelayMs: 0 });
    expect(upgraded).toBe(first);
    expect(expedited).toBe(first);
    expect(registry.state()).toBe('terminal');
    expect(child.kills).toEqual(['SIGTERM', 'SIGKILL']);
    await Promise.all([first, childCommand]);
  });

  it('A9 — sampler failure drain settles before audit observability or later scenario spawn', async () => {
    const registry = createChildRegistry();
    const workload = new FakeChild();
    const workloadCommand = command('workload', [], {
      role: 'workload',
      registry,
      spawn: () => workload,
    });
    const samplerDrainPromise = registry.terminateNonCleanup({ terminal: false });
    const diagnosticSpawn = vi.fn(() => new FakeChild());
    await expect(
      command('audit', [], { role: 'audit', registry, spawn: diagnosticSpawn }),
    ).rejects.toThrow(/draining/);
    workload.exitCode = 143;
    workload.emit('close', null, 'SIGTERM');
    await Promise.all([samplerDrainPromise, workloadCommand]);
    const audit = new FakeChild();
    const auditCommand = command('audit', [], { role: 'audit', registry, spawn: () => audit });
    audit.exitCode = 0;
    audit.emit('close', 0, null);
    await auditCommand;
  });

  it('A9 — later SIGTERM snapshots and terminates post-sampler audit and observability children', async () => {
    const registry = createChildRegistry();
    await registry.terminateNonCleanup({ terminal: false, forceDelayMs: 0 });
    const children = ['audit', 'observability'].map(() => new FakeChild());
    const promises = children.map((child, index) =>
      command('diagnostic', [], {
        role: ['audit', 'observability'][index],
        registry,
        spawn: () => child,
      }),
    );
    for (const child of children) {
      child.kill = (signal: string) => {
        child.kills.push(signal);
        child.exitCode = 143;
        queueMicrotask(() => child.emit('close', null, 'SIGTERM'));
        return true;
      };
    }
    await registry.terminateNonCleanup({ terminal: true });
    await Promise.all(promises);
    expect(children.map((child) => child.kills)).toEqual([['SIGTERM'], ['SIGTERM']]);
    expect(registry.epoch()).toBe(2);
  });

  it('A9 — repeated failures and signals still claim exactly one cleanup child', async () => {
    const registry = createChildRegistry();
    await registry.terminateNonCleanup({ terminal: true, forceDelayMs: 0 });
    await registry.terminateNonCleanup({ terminal: true, forceDelayMs: 0 });
    const spawnCleanup = vi.fn(() => new FakeChild());
    const cleanupPromise = command('cleanup', [], {
      role: 'cleanup',
      registry,
      spawn: spawnCleanup,
    });
    const cleanup = spawnCleanup.mock.results[0]!.value;
    cleanup.exitCode = 0;
    cleanup.emit('close', 0, null);
    await cleanupPromise;
    await expect(
      command('cleanup', [], { role: 'cleanup', registry, spawn: spawnCleanup }),
    ).rejects.toThrow('Cleanup child already claimed');
    expect(spawnCleanup).toHaveBeenCalledOnce();

    const failedRegistry = createChildRegistry();
    const throwingSpawn = vi.fn(() => {
      throw new Error('cleanup spawn failed');
    });
    await expect(
      command('cleanup', [], { role: 'cleanup', registry: failedRegistry, spawn: throwingSpawn }),
    ).rejects.toThrow('cleanup spawn failed');
    await expect(
      command('cleanup', [], {
        role: 'cleanup',
        registry: failedRegistry,
        spawn: () => new FakeChild(),
      }),
    ).rejects.toThrow('Cleanup child already claimed');
  });

  it('A9 — drain waits for all snapshotted settlements and leaves no registry child or timer leak', async () => {
    const registry = createChildRegistry();
    const children: [FakeChild, FakeChild] = [new FakeChild(), new FakeChild()];
    const commands = children.map((child) =>
      command('child', [], { role: 'control', registry, spawn: () => child }),
    );
    const drain = registry.terminateNonCleanup({ forceDelayMs: 5000 });
    let settled = false;
    void drain.then(() => {
      settled = true;
    });
    children[0].exitCode = 143;
    children[0].emit('close', null, 'SIGTERM');
    await Promise.resolve();
    expect(settled).toBe(false);
    children[1].exitCode = 143;
    children[1].emit('close', null, 'SIGTERM');
    await Promise.all([...commands, drain]);
    expect(registry.roles()).toEqual([]);
    expect(registry.state()).toBe('open');
  });

  it('A9 — real child processes terminate across nonterminal and terminal epochs', async () => {
    const registry = createChildRegistry();
    const realChildren: ChildProcess[] = [];
    const spawnReal = (commandName: string, args: readonly string[], options: object) => {
      const child = nodeSpawn(commandName, args, options);
      realChildren.push(child);
      return child;
    };
    try {
      const workloadStartedAt = Date.now();
      const workloadCommand = command(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        role: 'workload',
        registry,
        spawn: spawnReal,
      });
      const workloadPid = realChildren.at(-1)?.pid;
      await registry.terminateNonCleanup({ terminal: false });
      await workloadCommand;
      expect(workloadPid).toBeTypeOf('number');
      expect(registry.state()).toBe('open');

      const auditStartedAt = Date.now();
      const auditCommand = command(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        role: 'audit',
        registry,
        spawn: spawnReal,
      });
      const auditPid = realChildren.at(-1)?.pid;
      expect(auditPid).not.toBe(workloadPid);
      expect(auditStartedAt).toBeGreaterThanOrEqual(workloadStartedAt);
      await registry.terminateNonCleanup({ terminal: true });
      await auditCommand;

      const refusedSpawn = vi.fn(spawnReal);
      await expect(
        command(process.execPath, ['-e', ''], {
          role: 'control',
          registry,
          spawn: refusedSpawn,
        }),
      ).rejects.toThrow(/terminal/);
      expect(refusedSpawn).not.toHaveBeenCalled();

      const cleanupCommand = command(process.execPath, ['-e', ''], {
        role: 'cleanup',
        registry,
        spawn: spawnReal,
      });
      await expect(cleanupCommand).resolves.toMatchObject({ code: 0 });
      await expect(
        command(process.execPath, ['-e', ''], {
          role: 'cleanup',
          registry,
          spawn: spawnReal,
        }),
      ).rejects.toThrow('Cleanup child already claimed');
      expect(registry.roles()).toEqual([]);
    } finally {
      for (const child of realChildren) {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGTERM');
          await new Promise((resolvePromise) => {
            const timer = setTimeout(() => {
              child.kill('SIGKILL');
              resolvePromise(undefined);
            }, 250);
            child.once('close', () => {
              clearTimeout(timer);
              resolvePromise(undefined);
            });
          });
        }
      }
    }
  }, 10_000);

  it('A10 — core-only startup stats followed by complete k6 interval are accepted', async () => {
    await expect(validateSamplerEvidence(await samplerFixture(), iso(1))).resolves.toMatchObject({
      statsPreWorkloadSamples: 1,
      statsActiveSamples: 2,
      statsPostWorkloadSamples: 1,
    });
  });

  it('A10 — no k6 observations or fewer than two active observations fail closed', async () => {
    const noK6 = statsCsv([
      { timestamp: iso(2), services: core },
      { timestamp: iso(3), services: core },
    ]);
    const oneK6 = statsCsv([
      { timestamp: iso(2), services: core },
      { timestamp: iso(3), services: complete },
      { timestamp: iso(5), services: core },
    ]);
    await expect(
      validateSamplerEvidence(await samplerFixture({ stats: noK6 }), iso(1)),
    ).rejects.toThrow(/two k6/);
    await expect(
      validateSamplerEvidence(await samplerFixture({ stats: oneK6 }), iso(1)),
    ).rejects.toThrow(/two k6/);
  });

  it('A10 — any timestamp missing a core service fails in every lifecycle phase', async () => {
    for (const missingIndex of [0, 1, 3]) {
      const groups = [
        { timestamp: iso(2), services: core },
        { timestamp: iso(3), services: complete },
        { timestamp: iso(4), services: complete },
        { timestamp: iso(6), services: core },
      ];
      const selected = groups[missingIndex]!;
      groups[missingIndex] = {
        ...selected,
        services: selected.services.filter((service) => service !== 'redis'),
      };
      await expect(
        validateSamplerEvidence(await samplerFixture({ stats: statsCsv(groups) }), iso(1)),
      ).rejects.toThrow(/core service/);
    }
  });

  it('A10 — missing k6 between first and last k6 timestamps fails the active interval', async () => {
    const stats = statsCsv([
      { timestamp: iso(2), services: core },
      { timestamp: iso(3), services: complete },
      { timestamp: iso(4), services: core },
      { timestamp: iso(5), services: complete },
    ]);
    await expect(
      validateSamplerEvidence(
        await samplerFixture({
          stats,
          runtime: { workloadSettledAt: iso(6), samplerStoppedAt: iso(7) },
        }),
        iso(1),
      ),
    ).rejects.toThrow(/active interval/);
  });

  it('A10 — late discovery sparse completion gap and stale final k6 observation fail', async () => {
    const lifecycle = { workloadSettledAt: iso(15_000), samplerStoppedAt: iso(16_000) };
    const late = statsCsv([
      { timestamp: iso(2), services: core },
      { timestamp: iso(K6_DISCOVERY_GRACE_MS + 1), services: complete },
      { timestamp: iso(K6_DISCOVERY_GRACE_MS + 2), services: complete },
    ]);
    const sparse = statsCsv([
      { timestamp: iso(2), services: complete },
      { timestamp: iso(STATS_MAX_COMPLETION_GAP_MS + 3), services: complete },
    ]);
    const stale = statsCsv([
      { timestamp: iso(2), services: complete },
      { timestamp: iso(3), services: complete },
    ]);
    for (const stats of [late, sparse, stale])
      await expect(
        validateSamplerEvidence(await samplerFixture({ stats, runtime: lifecycle }), iso(1)),
      ).rejects.toThrow();
  });

  it('A10 — k6 observation outside workload lifecycle fails', async () => {
    const after = statsCsv([
      { timestamp: iso(3), services: complete },
      { timestamp: iso(6), services: complete },
    ]);
    await expect(
      validateSamplerEvidence(await samplerFixture({ stats: after }), iso(1)),
    ).rejects.toThrow(/lifecycle/);
  });

  it('A10 — duplicate unknown or wrong-project stats rows fail', async () => {
    const duplicate = statsCsv([
      { timestamp: iso(2), services: [...complete, 'redis'] },
      { timestamp: iso(3), services: complete },
    ]);
    const unknown = statsCsv([
      { timestamp: iso(2), services: [...complete, 'unknown'] },
      { timestamp: iso(3), services: complete },
    ]);
    const wrongProject = statsCsv([
      { timestamp: iso(2), services: complete, project: 'other-project' },
      { timestamp: iso(3), services: complete },
    ]);
    for (const stats of [duplicate, unknown, wrongProject])
      await expect(
        validateSamplerEvidence(await samplerFixture({ stats }), iso(1)),
      ).rejects.toThrow();
  });

  it('A10 — sampler evidence reports exact pre active post counts and bounded gaps', async () => {
    const report = await validateSamplerEvidence(await samplerFixture(), iso(1));
    expect(report).toMatchObject({
      statsSamples: 4,
      statsPreWorkloadSamples: 1,
      statsActiveSamples: 2,
      statsPostWorkloadSamples: 1,
      firstK6ObservedAt: iso(3),
      lastK6ObservedAt: iso(4),
      maxStatsCompletionGapMs: 2,
    });
    expect(report.maxStatsCompletionGapMs).toBeLessThanOrEqual(STATS_MAX_COMPLETION_GAP_MS);
  });

  it('A10 — successful empty API and worker log commands produce canonical nonempty metadata evidence', () => {
    for (const service of ['api', 'worker']) {
      const artifact = formatComposeLogEvidence(
        service,
        { code: 0, signal: null, timedOut: false, stdout: '', stderr: '' },
        iso(0),
      );
      expect(artifact).toContain('# phase5-compose-log-evidence-v1\n');
      expect(artifact).toContain('# sourceLineCount=0\n# sourceEmpty=true\n');
      expect(artifact).toContain('# no application log lines emitted\n');
      expect(validateComposeLogEvidence(service, artifact)).toEqual({
        sourceText: '',
        sourceLineCount: 0,
      });
    }
  });

  it('A10 — timestamped source logs are preserved and fatal scan receives source lines only', () => {
    const source = `api-1 | 2027-01-15T08:00:00.123456789Z ready\n2027-01-15T08:00:01Z uncaught exception\n`;
    const artifact = formatComposeLogEvidence(
      'api',
      { code: 0, signal: null, timedOut: false, stdout: source, stderr: '' },
      iso(0),
    );
    const parsed = validateComposeLogEvidence('api', artifact);
    expect(parsed).toEqual({ sourceText: source, sourceLineCount: 2 });
    expect(/uncaught exception/i.test(parsed.sourceText)).toBe(true);
    expect(parsed.sourceText).not.toContain('phase5-compose-log-evidence-v1');
  });

  it('A10 — failed signaled or timed-out log command cannot produce successful empty evidence', () => {
    for (const result of [
      { code: 2, signal: null, timedOut: false, stdout: '', stderr: '' },
      { code: null, signal: 'SIGTERM', timedOut: false, stdout: '', stderr: '' },
      { code: 0, signal: null, timedOut: true, stdout: '', stderr: '' },
      { code: 0, signal: null, timedOut: false, stdout: '', stderr: 'warning' },
    ])
      expect(() => formatComposeLogEvidence('api', result, iso(0))).toThrow();
  });

  it('A10 — contradictory count marker header timestamp or source line fails log evidence validation', () => {
    const valid = formatComposeLogEvidence(
      'api',
      { code: 0, signal: null, timedOut: false, stdout: '', stderr: '' },
      iso(0),
    );
    for (const artifact of [
      valid.replace('sourceLineCount=0', 'sourceLineCount=1'),
      valid.replace('sourceEmpty=true', 'sourceEmpty=false'),
      valid.replace('# no application log lines emitted', '# extra=value'),
      valid.replace('# capturedAt=', '# capturedAt=invalid-'),
      valid.replace('# service=api', '# service=worker'),
      valid.replace('# commandExit=0', '# commandExit=1'),
      `${valid}2027-01-15T08:00:00Z extra\n`,
      valid.slice(0, -1),
      valid
        .replace('sourceLineCount=0', 'sourceLineCount=1')
        .replace('sourceEmpty=true', 'sourceEmpty=false')
        .replace('# no application log lines emitted', 'not timestamped'),
    ])
      expect(() => validateComposeLogEvidence('api', artifact)).toThrow();
  });

  it('A10 — evidence inventory accepts canonical empty-log artifacts but rejects missing or zero-byte logs', async () => {
    await expect(validateEvidenceInventory(await inventoryFixture())).resolves.toBeDefined();
    const missing = await inventoryFixture();
    await unlink(join(missing, 'api.log'));
    await expect(validateEvidenceInventory(missing)).rejects.toThrow(/api.log/);
    const empty = await inventoryFixture();
    await writeFile(join(empty, 'worker.log'), '');
    await expect(validateEvidenceInventory(empty)).rejects.toThrow(/worker.log/);
  });
});
