import { createHash, randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import {
  access,
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  statfs,
  writeFile,
} from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '..');
const composeFile = resolve(root, 'load/docker-compose.yml');
const rawRoot = resolve(root, 'load/results/raw');
const RUN_ID_PATTERN = /^[a-z0-9][a-z0-9-]{7,31}$/;
const allowedStressEnv = new Set([
  'STRESS_RUN_ID',
  'STRESS_REPETITIONS',
  'STRESS_API_PORT',
  'STRESS_WORKER_PORT',
  'STRESS_POSTGRES_PORT',
  'STRESS_REDIS_PORT',
  'STRESS_CONVERGENCE_TIMEOUT_MS',
]);
const MEASURED_STRESS_SCENARIOS = ['smoke', 'surge', 'duplicate-storm', 'sold-out', 'window-edge'];
export const PHASE5_IMPLEMENTATION_INPUTS = Object.freeze([
  '.env.example',
  '.github/workflows/ci.yml',
  '.gitignore',
  'apps/api/src/config/env.schema.ts',
  'apps/api/src/config/env.spec.ts',
  'apps/api/src/infra/postgres.providers.ts',
  'apps/api/src/infra/redis.providers.ts',
  'apps/api/src/queue/orders-queue.service.spec.ts',
  'apps/api/src/queue/orders-queue.service.ts',
  'apps/worker/src/config/env.schema.ts',
  'apps/worker/src/config/env.spec.ts',
  'apps/worker/src/infra/postgres.provider.ts',
  'apps/worker/src/infra/redis.providers.ts',
  'apps/worker/src/orders/orders.consumer.spec.ts',
  'apps/worker/src/orders/orders.consumer.ts',
  'apps/worker/src/reconciliation/reconciliation.service.spec.ts',
  'apps/worker/src/reconciliation/reconciliation.service.ts',
  'apps/worker/test/integration/failure-modes.integration.spec.ts',
  'infra/docker-compose.yml',
  'load/README.md',
  'load/audit.spec.ts',
  'load/audit.ts',
  'load/contracts.ts',
  'load/docker-compose.yml',
  'load/eslint.config.mjs',
  'load/k6/common.js',
  'load/k6/duplicate-storm.js',
  'load/k6/smoke.js',
  'load/k6/sold-out.js',
  'load/k6/surge.js',
  'load/k6/warmup.js',
  'load/k6/window-edge.js',
  'load/package.json',
  'load/stress.spec.ts',
  'load/tsconfig.json',
  'package.json',
  'packages/redis/src/index.ts',
  'packages/redis/src/sale-store.reconcile.spec.ts',
  'packages/redis/src/sale-store.ts',
  'packages/redis/src/scripts/inspect-reservation-membership.lua.ts',
  'packages/redis/src/scripts/registry.spec.ts',
  'packages/redis/src/scripts/registry.ts',
  'packages/redis/src/types.ts',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'scripts/stress.mjs',
  'turbo.json',
]);
export const CONTAINER_STATS_HEADER =
  'timestamp,service,container,cpuPercent,memoryUsage,memoryLimit,networkIo,blockIo';
export const CORE_STATS_SERVICES = Object.freeze(['redis', 'postgres', 'api', 'worker']);
export const WORKLOAD_STATS_SERVICE = 'k6';
export const STATS_MAX_COMPLETION_GAP_MS = 3500;
export const K6_DISCOVERY_GRACE_MS = 10000;
export const COMMAND_STATUS_TEMPLATE = Object.freeze({
  permissionProbe: null,
  k6: null,
  audit: null,
  sampler: null,
  observabilityBefore: null,
  observabilityAfter: null,
  containerPs: null,
  containerInspect: null,
  apiLogs: null,
  workerLogs: null,
  readinessEvidence: null,
  cleanup: null,
});
const CHILD_ROLES = Object.freeze([
  'control',
  'workload',
  'audit',
  'sampler',
  'observability',
  'cleanup',
]);
const profiles = {
  smoke: [
    {
      scenario: 'smoke',
      token: 'smoke',
      repetition: 1,
      stock: 200,
      startOffset: -60_000,
      duration: 30 * 60_000,
    },
  ],
};

function fullDefinitions(repetitions) {
  return [
    {
      scenario: 'warmup',
      token: 'warm',
      repetition: 1,
      stock: 200,
      startOffset: -60_000,
      duration: 30 * 60_000,
    },
    ...['surge', 'duplicate-storm', 'sold-out', 'window-edge'].flatMap((scenario) =>
      Array.from({ length: repetitions }, (_, index) => ({
        scenario,
        token: {
          surge: 'surge',
          'duplicate-storm': 'dup',
          'sold-out': 'sold',
          'window-edge': 'edge',
        }[scenario],
        repetition: index + 1,
        stock: { surge: 500, 'duplicate-storm': 5000, 'sold-out': 10, 'window-edge': 1000 }[
          scenario
        ],
        startOffset: scenario === 'window-edge' ? 60_000 : -60_000,
        duration: scenario === 'window-edge' ? 10_000 : 30 * 60_000,
      })),
    ),
  ];
}
let interrupted = false;
const runnerAbortController = new AbortController();

export function signalExitCode(result) {
  if (Number.isInteger(result?.code)) return result.code;
  const signals = os.constants.signals;
  return result?.signal && signals[result.signal] ? 128 + signals[result.signal] : 1;
}

export function createChildRegistry() {
  const children = new Map();
  const settlements = new Map();
  let mode = 'open';
  let epoch = 0;
  let activeTermination = null;
  let activeTargets = Object.freeze([]);
  let activeKilled = new Set();
  let terminalRequested = false;
  let cleanupClaimed = false;

  const validateRole = (role) => {
    if (!CHILD_ROLES.includes(role)) throw new Error(`Invalid child role: ${role}`);
  };

  const assertNonCleanupOpen = () => {
    if (mode === 'draining')
      throw new Error('Child registry is draining; non-cleanup spawn refused');
    if (mode === 'terminal')
      throw new Error('Child registry is terminal; non-cleanup spawn refused');
  };

  const killActiveSurvivors = () => {
    for (const target of activeTargets) {
      if (target.child.exitCode === null && !activeKilled.has(target.child)) {
        activeKilled.add(target.child);
        target.child.kill('SIGKILL');
      }
    }
  };

  return {
    children,
    claimSpawn(role) {
      validateRole(role);
      if (role === 'cleanup') {
        if (cleanupClaimed) throw new Error('Cleanup child already claimed');
        cleanupClaimed = true;
        return;
      }
      assertNonCleanupOpen();
    },
    register(child, role, settlement) {
      validateRole(role);
      if (children.has(child)) throw new Error('Child identity already registered');
      if (role === 'cleanup') {
        if (!cleanupClaimed) throw new Error('Cleanup child must be claimed before registration');
        if ([...children.values()].includes('cleanup'))
          throw new Error('Cleanup child already registered');
      } else {
        assertNonCleanupOpen();
      }
      children.set(child, role);
      settlements.set(child, settlement);
    },
    remove(child) {
      children.delete(child);
      settlements.delete(child);
    },
    roles() {
      return [...children.values()];
    },
    state() {
      return mode;
    },
    epoch() {
      return epoch;
    },
    terminateNonCleanup({ terminal = false, forceDelayMs = 2000, delay = setTimeout } = {}) {
      if (typeof terminal !== 'boolean') throw new Error('terminal must be a Boolean');
      if (!Number.isInteger(forceDelayMs) || forceDelayMs < 0 || forceDelayMs > 10_000)
        throw new Error('forceDelayMs must be an integer from 0 to 10000');

      if (terminal) {
        terminalRequested = true;
        mode = 'terminal';
      }
      if (activeTermination) {
        if (forceDelayMs === 0) killActiveSurvivors();
        return activeTermination;
      }

      if (!terminalRequested) mode = 'draining';
      epoch += 1;
      const targets = [...children]
        .filter(([, role]) => role !== 'cleanup')
        .map(([child]) => Object.freeze({ child, settlement: settlements.get(child) }));
      activeTargets = Object.freeze(targets);
      activeKilled = new Set();
      let resolveTermination;
      let rejectTermination;
      const epochTermination = new Promise((resolvePromise, rejectPromise) => {
        resolveTermination = resolvePromise;
        rejectTermination = rejectPromise;
      });
      activeTermination = epochTermination;
      for (const target of targets) {
        if (target.child.exitCode === null) target.child.kill('SIGTERM');
      }
      void (async () => {
        let forceTimer;
        try {
          const settlementsDone = Promise.allSettled(targets.map((target) => target.settlement));
          let forceExpired = false;
          const forceElapsed = new Promise((resolveForce) => {
            forceTimer = delay(() => {
              forceExpired = true;
              resolveForce();
            }, forceDelayMs);
          });
          await Promise.race([settlementsDone, forceElapsed]);
          if (forceExpired) killActiveSurvivors();
          else if (forceTimer !== undefined) clearTimeout(forceTimer);
          await settlementsDone;
        } finally {
          if (activeTermination === epochTermination) {
            activeTermination = null;
            activeTargets = Object.freeze([]);
            activeKilled = new Set();
            mode = terminalRequested ? 'terminal' : 'open';
          }
        }
      })().then(resolveTermination, rejectTermination);
      return epochTermination;
    },
  };
}

const childRegistry = createChildRegistry();

export function derivePosixIdentity(
  getuid = process.getuid,
  getgid = process.getgid,
  inherited = process.env,
) {
  if (typeof getuid !== 'function' || typeof getgid !== 'function') {
    throw new Error('Phase 5 load runner requires a non-root POSIX UID/GID');
  }
  const uid = getuid();
  const gid = getgid();
  for (const [name, value] of [
    ['UID', uid],
    ['GID', gid],
  ]) {
    if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) {
      throw new Error(`Phase 5 load runner requires a non-root POSIX UID/GID (${name})`);
    }
  }
  return {
    uid,
    gid,
    env: {
      ...inherited,
      PHASE5_K6_UID: String(uid),
      PHASE5_K6_GID: String(gid),
    },
  };
}

function usage() {
  return `Usage: node scripts/stress.mjs --profile <full|smoke>\n\nProfiles:\n  full   one audited warmup plus 3 repetitions of four measured scenarios\n  smoke  one audited 30-second, 200 purchase/s smoke scenario\n`;
}

function parseArgs(argv) {
  if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) return { help: true };
  if (argv.length !== 2 || argv[0] !== '--profile' || !['full', 'smoke'].includes(argv[1]))
    throw new Error(usage().trim());
  return { help: false, profile: argv[1] };
}

function integerEnv(name, fallback, min, max) {
  const value = Number(process.env[name] || fallback);
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw new Error(`${name} must be an integer from ${min} to ${max}`);
  return value;
}

function runId() {
  const generated = `${new Date()
    .toISOString()
    .replace(/[-:T.Z]/g, '')
    .slice(0, 14)}-${randomBytes(4).toString('hex')}`;
  const value = process.env.STRESS_RUN_ID || generated;
  if (!RUN_ID_PATTERN.test(value))
    throw new Error('STRESS_RUN_ID must match ^[a-z0-9][a-z0-9-]{7,31}$');
  return value;
}

export async function command(commandName, args, options = {}) {
  if (interrupted && options.role !== 'cleanup')
    throw new Error('Interrupted; child spawn refused');
  const spawnChild = options.spawn ?? spawn;
  const registry = options.registry ?? childRegistry;
  return await new Promise((resolvePromise, reject) => {
    registry.claimSpawn(options.role);
    const child = spawnChild(commandName, args, {
      cwd: root,
      env: options.env ?? process.env,
      stdio: options.inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'],
    });
    let settled = false;
    let settleRegistry;
    const registrySettlement = new Promise((resolveSettlement) => {
      settleRegistry = resolveSettlement;
    });
    registry.register(child, options.role, registrySettlement);
    let timedOut = false;
    let forceTimer;
    const timer = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          if (child.exitCode === null) child.kill('SIGTERM');
          forceTimer = setTimeout(() => {
            if (child.exitCode === null) child.kill('SIGKILL');
          }, 2000);
        }, options.timeoutMs)
      : undefined;
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => {
      stdout += chunk;
      if (options.live) process.stdout.write(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk;
      if (options.live) process.stderr.write(chunk);
    });
    const settle = (kind, code, signal, error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (forceTimer) clearTimeout(forceTimer);
      registry.remove(child);
      settleRegistry();
      if (kind === 'error') reject(error);
      else resolvePromise({ code, signal, stdout, stderr, timedOut });
    };
    child.once('error', (error) => settle('error', null, null, error));
    child.once('close', (code, signal) => settle('close', code, signal, null));
  });
}

export async function runPackageAudit(args, execute = command) {
  return await execute('pnpm', ['--filter', '@flash/load', 'run', 'audit', ...args], {
    live: true,
    role: 'audit',
  });
}

function composeArgs(project, ...args) {
  return ['compose', '-p', project, '-f', composeFile, ...args];
}

async function writeJsonAtomically(path, value) {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

export async function runPermissionProbe({
  project,
  env,
  scenario,
  repetition,
  scenarioDir,
  uid,
  gid,
  execute = command,
}) {
  const scenarios = ['warmup', ...MEASURED_STRESS_SCENARIOS];
  if (!scenarios.includes(scenario) || !Number.isSafeInteger(repetition) || repetition < 1) {
    throw new Error('Invalid permission probe scenario/repetition');
  }
  const probeRelative = `/results/${scenario}/r${repetition}/.phase5-write-probe`;
  const probeHostPath = resolve(scenarioDir, '.phase5-write-probe');
  let result;
  try {
    result = await execute(
      'docker',
      composeArgs(
        project,
        '--profile',
        'k6',
        'run',
        '--rm',
        '--no-deps',
        '--entrypoint',
        '/bin/sh',
        '-e',
        `PHASE5_PROBE_PATH=${probeRelative}`,
        'k6',
        '-eu',
        '-c',
        'umask 077; : > "$PHASE5_PROBE_PATH"; test -f "$PHASE5_PROBE_PATH"; rm "$PHASE5_PROBE_PATH"',
      ),
      { env, timeoutMs: 30_000, role: 'control' },
    );
  } catch (error) {
    result = { code: 1, timedOut: false, stdout: '', stderr: String(error), signal: null };
  }
  let probeCreatedAndRemoved = false;
  try {
    await access(probeHostPath);
  } catch {
    probeCreatedAndRemoved = result.code === 0 && result.timedOut !== true;
  }
  const report = {
    uid,
    gid,
    containerExitCode: result.code,
    probeCreatedAndRemoved,
    ...(result.code === 0 && !result.timedOut
      ? {}
      : {
          timedOut: result.timedOut === true,
          stdout: redact(result.stdout),
          stderr: redact(result.stderr),
        }),
  };
  await writeJsonAtomically(resolve(scenarioDir, 'permission-probe.json'), report);
  if (!probeCreatedAndRemoved) {
    await updateCommandStatus(resolve(scenarioDir, 'command-status.json'), {
      permissionProbe: signalExitCode(result),
    });
    throw new Error(
      `permission-preflight failed: exit=${result.code} timedOut=${result.timedOut === true} probeRemoved=${probeCreatedAndRemoved}`,
    );
  }
  return report;
}

async function requireSuccess(label, commandName, args, options = {}) {
  const result = await command(commandName, args, { role: 'control', ...options });
  if (result.code !== 0 || result.signal || result.timedOut)
    throw new Error(
      `${label} failed (${signalExitCode(result)}): ${redact(result.stderr || result.stdout)}`,
    );
  return result.stdout.trim();
}

function redact(value) {
  return String(value)
    .replace(/([a-z]+:\/\/[^:/\s]+:)[^@\s]+@/gi, '$1[REDACTED]@')
    .replace(/(POSTGRES_PASSWORD:\s*)\S+/g, '$1[REDACTED]');
}

async function assertPortFree(port) {
  await new Promise((resolvePromise, reject) => {
    const server = net.createServer();
    server.once('error', () =>
      reject(new Error(`Load port ${port} is occupied; refusing to disturb its owner`)),
    );
    server.listen({ host: '127.0.0.1', port }, () => server.close(resolvePromise));
  });
}

async function preflight(config) {
  for (const name of Object.keys(process.env))
    if (name.startsWith('STRESS_') && !allowedStressEnv.has(name))
      throw new Error(`Unrecognized ${name}`);
  if (new Set(Object.values(config.ports)).size !== 4)
    throw new Error('STRESS_*_PORT values must be distinct');
  await Promise.all(Object.values(config.ports).map(assertPortFree));
  await requireSuccess('Docker availability', 'docker', ['info']);
  await requireSuccess('Docker Compose availability', 'docker', ['compose', 'version']);
  const disk = await statfs(rawRoot).catch(async () => {
    await mkdir(rawRoot, { recursive: true });
    return statfs(rawRoot);
  });
  if (disk.bavail * disk.bsize < 2 * 1024 ** 3)
    throw new Error('At least 2 GiB free disk is required for Phase 5 raw evidence');
}

async function waitJson(url, predicate, deadlineMs = 60_000) {
  const started = Date.now();
  let last = 'no response';
  while (Date.now() - started < deadlineMs && !interrupted) {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.any([runnerAbortController.signal, AbortSignal.timeout(1500)]),
      });
      const body = await response.json();
      last = `${response.status} ${JSON.stringify(body)}`;
      if (response.ok && predicate(body)) return body;
    } catch (error) {
      last = String(error);
    }
    await abortableDelay(250);
  }
  throw new Error(`Readiness deadline for ${url}; last=${redact(last)}`);
}

function abortableDelay(milliseconds, signal = runnerAbortController.signal) {
  return new Promise((resolvePromise, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolvePromise();
    }, milliseconds);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseIso(value, label) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(value))
    throw new Error(`${label}: invalid ISO timestamp`);
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value)
    throw new Error(`${label}: invalid ISO timestamp`);
  return milliseconds;
}

function requireNonnegativeIntegers(object, keys, label) {
  for (const key of keys) {
    if (
      object[key] !== undefined &&
      (!Number.isFinite(object[key]) || !Number.isInteger(object[key]) || object[key] < 0)
    )
      throw new Error(`${label}: ${key} must be a nonnegative integer`);
  }
}

async function parseJsonLines(path, samplerStartedAt, label) {
  const content = await readFile(path, 'utf8');
  if (!content || !content.endsWith('\n')) throw new Error(`${label}: empty or truncated JSONL`);
  let previous = -Infinity;
  return content
    .slice(0, -1)
    .split('\n')
    .map((line, index) => {
      if (!line.trim()) throw new Error(`${label}: blank JSONL row ${index + 1}`);
      let row;
      try {
        row = JSON.parse(line);
      } catch {
        throw new Error(`${label}: malformed JSON row ${index + 1}`);
      }
      if (!isObject(row)) throw new Error(`${label}: row ${index + 1} is not an object`);
      const timestamp = parseIso(row.timestamp, label);
      if (timestamp < samplerStartedAt || timestamp <= previous)
        throw new Error(`${label}: pre-start, duplicate, or nonmonotonic timestamp`);
      previous = timestamp;
      if (!Number.isInteger(row.status) || row.status < 0)
        throw new Error(`${label}: invalid status`);
      if (!Number.isInteger(row.latencyMs) || row.latencyMs < 0)
        throw new Error(`${label}: invalid latency`);
      if (row.status === 0) {
        if (typeof row.error !== 'string' || !row.error || 'body' in row)
          throw new Error(`${label}: malformed transport failure`);
      } else if (!isObject(row.body) || 'error' in row) {
        throw new Error(`${label}: malformed HTTP sample`);
      }
      return row;
    });
}

function parseCsvLine(line) {
  const fields = [];
  let value = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        value += '"';
        index += 1;
      } else quoted = !quoted;
    } else if (character === ',' && !quoted) {
      fields.push(value);
      value = '';
    } else value += character;
  }
  if (quoted) throw new Error('container stats: malformed quoted CSV');
  fields.push(value);
  return fields;
}

export async function validateSamplerEvidence(scenarioDir, samplerStartedAt) {
  const started =
    typeof samplerStartedAt === 'number' ? samplerStartedAt : parseIso(samplerStartedAt, 'sampler');
  const runtime = JSON.parse(await readFile(resolve(scenarioDir, 'runtime.json'), 'utf8'));
  const workloadStarted = parseIso(runtime.workloadStartedAt, 'workload started');
  const runtimeSamplerStarted = parseIso(runtime.samplerStartedAt, 'sampler started');
  const workloadSettled = parseIso(runtime.workloadSettledAt, 'workload settled');
  const samplerStopped = parseIso(runtime.samplerStoppedAt, 'sampler stopped');
  if (
    started !== runtimeSamplerStarted ||
    workloadStarted > runtimeSamplerStarted ||
    runtimeSamplerStarted >= samplerStopped ||
    workloadStarted >= workloadSettled ||
    workloadSettled > samplerStopped
  )
    throw new Error('sampler: invalid workload/sampler lifecycle ordering');
  if (typeof runtime.project !== 'string' || !runtime.project)
    throw new Error('container stats: missing exact Compose project');
  const api = await parseJsonLines(
    resolve(scenarioDir, 'api-readiness.jsonl'),
    started,
    'API readiness',
  );
  const worker = await parseJsonLines(
    resolve(scenarioDir, 'worker-readiness.jsonl'),
    started,
    'worker readiness',
  );
  const metrics = await parseJsonLines(
    resolve(scenarioDir, 'sale-metrics.jsonl'),
    started,
    'sale metrics',
  );
  for (const row of api) {
    if (row.status !== 200 || row.body.status !== 'ok' || row.body.service !== 'api')
      throw new Error(`API readiness degraded at ${row.timestamp} status=${row.status}`);
    requireNonnegativeIntegers(
      row.body,
      ['waiting', 'active', 'delayed', 'failed'],
      'API readiness',
    );
    if (isObject(row.body.queue))
      requireNonnegativeIntegers(
        row.body.queue,
        ['waiting', 'active', 'delayed', 'failed'],
        'API readiness queue',
      );
    if (isObject(row.body.checks?.queue))
      requireNonnegativeIntegers(
        row.body.checks.queue,
        ['waiting', 'active', 'delayed', 'failed'],
        'API readiness queue',
      );
  }
  for (const row of worker) {
    const checks = row.body?.checks;
    if (
      row.status !== 200 ||
      row.body.status !== 'ok' ||
      row.body.service !== 'worker' ||
      !isObject(checks) ||
      checks.bootstrapReconciled !== true ||
      checks.consumerReady !== true ||
      checks.reconciliationHealthy !== true
    )
      throw new Error(`Worker readiness degraded at ${row.timestamp} status=${row.status}`);
    requireNonnegativeIntegers(row.body, ['activeJobs', 'failedJobs'], 'worker readiness');
    requireNonnegativeIntegers(checks, ['activeJobs', 'failedJobs'], 'worker readiness');
  }
  for (const row of metrics) {
    if (
      row.status !== 200 ||
      !isObject(row.body) ||
      row.body.saleId !== runtime.saleId ||
      !isObject(row.body.metrics) ||
      Object.values(row.body.metrics).some(
        (value) => !Number.isFinite(value) || !Number.isInteger(value) || value < 0,
      ) ||
      !Number.isInteger(row.body.serverTimeMs) ||
      parseIso(row.body.serverTime, 'sale metrics') !== row.body.serverTimeMs
    )
      throw new Error(
        `Sale metrics unavailable or sale mismatch at ${row.timestamp} status=${row.status}`,
      );
  }
  const statsContent = await readFile(resolve(scenarioDir, 'container-stats.csv'), 'utf8');
  if (!statsContent || !statsContent.endsWith('\n'))
    throw new Error('container stats: empty or truncated CSV');
  const lines = statsContent.slice(0, -1).split('\n');
  if (lines.shift() !== CONTAINER_STATS_HEADER) throw new Error('container stats: invalid header');
  const groups = [];
  let currentGroup;
  let previousTimestamp = -Infinity;
  for (const line of lines) {
    const fields = parseCsvLine(line);
    if (fields.length !== 8 || fields.some((field) => !field.trim()))
      throw new Error('container stats: malformed data row');
    const timestamp = parseIso(fields[0], 'container stats');
    if (!currentGroup || currentGroup.timestampText !== fields[0]) {
      if (timestamp <= previousTimestamp)
        throw new Error('container stats: duplicate or nonmonotonic timestamp group');
      if (timestamp < runtimeSamplerStarted || timestamp > samplerStopped)
        throw new Error('container stats: timestamp outside sampler lifecycle');
      previousTimestamp = timestamp;
      currentGroup = { timestampText: fields[0], timestamp, services: new Set() };
      groups.push(currentGroup);
    }
    const service = fields[1];
    if (![...CORE_STATS_SERVICES, WORKLOAD_STATS_SERVICE].includes(service))
      throw new Error(`container stats: unknown service ${service}`);
    if (currentGroup.services.has(service))
      throw new Error('container stats: duplicate service row');
    if (
      !fields[2].startsWith(`${runtime.project}-${service}-`) &&
      !fields[2].startsWith(`${runtime.project}_${service}_`)
    )
      throw new Error('container stats: container outside exact Compose project');
    currentGroup.services.add(service);
  }
  if (groups.length === 0) throw new Error('container stats: missing sample groups');
  for (const group of groups)
    if (CORE_STATS_SERVICES.some((service) => !group.services.has(service)))
      throw new Error('container stats: missing required core service evidence');
  const k6Groups = groups.filter((group) => group.services.has(WORKLOAD_STATS_SERVICE));
  if (k6Groups.length < 2) throw new Error('container stats: fewer than two k6 observations');
  const firstK6 = k6Groups[0];
  const lastK6 = k6Groups.at(-1);
  if (
    firstK6.timestamp < workloadStarted ||
    lastK6.timestamp > workloadSettled ||
    firstK6.timestamp > Math.min(workloadSettled, workloadStarted + K6_DISCOVERY_GRACE_MS)
  )
    throw new Error('container stats: k6 discovery outside workload lifecycle');
  const firstK6Index = groups.indexOf(firstK6);
  const lastK6Index = groups.indexOf(lastK6);
  for (let index = firstK6Index; index <= lastK6Index; index += 1)
    if (!groups[index].services.has(WORKLOAD_STATS_SERVICE))
      throw new Error('container stats: missing k6 in active interval');
  for (let index = lastK6Index + 1; index < groups.length; index += 1)
    if (groups[index].timestamp < workloadSettled)
      throw new Error('container stats: pre-settlement sample missing k6');
  const completionGaps = [groups[0].timestamp - runtimeSamplerStarted];
  for (let index = 1; index < groups.length; index += 1)
    completionGaps.push(groups[index].timestamp - groups[index - 1].timestamp);
  completionGaps.push(workloadSettled - lastK6.timestamp);
  if (completionGaps.some((gap) => gap < 0 || gap > STATS_MAX_COMPLETION_GAP_MS))
    throw new Error('container stats: sparse or stale completion evidence');
  const maxStatsCompletionGapMs = Math.max(...completionGaps);
  return {
    apiSamples: api.length,
    workerSamples: worker.length,
    metricSamples: metrics.length,
    statsSamples: groups.length,
    statsPreWorkloadSamples: firstK6Index,
    statsActiveSamples: lastK6Index - firstK6Index + 1,
    statsPostWorkloadSamples: groups.length - lastK6Index - 1,
    firstK6ObservedAt: firstK6.timestampText,
    lastK6ObservedAt: lastK6.timestampText,
    maxStatsCompletionGapMs,
    workerDegradedSamples: 0,
  };
}

export function validateCommandResult(label, result, { allowEmpty = false } = {}) {
  if (signalExitCode(result) !== 0 || result.timedOut === true || result.signal)
    throw new Error(
      `${label} failed status=${signalExitCode(result)} timeout=${result.timedOut === true}`,
    );
  if (!allowEmpty && !String(result.stdout).trim())
    throw new Error(`${label} produced empty output`);
  return String(result.stdout).trim();
}

export function validateRedisInfo(section, output) {
  if (!String(output).includes(`# ${section}`))
    throw new Error(`Redis INFO ${section} missing section marker`);
  const rows = String(output)
    .split(/\r?\n/)
    .filter((line) => line && !line.startsWith('#'));
  if (!rows.some((line) => /^[^:]+:.+$/.test(line)))
    throw new Error(`Redis INFO ${section} has no key/value rows`);
}

export function validatePostgresStats(output) {
  let value;
  try {
    value = JSON.parse(String(output).trim());
  } catch {
    throw new Error('Postgres stats malformed JSON');
  }
  if (!isObject(value)) throw new Error('Postgres stats must be one JSON object');
  for (const field of [
    'total_connections',
    'active_connections',
    'commits',
    'rollbacks',
    'inserted',
    'deadlocks',
    'temp_files',
    'temp_bytes',
  ])
    if (typeof value[field] !== 'number' || !Number.isFinite(value[field]) || value[field] < 0)
      throw new Error(`Postgres stats invalid ${field}`);
  return value;
}

const COMPOSE_LOG_EVIDENCE_VERSION = '# phase5-compose-log-evidence-v1';
const COMPOSE_LOG_SERVICES = new Set(['api', 'worker']);
const COMPOSE_SOURCE_TIMESTAMP =
  /^(?:[^|\r\n]+ \| )?(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z)(?:\s|$)/;

function assertComposeLogService(service) {
  if (!COMPOSE_LOG_SERVICES.has(service))
    throw new Error(`Invalid Compose log service: ${service}`);
}

export function formatComposeLogEvidence(service, result, capturedAt) {
  assertComposeLogService(service);
  parseIso(capturedAt, 'Compose logs capturedAt');
  if (signalExitCode(result) !== 0 || result.timedOut === true || result.signal)
    throw new Error(
      `${service} logs failed status=${signalExitCode(result)} timeout=${result.timedOut === true}`,
    );
  if (String(result.stderr ?? '') !== '') throw new Error(`${service} logs produced stderr`);
  const source = redact(String(result.stdout ?? ''));
  if (source && !source.endsWith('\n'))
    throw new Error(`${service} logs source is not newline terminated`);
  const sourceLines = source ? source.slice(0, -1).split('\n') : [];
  const header = `${COMPOSE_LOG_EVIDENCE_VERSION}\n# capturedAt=${capturedAt}\n# service=${service}\n# commandExit=0\n# sourceLineCount=${sourceLines.length}\n# sourceEmpty=${sourceLines.length === 0}\n`;
  const artifact = sourceLines.length
    ? `${header}${source}`
    : `${header}# no application log lines emitted\n`;
  validateComposeLogEvidence(service, artifact);
  return artifact;
}

export function validateComposeLogEvidence(service, artifactText) {
  assertComposeLogService(service);
  const text = String(artifactText);
  if (!text || !text.endsWith('\n')) throw new Error(`${service} log evidence is truncated`);
  const lines = text.slice(0, -1).split('\n');
  if (lines.length < 7 || lines[0] !== COMPOSE_LOG_EVIDENCE_VERSION)
    throw new Error(`${service} log evidence has invalid version/header`);
  const capturedMatch = /^# capturedAt=(.+)$/.exec(lines[1]);
  const serviceMatch = /^# service=(api|worker)$/.exec(lines[2]);
  const exitMatch = /^# commandExit=(0)$/.exec(lines[3]);
  const countMatch = /^# sourceLineCount=(0|[1-9]\d*)$/.exec(lines[4]);
  const emptyMatch = /^# sourceEmpty=(true|false)$/.exec(lines[5]);
  if (!capturedMatch || !serviceMatch || !exitMatch || !countMatch || !emptyMatch)
    throw new Error(`${service} log evidence has malformed metadata`);
  parseIso(capturedMatch[1], 'Compose logs capturedAt');
  if (serviceMatch[1] !== service) throw new Error(`${service} log evidence service mismatch`);
  const sourceLineCount = Number(countMatch[1]);
  const sourceEmpty = emptyMatch[1] === 'true';
  const payload = lines.slice(6);
  if (sourceLineCount === 0) {
    if (!sourceEmpty || payload.length !== 1 || payload[0] !== '# no application log lines emitted')
      throw new Error(`${service} log evidence has contradictory empty marker`);
    return { sourceText: '', sourceLineCount: 0 };
  }
  if (sourceEmpty || payload.length !== sourceLineCount)
    throw new Error(`${service} log evidence source count mismatch`);
  for (const line of payload) {
    const match = COMPOSE_SOURCE_TIMESTAMP.exec(line);
    if (!match || !Number.isFinite(Date.parse(match[1])))
      throw new Error(`${service} log evidence contains untimestamped source`);
  }
  return { sourceText: `${payload.join('\n')}\n`, sourceLineCount };
}

export function validateContainerInspection(ids, output) {
  let inspection;
  try {
    inspection = JSON.parse(String(output));
  } catch {
    throw new Error('Docker inspect malformed JSON');
  }
  if (!Array.isArray(inspection) || inspection.length === 0)
    throw new Error('Docker inspect must be a nonempty array');
  const expected = new Set(ids);
  const actual = new Set(inspection.map((container) => container.Id));
  if (
    expected.size !== ids.length ||
    actual.size !== inspection.length ||
    expected.size !== actual.size ||
    [...expected].some((id) => !actual.has(id))
  )
    throw new Error('Docker inspect identities do not match Compose ps');
  const services = inspection.map(
    (container) => container.Config?.Labels?.['com.docker.compose.service'],
  );
  for (const service of ['redis', 'postgres', 'api', 'worker'])
    if (services.filter((value) => value === service).length !== 1)
      throw new Error(`Docker inspect missing or duplicated ${service}`);
  if (
    inspection.some(
      (container) =>
        container.State?.OOMKilled === true ||
        Number(container.RestartCount ?? 0) > 0 ||
        container.State?.Status !== 'running',
    )
  )
    throw new Error('Docker inspect reports invalid state, OOM, or restart');
  return inspection;
}

export function formatRedisSlowlogEvidence(lengthText, slowlogText, latencyText) {
  if (!/^\d+$/.test(String(lengthText).trim()))
    throw new Error('Redis SLOWLOG LEN is not a nonnegative integer');
  const length = Number(String(lengthText).trim());
  if (length > 0 && !String(slowlogText).trim())
    throw new Error('Redis SLOWLOG GET missing entries');
  return `SLOWLOG LEN\n${length}\nSLOWLOG GET 128\n${String(slowlogText).trim() || '(no slowlog entries)'}\nLATENCY LATEST\n${String(latencyText).trim() || '(no latency events)'}\n`;
}

export async function updateCommandStatus(path, updates) {
  let current = { ...COMMAND_STATUS_TEMPLATE };
  try {
    current = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const next = { ...COMMAND_STATUS_TEMPLATE, ...current, ...updates };
  if (Object.keys(next).join('|') !== Object.keys(COMMAND_STATUS_TEMPLATE).join('|'))
    throw new Error('command status contains unknown or out-of-order fields');
  await writeJsonAtomically(path, next);
  return next;
}

export async function validateEvidenceInventory(scenarioDir, { cleanupRequired = false } = {}) {
  const jsonFiles = [
    'k6-summary.json',
    'audit.json',
    'runtime.json',
    'container-inspect.json',
    'postgres-before.json',
    'postgres-after.json',
    'command-status.json',
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
    'api.log',
    'worker.log',
  ];
  for (const name of [...jsonFiles, ...textFiles]) {
    const path = resolve(scenarioDir, name);
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile() || info.size === 0)
      throw new Error(`Required evidence invalid: ${name}`);
    if (jsonFiles.includes(name)) {
      const parsed = JSON.parse(await readFile(path, 'utf8'));
      if (!isObject(parsed) && name !== 'container-inspect.json')
        throw new Error(`Required evidence malformed: ${name}`);
      if (name === 'container-inspect.json' && (!Array.isArray(parsed) || parsed.length === 0))
        throw new Error('Required evidence malformed: container-inspect.json');
    } else if (name === 'api.log' || name === 'worker.log') {
      validateComposeLogEvidence(
        name === 'api.log' ? 'api' : 'worker',
        await readFile(path, 'utf8'),
      );
    }
  }
  const status = JSON.parse(await readFile(resolve(scenarioDir, 'command-status.json'), 'utf8'));
  if (Object.keys(status).join('|') !== Object.keys(COMMAND_STATUS_TEMPLATE).join('|'))
    throw new Error('command status schema mismatch');
  for (const [field, value] of Object.entries(status)) {
    if (field === 'cleanup' && !cleanupRequired && value === null) continue;
    if (!Number.isInteger(value) || value !== 0)
      throw new Error(`command status failed or missing: ${field}`);
  }
  return status;
}

async function capture(project, env, scenarioDir, phase) {
  const compose = (...args) =>
    command('docker', composeArgs(project, ...args), {
      env,
      role: 'observability',
      timeoutMs: 30_000,
    });
  const outputs = await Promise.all([
    compose('exec', '-T', 'redis', 'redis-cli', 'INFO', 'memory'),
    compose('exec', '-T', 'redis', 'redis-cli', 'INFO', 'stats'),
    compose('exec', '-T', 'redis', 'redis-cli', 'INFO', 'clients'),
    compose('exec', '-T', 'redis', 'redis-cli', 'INFO', 'persistence'),
    compose('exec', '-T', 'redis', 'redis-cli', 'INFO', 'cpu'),
    compose(
      'exec',
      '-T',
      'postgres',
      'psql',
      '-U',
      'flash',
      '-d',
      'flash',
      '-At',
      '-c',
      "SELECT json_build_object('total_connections',(SELECT count(*) FROM pg_stat_activity WHERE datname=current_database()),'active_connections',(SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND state='active'),'commits',xact_commit,'rollbacks',xact_rollback,'inserted',tup_inserted,'deadlocks',deadlocks,'temp_files',temp_files,'temp_bytes',temp_bytes) FROM pg_stat_database WHERE datname=current_database()",
    ),
  ]);
  const sections = ['Memory', 'Stats', 'Clients', 'Persistence', 'CPU'];
  outputs.slice(0, 5).forEach((result, index) => {
    const output = validateCommandResult(`Redis INFO ${sections[index]}`, result);
    validateRedisInfo(sections[index], output);
  });
  const postgresText = validateCommandResult('Postgres stats', outputs[5]);
  validatePostgresStats(postgresText);
  await writeFile(
    resolve(scenarioDir, `redis-info-${phase}.txt`),
    outputs
      .slice(0, 5)
      .map((item) => item.stdout)
      .join('\n'),
  );
  await writeFile(resolve(scenarioDir, `postgres-${phase}.json`), `${postgresText}\n`);
  if (phase === 'after') {
    const slow = await compose('exec', '-T', 'redis', 'redis-cli', 'SLOWLOG', 'GET', '128');
    const slowLength = await compose('exec', '-T', 'redis', 'redis-cli', 'SLOWLOG', 'LEN');
    const latency = await compose('exec', '-T', 'redis', 'redis-cli', 'LATENCY', 'LATEST');
    const slowLengthText = validateCommandResult('Redis SLOWLOG LEN', slowLength);
    validateCommandResult('Redis SLOWLOG GET', slow, { allowEmpty: Number(slowLengthText) === 0 });
    validateCommandResult('Redis LATENCY LATEST', latency, { allowEmpty: true });
    await writeFile(
      resolve(scenarioDir, 'redis-slowlog.txt'),
      formatRedisSlowlogEvidence(slowLengthText, slow.stdout, latency.stdout),
    );
  }
}

function csv(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

export function normalizeDockerStats(output, timestamp, project) {
  if (!String(output).trim()) throw new Error('Docker stats produced empty output');
  return String(output)
    .trim()
    .split('\n')
    .map((line) => {
      let row;
      try {
        row = JSON.parse(line);
      } catch {
        throw new Error('Docker stats malformed JSON-lines');
      }
      if (!isObject(row)) throw new Error('Docker stats row is not an object');
      const container = row.Name ?? row.Container ?? row.ID;
      const service = ['redis', 'postgres', 'api', 'worker', 'k6'].find(
        (name) =>
          String(container).includes(`${project}-${name}-`) ||
          String(container).includes(`${project}_${name}_`),
      );
      const fields = [
        row.CPUPerc,
        ...String(row.MemUsage ?? '').split(' / '),
        row.NetIO,
        row.BlockIO,
      ];
      if (
        !service ||
        !container ||
        fields.length !== 5 ||
        fields.some((field) => typeof field !== 'string' || !field.trim())
      )
        throw new Error('Docker stats missing required normalized fields');
      return [timestamp, service, container, ...fields].map(csv).join(',');
    });
}

export function startSamplers(config, scenarioDir, seams = {}) {
  const createStream = seams.createWriteStream ?? createWriteStream;
  const execute = seams.execute ?? command;
  const fetchImpl = seams.fetch ?? fetch;
  const setIntervalImpl = seams.setInterval ?? setInterval;
  const clearIntervalImpl = seams.clearInterval ?? clearInterval;
  const streams = {
    api: createStream(resolve(scenarioDir, 'api-readiness.jsonl'), { flags: 'a' }),
    worker: createStream(resolve(scenarioDir, 'worker-readiness.jsonl'), { flags: 'a' }),
    metrics: createStream(resolve(scenarioDir, 'sale-metrics.jsonl'), { flags: 'a' }),
    stats: createStream(resolve(scenarioDir, 'container-stats.csv'), { flags: 'a' }),
  };
  streams.stats.write(`${CONTAINER_STATS_HEADER}\n`);
  const localAbort = new AbortController();
  let inFlight;
  let stopped = false;
  let samplerCode = null;
  let stopPromise;
  const tick = async () => {
    if (inFlight || stopped) return inFlight;
    inFlight = (async () => {
      try {
        for (const [key, url] of [
          ['api', `${config.apiUrl}/health/ready`],
          ['worker', `${config.workerUrl}/health/ready`],
          ['metrics', `${config.apiUrl}/sale/metrics`],
        ]) {
          const start = Date.now();
          try {
            const response = await fetchImpl(url, {
              signal: AbortSignal.any([
                localAbort.signal,
                runnerAbortController.signal,
                AbortSignal.timeout(800),
              ]),
            });
            const body = await response.json();
            streams[key].write(
              `${JSON.stringify({ timestamp: new Date().toISOString(), status: response.status, latencyMs: Date.now() - start, body })}\n`,
            );
          } catch (error) {
            if (stopped && localAbort.signal.aborted) return;
            streams[key].write(
              `${JSON.stringify({ timestamp: new Date().toISOString(), status: 0, latencyMs: Date.now() - start, error: String(error) })}\n`,
            );
          }
        }
        const stats = await execute(
          'docker',
          composeArgs(config.project, 'stats', '--no-stream', '--format', 'json'),
          { env: config.env, role: 'sampler', timeoutMs: 5000 },
        );
        validateCommandResult('Docker stats sampler', stats);
        const timestamp = new Date().toISOString();
        for (const row of normalizeDockerStats(stats.stdout, timestamp, config.project))
          streams.stats.write(`${row}\n`);
        samplerCode = 0;
      } catch (error) {
        samplerCode = 1;
        localAbort.abort(error);
        config.onFailure?.(error);
        throw error;
      } finally {
        inFlight = undefined;
      }
    })();
    return inFlight;
  };
  const timer = setIntervalImpl(() => {
    tick()?.catch(() => {});
  }, 1000);
  return function stopSamplers() {
    if (stopPromise) return stopPromise;
    stopped = true;
    stopPromise = (async () => {
      clearIntervalImpl(timer);
      localAbort.abort(new Error('sampler stopped'));
      if (inFlight) await inFlight.catch(() => {});
      if (childRegistry.roles().includes('sampler'))
        throw new Error('sampler child remained registered');
      await Promise.all(
        Object.values(streams).map(
          (stream) =>
            new Promise((resolvePromise, reject) => {
              stream.once('error', reject);
              stream.once('finish', resolvePromise);
              stream.end();
            }),
        ),
      );
      return samplerCode ?? 1;
    })();
    return stopPromise;
  };
}

async function runScenario(config, definition) {
  if (interrupted) throw new Error('Interrupted');
  const currentDigest = await computeImplementationDigest();
  if (currentDigest !== config.digest) throw new Error('Implementation changed after preflight');
  const hash = config.runId.slice(-8);
  const saleId = `p5-${hash}-${definition.token}-r${definition.repetition}`;
  const now = Date.now();
  const startsAtMs = now + definition.startOffset;
  const endsAtMs = startsAtMs + definition.duration;
  const scenarioDir = resolve(config.runDir, definition.scenario, `r${definition.repetition}`);
  const env = {
    ...config.identity.env,
    STRESS_RUN_ID: config.runId,
    STRESS_PROFILE: config.profile,
    STRESS_API_PORT: String(config.ports.api),
    STRESS_WORKER_PORT: String(config.ports.worker),
    STRESS_POSTGRES_PORT: String(config.ports.postgres),
    STRESS_REDIS_PORT: String(config.ports.redis),
    SALE_ID: saleId,
    SALE_NAME: `Phase 5 ${definition.scenario} ${config.runId} r${definition.repetition}`,
    SALE_STARTS_AT: new Date(startsAtMs).toISOString(),
    SALE_ENDS_AT: new Date(endsAtMs).toISOString(),
    SALE_TOTAL_STOCK: String(definition.stock),
    K6_SCENARIO: definition.scenario,
    SCENARIO_TOKEN: definition.token,
    REPETITION: String(definition.repetition),
    STARTS_AT_MS: String(startsAtMs),
    ENDS_AT_MS: String(endsAtMs),
    RAW_RESULT_DIR: config.runDir,
  };
  const runtime = {
    startedAt: new Date().toISOString(),
    baseCommit: config.baseCommit,
    implementationDigest: config.digest,
    implementationInputs: PHASE5_IMPLEMENTATION_INPUTS,
    dirtyPaths: config.dirtyPaths,
    node: process.version,
    pnpm: config.pnpmVersion,
    docker: config.dockerVersion,
    compose: config.composeVersion,
    k6: config.k6Version,
    os: `${os.platform()} ${os.release()}`,
    logicalCpus: os.cpus().length,
    memoryBytes: os.totalmem(),
    posixIdentity: { uid: config.identity.uid, gid: config.identity.gid },
    profile: config.profile,
    project: config.project,
    scenario: definition,
    saleId,
    resources: {
      redis: '1 CPU/256MiB',
      postgres: '2 CPU/768MiB',
      api: '4 CPU/768MiB',
      worker: '2 CPU/768MiB',
      k6: '4 CPU/3GiB',
    },
    limits: {
      RATE_LIMIT_MAX: 1000000,
      RATE_LIMIT_WINDOW_MS: 1000,
      RATE_LIMIT_USER_MAX: 100,
      RATE_LIMIT_USER_WINDOW_MS: 1000,
      WORKER_CONCURRENCY: 16,
      WORKER_PG_POOL_MAX: 10,
    },
  };
  const commandStatusPath = resolve(scenarioDir, 'command-status.json');
  await writeJsonAtomically(commandStatusPath, { ...COMMAND_STATUS_TEMPLATE });
  await writeJsonAtomically(resolve(scenarioDir, 'runtime.json'), runtime);
  await requireSuccess(
    'application recreation',
    'docker',
    composeArgs(config.project, 'up', '-d', '--build', '--force-recreate', 'api', 'worker'),
    { env },
  );
  await waitJson(`${config.workerUrl}/health/ready`, (body) => body.status === 'ok');
  const api = await waitJson(`${config.apiUrl}/health/ready`, (body) => body.status === 'ok');
  const status = await waitJson(
    `${config.apiUrl}/sale/status`,
    (body) =>
      body.saleId === saleId &&
      body.startsAtMs === startsAtMs &&
      body.endsAtMs === endsAtMs &&
      body.totalStock === definition.stock,
  );
  if (definition.scenario === 'window-edge') {
    if (startsAtMs - status.serverTimeMs < 15_000)
      throw new Error('window-edge must remain at least 15s in the future after recreation');
    while (status.serverTimeMs < startsAtMs - 5250 || status.serverTimeMs > startsAtMs - 4750) {
      const current = await waitJson(
        `${config.apiUrl}/sale/status`,
        (body) => body.saleId === saleId,
      );
      const delta = startsAtMs - current.serverTimeMs;
      if (delta < 4750) throw new Error('Missed window-edge Redis-time launch envelope');
      await abortableDelay(Math.min(250, Math.max(10, delta - 5000)));
      status.serverTimeMs = current.serverTimeMs;
    }
  }
  const rendered = await requireSuccess(
    'Compose rendering',
    'docker',
    composeArgs(config.project, 'config'),
    { env },
  );
  await writeFile(resolve(scenarioDir, 'compose-config.yml'), redact(rendered));
  await runPermissionProbe({
    project: config.project,
    env,
    scenario: definition.scenario,
    repetition: definition.repetition,
    scenarioDir,
    uid: config.identity.uid,
    gid: config.identity.gid,
  });
  await updateCommandStatus(commandStatusPath, { permissionProbe: 0 });
  try {
    await capture(config.project, env, scenarioDir, 'before');
    await updateCommandStatus(commandStatusPath, { observabilityBefore: 0 });
  } catch (error) {
    await updateCommandStatus(commandStatusPath, { observabilityBefore: 1 });
    throw error;
  }
  let samplerFailure;
  let samplerDrainPromise = null;
  const failures = [];
  runtime.workloadStartedAt = new Date().toISOString();
  const workloadPromise = command(
    'docker',
    composeArgs(config.project, '--profile', 'k6', 'run', '--rm', 'k6'),
    { env, live: true, role: 'workload' },
  ).finally(() => {
    runtime.workloadSettledAt = new Date().toISOString();
  });
  runtime.samplerStartedAt = new Date().toISOString();
  await writeJsonAtomically(resolve(scenarioDir, 'runtime.json'), runtime);
  const stopSamplers = startSamplers(
    {
      ...config,
      env,
      onFailure: (error) => {
        samplerFailure ??= error;
        samplerDrainPromise ??= childRegistry.terminateNonCleanup({ terminal: false });
      },
    },
    scenarioDir,
  );
  let k6;
  let samplerCode;
  try {
    k6 = await workloadPromise;
  } finally {
    samplerCode = await stopSamplers().catch(() => 1);
    runtime.samplerStoppedAt = new Date().toISOString();
    await updateCommandStatus(commandStatusPath, {
      k6: signalExitCode(k6),
      sampler: samplerFailure ? 1 : samplerCode,
    });
    await writeJsonAtomically(resolve(scenarioDir, 'runtime.json'), runtime);
  }
  if (samplerDrainPromise) {
    try {
      await samplerDrainPromise;
    } catch (error) {
      failures.push(`sampler drain: ${redact(error)}`);
    }
  }
  if (samplerFailure) failures.push(`sampler: ${redact(samplerFailure)}`);
  try {
    runtime.samplerEvidence = await validateSamplerEvidence(
      scenarioDir,
      Date.parse(runtime.samplerStartedAt),
    );
    await updateCommandStatus(commandStatusPath, { readinessEvidence: 0 });
  } catch (error) {
    await updateCommandStatus(commandStatusPath, { readinessEvidence: 1 });
    failures.push(`readiness evidence: ${redact(error)}`);
  }
  await writeJsonAtomically(resolve(scenarioDir, 'runtime.json'), runtime);
  const summaryPath = resolve(scenarioDir, 'k6-summary.json');
  let summary;
  try {
    await access(summaryPath);
    summary = JSON.parse(await readFile(summaryPath, 'utf8'));
  } catch (error) {
    failures.push(`k6 summary: ${redact(error)}`);
  }
  if (
    summary &&
    (summary.phase5?.scenario !== definition.scenario ||
      summary.phase5?.repetition !== definition.repetition)
  )
    failures.push('k6 summary discriminator mismatch');
  const confirmed = Number(summary?.phase5?.outcomes?.confirmed);
  let audit = { code: null, signal: null, timedOut: false, stdout: '', stderr: '' };
  if (Number.isSafeInteger(confirmed) && confirmed >= 0)
    audit = await runPackageAudit([
      '--run-id',
      config.runId,
      '--scenario',
      definition.scenario,
      '--sale-id',
      saleId,
      '--initial-stock',
      String(definition.stock),
      '--expected-confirmed',
      String(confirmed),
      '--api-url',
      config.apiUrl,
      '--worker-url',
      config.workerUrl,
      '--database-url',
      `postgresql://flash:flash@127.0.0.1:${config.ports.postgres}/flash`,
      '--redis-url',
      `redis://127.0.0.1:${config.ports.redis}`,
      '--deadline-ms',
      String(config.deadlineMs),
      '--out',
      resolve(scenarioDir, 'audit.json'),
    ]);
  await updateCommandStatus(commandStatusPath, {
    audit: audit.code === null ? null : signalExitCode(audit),
  });
  if (audit.code !== 0)
    failures.push(`audit status=${signalExitCode(audit)}: ${redact(audit.stderr || audit.stdout)}`);
  try {
    await capture(config.project, env, scenarioDir, 'after');
    await updateCommandStatus(commandStatusPath, { observabilityAfter: 0 });
  } catch (error) {
    await updateCommandStatus(commandStatusPath, { observabilityAfter: 1 });
    failures.push(`observability after: ${redact(error)}`);
  }
  const inspect = await command('docker', composeArgs(config.project, 'ps', '-q'), {
    env,
    role: 'observability',
    timeoutMs: 30_000,
  });
  let ids = [];
  try {
    validateCommandResult('Compose ps', inspect);
    ids = inspect.stdout.trim().split(/\s+/).filter(Boolean);
    await updateCommandStatus(commandStatusPath, { containerPs: 0 });
  } catch (error) {
    await updateCommandStatus(commandStatusPath, { containerPs: 1 });
    failures.push(`container ps: ${redact(error)}`);
  }
  const inspected = ids.length
    ? await command('docker', ['inspect', ...ids], { role: 'observability', timeoutMs: 30_000 })
    : { stdout: '', code: 1, signal: null, timedOut: false };
  let inspection = [];
  try {
    const inspectedText = validateCommandResult('Docker inspect', inspected);
    inspection = validateContainerInspection(ids, inspectedText);
    await writeFile(resolve(scenarioDir, 'container-inspect.json'), `${inspectedText}\n`);
    await updateCommandStatus(commandStatusPath, { containerInspect: 0 });
  } catch (error) {
    await updateCommandStatus(commandStatusPath, {
      containerInspect: ids.length === 0 ? null : 1,
    });
    failures.push(`container inspect: ${redact(error)}`);
  }
  const failedLogCommand = (error) => ({
    code: null,
    signal: null,
    timedOut: false,
    stdout: '',
    stderr: String(error),
  });
  const apiLogs = await command(
    'docker',
    composeArgs(config.project, 'logs', '--no-color', '--timestamps', 'api'),
    { env, role: 'observability', timeoutMs: 30_000 },
  ).catch(failedLogCommand);
  const workerLogs = await command(
    'docker',
    composeArgs(config.project, 'logs', '--no-color', '--timestamps', 'worker'),
    { env, role: 'observability', timeoutMs: 30_000 },
  ).catch(failedLogCommand);
  runtime.logsCapturedAt = new Date().toISOString();
  let apiLogText = '';
  let workerLogText = '';
  for (const [service, label, result, field, file] of [
    ['api', 'API logs', apiLogs, 'apiLogs', 'api.log'],
    ['worker', 'worker logs', workerLogs, 'workerLogs', 'worker.log'],
  ]) {
    try {
      const artifact = formatComposeLogEvidence(service, result, runtime.logsCapturedAt);
      await writeFile(resolve(scenarioDir, file), artifact);
      const { sourceText } = validateComposeLogEvidence(service, artifact);
      if (field === 'apiLogs') apiLogText = sourceText;
      else workerLogText = sourceText;
      await updateCommandStatus(commandStatusPath, { [field]: 0 });
    } catch (error) {
      const realStatus = signalExitCode(result);
      await updateCommandStatus(commandStatusPath, { [field]: realStatus === 0 ? 1 : realStatus });
      failures.push(
        `${label}: ${redact(error)}${result.stderr ? ` stderr=${redact(result.stderr)}` : ''}`,
      );
    }
  }
  const fatalLog = /unhandled rejection|uncaught exception|retained malformed|unresolved failed/i;
  const redisAfter = await readFile(resolve(scenarioDir, 'redis-info-after.txt'), 'utf8');
  const postgresAfter = JSON.parse(
    await readFile(resolve(scenarioDir, 'postgres-after.json'), 'utf8'),
  );
  const warnings = [
    inspection.some(
      (container) =>
        container.State?.OOMKilled === true ||
        Number(container.RestartCount ?? 0) > 0 ||
        container.State?.Status !== 'running',
    ) && 'container OOM/restart/exit',
    /rejected_connections:[1-9]/.test(redisAfter) && 'Redis rejected connections',
    /oom|out of memory/i.test(redisAfter) && 'Redis OOM',
    Number(postgresAfter.deadlocks ?? 0) > 0 && 'Postgres deadlock',
    fatalLog.test(apiLogText + workerLogText) && 'fatal application log',
  ].filter(Boolean);
  runtime.endedAt = new Date().toISOString();
  await writeJsonAtomically(resolve(scenarioDir, 'runtime.json'), runtime);
  if (signalExitCode(k6) !== 0) failures.push(`k6 status=${signalExitCode(k6)}`);
  if (warnings.length > 0)
    failures.push(`${definition.scenario} saturation warnings: ${warnings.join(', ')}`);
  if (failures.length)
    throw new AggregateError(
      failures.map((value) => new Error(value)),
      failures.join(' | '),
    );
  const auditReport = JSON.parse(await readFile(resolve(scenarioDir, 'audit.json'), 'utf8'));
  await validateEvidenceInventory(scenarioDir);
  return {
    definition,
    saleId,
    scenarioDir,
    summary,
    audit: auditReport,
    runtime,
  };
}

function bytewiseCompare(left, right) {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

export async function computeImplementationDigest(
  repositoryRoot = root,
  inputs = PHASE5_IMPLEMENTATION_INPUTS,
  fsSeams = { lstat, readFile, realpath },
) {
  const sorted = [...inputs].sort(bytewiseCompare);
  if (
    inputs.length !== new Set(inputs).size ||
    inputs.some((value, index) => value !== sorted[index])
  )
    throw new Error('Implementation input manifest must be bytewise sorted and unique');
  const canonicalRoot = await fsSeams.realpath(repositoryRoot);
  const hash = createHash('sha256');
  for (const path of inputs) {
    if (isAbsolute(path) || path.split(/[\\/]/).includes('..'))
      throw new Error(`Unsafe implementation input: ${path}`);
    const absolute = resolve(canonicalRoot, path);
    const info = await fsSeams.lstat(absolute);
    if (info.isSymbolicLink() || !info.isFile())
      throw new Error(`Implementation input is not a regular file: ${path}`);
    const canonical = await fsSeams.realpath(absolute);
    if (
      canonical !== absolute ||
      (!canonical.startsWith(`${canonicalRoot}${sep}`) && canonical !== canonicalRoot)
    )
      throw new Error(`Implementation input escapes repository: ${path}`);
    const content = await fsSeams.readFile(absolute);
    const length = Buffer.alloc(8);
    length.writeBigUInt64BE(BigInt(content.byteLength));
    hash.update(Buffer.from(path));
    hash.update(Buffer.from([0]));
    hash.update(length);
    hash.update(Buffer.from([0]));
    hash.update(content);
    hash.update(Buffer.from([0]));
  }
  return hash.digest('hex');
}

async function implementationState() {
  const dirty = (await requireSuccess('git status', 'git', ['status', '--porcelain']))
    .split('\n')
    .filter(Boolean)
    .map((line) => line.slice(3));
  return {
    dirtyPaths: dirty,
    digest: await computeImplementationDigest(),
    baseCommit: await requireSuccess('base commit', 'git', ['rev-parse', 'phase-4-done^{commit}']),
  };
}

function metric(summary, name, field) {
  return summary.metrics?.[name]?.values?.[field];
}
export function formatResultsMarkdown(config, results) {
  const warmup = results.filter((result) => result.definition.scenario === 'warmup');
  const measured = results.filter((result) =>
    MEASURED_STRESS_SCENARIOS.includes(result.definition.scenario),
  );
  if (
    config.profile === 'full' &&
    (warmup.length !== 1 || warmup[0].definition.repetition !== 1 || warmup[0].audit.pass !== true)
  )
    throw new Error('Full result aggregation requires exactly one passing warmup/r1');
  if (config.profile === 'full' && measured.length !== 12)
    throw new Error('Full result aggregation requires all 12 measured reports');
  if (
    config.profile === 'smoke' &&
    (warmup.length !== 0 ||
      measured.length !== 1 ||
      measured[0].definition.scenario !== 'smoke' ||
      measured[0].definition.repetition !== 1)
  )
    throw new Error('Smoke result aggregation requires exactly smoke/r1 and no warmup');
  const rowData = measured.map((result) => {
    const s = result.summary;
    const a = result.audit;
    const outcome = s.phase5.outcomes;
    const values = [
      result.definition.scenario,
      result.definition.repetition,
      s.phase5.target,
      metric(s, 'http_reqs', 'rate') ?? 'MISSING',
      metric(s, 'dropped_iterations', 'count') ?? 0,
      ((metric(s, 'http_req_failed', 'rate') ?? NaN) * 100).toFixed(3),
      metric(s, 'http_req_duration{name:purchase}', 'p(95)') ?? 'MISSING',
      metric(s, 'http_req_duration{name:purchase}', 'p(99)') ?? 'MISSING',
      metric(s, 'http_req_duration{name:sale_status}', 'p(95)') ?? 'MISSING',
      outcome.confirmed,
      outcome.duplicate,
      outcome.soldOut,
      outcome.notStarted + outcome.ended,
      a.postgres.persisted,
      a.postgres.compensated,
      a.redis.stock,
      ...['I1', 'I2', 'I3', 'I4'].map((key) => (a.invariants[key].pass ? 'PASS' : 'FAIL')),
    ];
    return { scenario: result.definition.scenario, values };
  });
  const aggregateRows = [];
  for (const scenario of MEASURED_STRESS_SCENARIOS) {
    const group = rowData.filter((row) => row.scenario === scenario);
    if (group.length < 2) continue;
    for (const kind of ['median', 'worst']) {
      const values = group[0].values.map((_, index) => {
        if (index === 0) return scenario;
        if (index === 1) return kind;
        const candidates = group.map((row) => Number(row.values[index]));
        if (candidates.every(Number.isFinite)) {
          const sorted = [...candidates].sort((left, right) => left - right);
          return kind === 'median' ? sorted[Math.floor(sorted.length / 2)] : Math.max(...sorted);
        }
        return group.every((row) => row.values[index] === 'PASS') ? 'PASS' : 'FAIL';
      });
      aggregateRows.push({ scenario, values });
    }
  }
  const warm = warmup[0];
  const preflight = warm
    ? `Warmup preflight: ${warm.audit.pass ? 'PASS' : 'FAIL'} | sale=${warm.saleId} | confirmed=${warm.summary.phase5.outcomes.confirmed} | audit=${relative(root, resolve(warm.scenarioDir, 'audit.json'))}`
    : 'Warmup preflight: not applicable (smoke profile)';
  const header = `# Phase 5 stress results\n\nUTC date: ${new Date().toISOString()}  \nBase commit: ${config.baseCommit}  \nImplementation digest: ${config.digest}  \nRuntime: Node ${process.version}; pnpm ${config.pnpmVersion}; Docker ${config.dockerVersion}; Compose ${config.composeVersion}; k6 1.7.1  \nHardware: ${os.cpus().length} logical CPUs; ${os.totalmem()} bytes RAM  \nResources: Redis 1 CPU/256 MiB; Postgres 2 CPU/768 MiB; API 4 CPU/768 MiB; worker 2 CPU/768 MiB; k6 4 CPU/3 GiB  \nProfile/repetitions: ${config.profile}/${config.profile === 'full' ? 3 : 1}  \nLocal Docker baseline; not a production capacity claim.  \nTuning state: none required unless baseline evidence dispatches T1.  \nCI not run: owner-authorized billing bypass.\n\n${preflight}\n\nArrival-rate targets are purchase attempts/s; duplicate storm's configured target is 50,000 total purchase attempts; observed HTTP req/s includes additive observer traffic.\n\n| Scenario | Rep | Configured target | Observed HTTP req/s | Dropped | HTTP failed % | Purchase p95 ms | Purchase p99 ms | Status p95 ms | Confirmed | Duplicate | Sold out | Window rejected | PG persisted | PG compensated | Redis stock | I1 | I2 | I3 | I4 |\n| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- | --- | --- |\n`;
  const rows = [...rowData, ...aggregateRows].map((row) => `| ${row.values.join(' | ')} |`);
  return `${header}${rows.join('\n')}\n`;
}

async function writeResults(config, results) {
  const markdown = formatResultsMarkdown(config, results);
  await writeFile(resolve(root, 'load/results/phase-5-results.md'), markdown);
  const inputs = [
    resolve(root, 'load/results/phase-5-results.md'),
    ...results.flatMap((result) =>
      ['k6-summary.json', 'audit.json', 'runtime.json'].map((name) =>
        resolve(result.scenarioDir, name),
      ),
    ),
  ].sort();
  const manifest = [];
  for (const path of inputs)
    manifest.push(
      `${createHash('sha256')
        .update(await readFile(path))
        .digest('hex')}  ${relative(root, path)}`,
    );
  await writeFile(resolve(root, 'load/results/phase-5-results.sha256'), `${manifest.join('\n')}\n`);
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.help) {
    process.stdout.write(usage());
    return;
  }
  const identity = derivePosixIdentity();
  const repetitions = parsed.profile === 'smoke' ? 1 : integerEnv('STRESS_REPETITIONS', 3, 1, 5);
  const config = {
    profile: parsed.profile,
    runId: runId(),
    repetitions,
    identity,
    ports: {
      api: integerEnv('STRESS_API_PORT', 3300, 1, 65535),
      worker: integerEnv('STRESS_WORKER_PORT', 3301, 1, 65535),
      postgres: integerEnv('STRESS_POSTGRES_PORT', 5543, 1, 65535),
      redis: integerEnv('STRESS_REDIS_PORT', 6680, 1, 65535),
    },
    deadlineMs: Math.min(
      integerEnv('STRESS_CONVERGENCE_TIMEOUT_MS', 120000, 10000, 300000),
      parsed.profile === 'smoke' ? 60000 : 300000,
    ),
  };
  config.project = `flash-load-${config.runId}`;
  config.runDir = resolve(rawRoot, config.runId);
  config.apiUrl = `http://127.0.0.1:${config.ports.api}/api`;
  config.workerUrl = `http://127.0.0.1:${config.ports.worker}`;
  const selectedDefinitions =
    config.profile === 'smoke' ? profiles.smoke : fullDefinitions(config.repetitions);
  try {
    await access(config.runDir);
    throw new Error(`Refusing to reuse existing Phase 5 run directory for ${config.runId}`);
  } catch (error) {
    if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) {
      throw error;
    }
  }
  await mkdir(config.runDir, { recursive: true, mode: 0o700 });
  await Promise.all(
    selectedDefinitions.map((definition) =>
      mkdir(resolve(config.runDir, definition.scenario, `r${definition.repetition}`), {
        recursive: true,
        mode: 0o700,
      }),
    ),
  );
  await preflight(config);
  Object.assign(config, await implementationState());
  config.pnpmVersion = await requireSuccess('pnpm version', 'pnpm', ['--version']);
  config.dockerVersion = await requireSuccess('Docker version', 'docker', [
    'version',
    '--format',
    '{{.Server.Version}}',
  ]);
  config.composeVersion = await requireSuccess('Compose version', 'docker', [
    'compose',
    'version',
    '--short',
  ]);
  config.k6Version = await requireSuccess('k6 version', 'docker', [
    'run',
    '--rm',
    'grafana/k6:1.7.1',
    'version',
  ]);
  const baseEnv = {
    ...config.identity.env,
    STRESS_RUN_ID: config.runId,
    STRESS_PROFILE: config.profile,
    STRESS_API_PORT: String(config.ports.api),
    STRESS_WORKER_PORT: String(config.ports.worker),
    STRESS_POSTGRES_PORT: String(config.ports.postgres),
    STRESS_REDIS_PORT: String(config.ports.redis),
    SALE_ID: `p5-${config.runId.slice(-8)}-warm-r1`,
    SALE_NAME: 'Phase 5 bootstrap',
    SALE_STARTS_AT: new Date(Date.now() - 60000).toISOString(),
    SALE_ENDS_AT: new Date(Date.now() + 1800000).toISOString(),
    SALE_TOTAL_STOCK: '200',
    K6_SCENARIO: 'warmup',
    SCENARIO_TOKEN: 'warm',
    REPETITION: '1',
    STARTS_AT_MS: String(Date.now() - 60000),
    ENDS_AT_MS: String(Date.now() + 1800000),
    RAW_RESULT_DIR: config.runDir,
  };
  const failures = [];
  const results = [];
  try {
    await requireSuccess(
      'datastore startup',
      'docker',
      composeArgs(config.project, 'up', '-d', 'redis', 'postgres'),
      { env: baseEnv },
    );
    for (const definition of selectedDefinitions) {
      try {
        results.push(await runScenario(config, definition));
      } catch (error) {
        failures.push(redact(error));
        if (definition.scenario === 'warmup') break;
      }
    }
    if (failures.length === 0 && (config.profile === 'smoke' || config.repetitions === 3))
      await writeResults(config, results);
  } finally {
    let cleanup;
    try {
      cleanup = await command(
        'docker',
        composeArgs(config.project, 'down', '-v', '--remove-orphans'),
        { env: baseEnv, live: true, role: 'cleanup', timeoutMs: 60_000 },
      );
    } catch (error) {
      cleanup = { code: 1, signal: null, timedOut: false, stdout: '', stderr: String(error) };
    }
    for (const definition of selectedDefinitions) {
      const statusPath = resolve(
        config.runDir,
        definition.scenario,
        `r${definition.repetition}`,
        'command-status.json',
      );
      try {
        await updateCommandStatus(statusPath, { cleanup: signalExitCode(cleanup) });
      } catch {
        // A failure before k6 has no per-scenario command status to amend.
      }
    }
    if (signalExitCode(cleanup) !== 0)
      failures.push(`cleanup failed: ${redact(cleanup.stderr || cleanup.stdout)}`);
  }
  if (interrupted) failures.push('interrupted by signal');
  if (failures.length)
    throw new AggregateError(
      failures.map((failure) => new Error(failure)),
      `Phase 5 stress failed: ${failures.join(' | ')}`,
    );
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  for (const signal of ['SIGINT', 'SIGTERM'])
    process.on(signal, () => {
      if (interrupted) {
        void childRegistry.terminateNonCleanup({ terminal: true, forceDelayMs: 0 });
        return;
      }
      interrupted = true;
      runnerAbortController.abort(new Error(`interrupted by ${signal}`));
      void childRegistry.terminateNonCleanup({ terminal: true });
    });
  main().catch((error) => {
    console.error(redact(error));
    process.exitCode = 1;
  });
}
