import { spawnSync } from 'node:child_process';
import { constants } from 'node:fs';
import {
  closeSync,
  fsyncSync,
  fstatSync,
  lstatSync,
  openSync,
  readlinkSync,
  realpathSync,
  statSync,
} from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { randomBytes as nodeRandomBytes } from 'node:crypto';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { Redis } from 'ioredis';
import pg from 'pg';

import { SALE_ID_PATTERN, saleKeys } from '@flash/shared';

import {
  MEASURED_STRESS_SCENARIOS,
  STRESS_SCENARIOS,
  type AuditReport,
  type InvariantResult,
  type StressScenario,
} from './contracts.js';

const { Pool } = pg;
const RUN_ID_PATTERN = /^[a-z0-9][a-z0-9-]{7,31}$/;
const PAGE_SIZE = 500;

export const AUDIT_RAW_RESULTS_ROOT = fileURLToPath(new URL('./results/raw/', import.meta.url));

interface SaleConfig {
  id: string;
  name: string;
  totalStock: number;
  startsAtMs: number;
  endsAtMs: number;
}

export interface AuditOrder {
  id: string;
  userId: string;
  status: 'reserved' | 'persisted' | 'compensated';
  createdAtMs: number;
}

export interface AuditEvaluationInput {
  runId: string;
  scenario: StressScenario;
  saleId: string;
  initialStock: number;
  expectedConfirmed: number;
  sale: SaleConfig;
  apiSale: SaleConfig;
  redisSale: SaleConfig;
  convergence: AuditReport['convergence'];
  postgres: AuditReport['postgres'];
  redis: AuditReport['redis'];
  orders: readonly AuditOrder[];
  buyers: ReadonlySet<string>;
  reservations: ReadonlyMap<string, { reservationId: string; reservedAtMs: number }>;
  ledgerErrors?: readonly string[];
}

function result(pass: boolean, ...evidence: string[]): InvariantResult {
  return { pass, evidence };
}

function equalSet(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return left.size === right.size && [...left].every((value) => right.has(value));
}

export function evaluateAudit(input: AuditEvaluationInput): AuditReport {
  const persisted = input.orders.filter((order) => order.status === 'persisted');
  const compensated = input.orders.filter((order) => order.status === 'compensated');
  const persistedUsers = new Set(persisted.map((order) => order.userId));
  const reservationUsers = new Set(input.reservations.keys());
  const configEqual = [input.sale, input.apiSale, input.redisSale].every(
    (sale) =>
      sale.id === input.saleId &&
      sale.name === input.sale.name &&
      sale.totalStock === input.initialStock &&
      sale.startsAtMs === input.sale.startsAtMs &&
      sale.endsAtMs === input.sale.endsAtMs,
  );
  const identitiesMatch = persisted.every((order) => {
    const reservation = input.reservations.get(order.userId);
    return (
      reservation?.reservationId === order.id && reservation.reservedAtMs === order.createdAtMs
    );
  });
  const compensatedAbsent = compensated.every(
    (order) => !input.buyers.has(order.userId) && !input.reservations.has(order.userId),
  );
  const exactCounts = scenarioCountsPass(
    input.scenario,
    input.expectedConfirmed,
    input.postgres.persisted,
  );

  const I1 = result(
    input.redis.stock >= 0 &&
      input.redis.stock <= input.initialStock &&
      input.redis.reservations <= input.initialStock &&
      input.redis.stock + input.redis.reservations === input.initialStock &&
      input.postgres.persisted === input.redis.reservations &&
      exactCounts,
    `stock=${input.redis.stock}, reservations=${input.redis.reservations}, total=${input.initialStock}`,
    `persisted=${input.postgres.persisted}, expected=${input.expectedConfirmed}`,
  );
  const I2 = result(
    input.postgres.duplicateUsersGlobal === 0 &&
      input.postgres.duplicateUsersInSale === 0 &&
      equalSet(input.buyers, reservationUsers) &&
      equalSet(input.buyers, persistedUsers),
    `globalDuplicates=${input.postgres.duplicateUsersGlobal}, saleDuplicates=${input.postgres.duplicateUsersInSale}`,
    `buyers=${input.buyers.size}, reservations=${reservationUsers.size}, persistedUsers=${persistedUsers.size}`,
  );
  const allInsideWindow =
    input.orders.every(
      (order) =>
        order.createdAtMs >= input.sale.startsAtMs && order.createdAtMs < input.sale.endsAtMs,
    ) &&
    [...input.reservations.values()].every(
      (reservation) =>
        reservation.reservedAtMs >= input.sale.startsAtMs &&
        reservation.reservedAtMs < input.sale.endsAtMs,
    );
  const I3 = result(
    input.postgres.outsideWindow === 0 && allInsideWindow,
    `outsideWindow=${input.postgres.outsideWindow}, startsAtMs=${input.sale.startsAtMs}, endsAtMs=${input.sale.endsAtMs}`,
  );
  const queue = input.convergence.queue;
  const I4 = result(
    input.convergence.apiReady &&
      input.convergence.workerReady &&
      input.convergence.matchingSnapshots === 2 &&
      input.convergence.stableIntervalMs >= 250 &&
      input.convergence.finalLiveCollection === true &&
      queue.waiting === 0 &&
      queue.active === 0 &&
      queue.delayed === 0 &&
      queue.failed === 0 &&
      input.postgres.reserved === 0 &&
      input.expectedConfirmed === input.postgres.persisted + input.postgres.compensated &&
      identitiesMatch &&
      input.reservations.size === persisted.length &&
      compensatedAbsent &&
      configEqual &&
      (input.ledgerErrors?.length ?? 0) === 0,
    `confirmed=${input.expectedConfirmed}, persisted=${input.postgres.persisted}, compensated=${input.postgres.compensated}, reserved=${input.postgres.reserved}`,
    `queue=${queue.waiting}/${queue.active}/${queue.delayed}/${queue.failed}, matchingSnapshots=${input.convergence.matchingSnapshots}, stableIntervalMs=${input.convergence.stableIntervalMs}, finalLiveCollection=${input.convergence.finalLiveCollection}`,
    `identitiesMatch=${identitiesMatch}, configEqual=${configEqual}, ledgerErrors=${input.ledgerErrors?.length ?? 0}`,
  );
  const invariants = { I1, I2, I3, I4 };
  return {
    schemaVersion: 1,
    runId: input.runId,
    scenario: input.scenario,
    saleId: input.saleId,
    auditedAt: new Date().toISOString(),
    expectedConfirmed: input.expectedConfirmed,
    convergence: input.convergence,
    postgres: input.postgres,
    redis: input.redis,
    invariants,
    pass: Object.values(invariants).every((invariant) => invariant.pass),
  };
}

function scenarioCountsPass(
  scenario: StressScenario,
  expected: number,
  persisted: number,
): boolean {
  const fixed = {
    warmup: 200,
    smoke: 200,
    surge: 500,
    'duplicate-storm': 5000,
    'sold-out': 10,
    'window-edge': 1000,
  } satisfies Record<StressScenario, number>;
  return expected === fixed[scenario] && persisted === fixed[scenario];
}

export interface ResultArtifact {
  scenario: StressScenario;
  repetition: number;
  pass: boolean;
  summaryPath: string;
  auditPath: string;
  runtimePath: string;
}

export function validateResultArtifacts(
  profile: 'full' | 'smoke',
  artifacts: readonly ResultArtifact[],
): readonly ResultArtifact[] {
  const warmups = artifacts.filter((artifact) => artifact.scenario === 'warmup');
  if (profile === 'smoke') {
    if (warmups.length !== 0) throw new Error('Smoke profile must not contain warmup');
    const smoke = artifacts.filter(
      (artifact) => artifact.scenario === 'smoke' && artifact.repetition === 1,
    );
    if (smoke.length !== 1 || artifacts.length !== 1)
      throw new Error('Smoke profile requires exactly smoke/r1');
    return smoke;
  }
  if (warmups.length !== 1 || warmups[0]?.repetition !== 1 || !warmups[0].pass)
    throw new Error('Full profile requires exactly one passing warmup/r1');
  const measured = artifacts.filter((artifact) =>
    (MEASURED_STRESS_SCENARIOS as readonly string[]).includes(artifact.scenario),
  );
  const required = ['surge', 'duplicate-storm', 'sold-out', 'window-edge'];
  if (
    measured.length !== 12 ||
    required.some((scenario) =>
      [1, 2, 3].some(
        (repetition) =>
          !measured.some(
            (artifact) => artifact.scenario === scenario && artifact.repetition === repetition,
          ),
      ),
    )
  ) {
    throw new Error('Full profile requires all 12 measured reports');
  }
  return measured;
}

export function integrityInputPaths(artifacts: readonly ResultArtifact[]): readonly string[] {
  return artifacts
    .flatMap((artifact) => [artifact.summaryPath, artifact.auditPath, artifact.runtimePath])
    .sort();
}

interface CliOptions {
  runId: string;
  scenario: StressScenario;
  saleId: string;
  initialStock: number;
  expectedConfirmed: number;
  apiUrl: URL;
  workerUrl: URL;
  databaseUrl: URL;
  redisUrl: URL;
  deadlineMs: number;
  out: string;
  publication: AuditPublicationCapability;
}

export interface AuditPathSeams {
  rawResultsRoot?: string;
  realpathSync?: typeof realpathSync;
  lstatSync?: typeof lstatSync;
}

export type AuditCapabilityState = 'open' | 'publishing' | 'closed';

export interface AuditPublicationCapability {
  readonly outputName: 'audit.json';
  readonly canonicalParentPath: string;
  readonly state: AuditCapabilityState;
  close(): void;
}

export interface AuditLinkHelperInvocation {
  readonly tempFd: number;
  readonly parentFd: number;
  readonly helperFd: number;
}

export interface AuditLinkHelperResult {
  readonly status: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stderr: string;
}

export interface AuditPublicationSeams {
  readonly platform?: NodeJS.Platform;
  readonly procFdRoot?: string;
  readonly randomBytes?: (size: number) => Buffer;
  readonly beforePublish?: () => void | Promise<void>;
  readonly afterTempSync?: (tempName: string) => void | Promise<void>;
  /** Deterministic rejection-only view of canonical paths for publication tests. */
  readonly canonicalPathLstatSync?: typeof lstatSync;
  /** Deterministic rejection-only view of canonical paths for publication tests. */
  readonly canonicalPathStatSync?: typeof statSync;
  readonly invokeLinkHelper?: (
    invocation: AuditLinkHelperInvocation,
  ) => AuditLinkHelperResult | Promise<AuditLinkHelperResult>;
}

export interface AuditPublicationReceipt {
  readonly outputName: 'audit.json';
  readonly retainedTempName: string;
}

function isStrictDescendant(parent: string, candidate: string): boolean {
  const pathFromParent = relative(parent, candidate);
  return (
    pathFromParent !== '' &&
    pathFromParent !== '..' &&
    !pathFromParent.startsWith(`..${sep}`) &&
    !isAbsolute(pathFromParent)
  );
}

function validPathSegment(segment: string): boolean {
  return (
    segment.length > 0 &&
    segment !== '.' &&
    segment !== '..' &&
    !segment.includes('/') &&
    !segment.includes('\\')
  );
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

function mergeErrors(primary: unknown, secondary: unknown): unknown {
  if (primary === undefined) return secondary;
  return new AggregateError([primary, secondary], 'Audit publication and cleanup failed', {
    cause: primary,
  });
}

async function anchoredLstat(path: string) {
  return fsPromises.lstat(path, { bigint: true });
}

interface CapabilityRecord {
  fd: number;
  state: AuditCapabilityState;
  readonly canonicalParentPath: string;
}

const capabilityRecords = new WeakMap<object, CapabilityRecord>();

class LiveAuditPublicationCapability implements AuditPublicationCapability {
  readonly outputName = 'audit.json' as const;

  constructor(canonicalParentPath: string, fd: number) {
    capabilityRecords.set(this, { canonicalParentPath, fd, state: 'open' });
  }

  get canonicalParentPath(): string {
    return requireCapability(this).canonicalParentPath;
  }

  get state(): AuditCapabilityState {
    return requireCapability(this).state;
  }

  close(): void {
    const record = requireCapability(this);
    if (record.state === 'closed') return;
    record.state = 'closed';
    const fd = record.fd;
    record.fd = -1;
    closeSync(fd);
  }
}

function requireCapability(capability: AuditPublicationCapability): CapabilityRecord {
  const record = capabilityRecords.get(capability as object);
  if (!record) throw new Error('Invalid audit publication capability');
  return record;
}

function closeCapabilityPreserving(
  capability: AuditPublicationCapability,
  failure: unknown,
): unknown {
  try {
    capability.close();
  } catch (error) {
    return mergeErrors(failure, error);
  }
  return failure;
}

export function closeAuditCliOptions(options: {
  readonly publication: AuditPublicationCapability;
}): void {
  options.publication.close();
}

function descriptorPath(procFdRoot: string, fd: number, name?: string): string {
  const root = join(procFdRoot, String(fd));
  return name === undefined ? root : join(root, name);
}

function canonicalCapabilityError(cause?: unknown): Error {
  return cause === undefined
    ? new Error('Audit output parent canonical path no longer resolves to held capability')
    : new Error('Audit output parent canonical path no longer resolves to held capability', {
        cause,
      });
}

function assertCanonicalCapabilityReachable(
  record: CapabilityRecord,
  procFdRoot: string,
  seams: Pick<AuditPublicationSeams, 'canonicalPathLstatSync' | 'canonicalPathStatSync'>,
): void {
  try {
    if (readlinkSync(descriptorPath(procFdRoot, record.fd)) !== record.canonicalParentPath)
      throw canonicalCapabilityError();

    const held = fstatSync(record.fd, { bigint: true });
    if (!held.isDirectory()) throw canonicalCapabilityError();

    const canonicalLstat = (seams.canonicalPathLstatSync ?? lstatSync)(record.canonicalParentPath, {
      bigint: true,
    });
    if (!canonicalLstat.isDirectory() || canonicalLstat.isSymbolicLink())
      throw canonicalCapabilityError();

    const canonicalStat = (seams.canonicalPathStatSync ?? statSync)(record.canonicalParentPath, {
      bigint: true,
    });
    if (
      !canonicalStat.isDirectory() ||
      canonicalStat.dev !== held.dev ||
      canonicalStat.ino !== held.ino
    )
      throw canonicalCapabilityError();
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === 'Audit output parent canonical path no longer resolves to held capability'
    )
      throw error;
    throw canonicalCapabilityError(error);
  }
}

function assertCanonicalAuditVisible(
  record: CapabilityRecord,
  tempIdentity: { dev: bigint; ino: bigint },
  byteLength: number,
  seams: Pick<AuditPublicationSeams, 'canonicalPathLstatSync'>,
): void {
  try {
    const canonicalFinal = (seams.canonicalPathLstatSync ?? lstatSync)(
      join(record.canonicalParentPath, 'audit.json'),
      { bigint: true },
    );
    if (
      !canonicalFinal.isFile() ||
      canonicalFinal.isSymbolicLink() ||
      canonicalFinal.dev !== tempIdentity.dev ||
      canonicalFinal.ino !== tempIdentity.ino ||
      canonicalFinal.size !== BigInt(byteLength) ||
      (canonicalFinal.mode & 0o777n) !== 0o400n
    )
      throw new Error('Canonical audit output does not resolve to the published capability');
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === 'Canonical audit output does not resolve to the published capability'
    )
      throw error;
    throw new Error('Canonical audit output does not resolve to the published capability', {
      cause: error,
    });
  }
}

function invokeProductionLinkHelper({
  tempFd,
  parentFd,
  helperFd,
}: AuditLinkHelperInvocation): AuditLinkHelperResult {
  const result = spawnSync(
    '/proc/self/fd/5',
    ['-L', '-T', '--', '/proc/self/fd/3', '/proc/self/fd/4/audit.json'],
    {
      env: { LC_ALL: 'C', LANG: 'C' },
      stdio: ['ignore', 'pipe', 'pipe', tempFd, parentFd, helperFd],
      timeout: 5000,
      killSignal: 'SIGKILL',
      maxBuffer: 65_536,
      encoding: 'utf8',
    },
  );
  if (result.error) throw new Error('Audit link helper execution failed', { cause: result.error });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  if (Buffer.byteLength(output, 'utf8') > 65_536)
    throw new Error('Audit link helper output exceeded 65536 bytes');
  return {
    status: result.status,
    signal: result.signal,
    stderr: output,
  };
}

export async function publishAuditReport(
  capability: AuditPublicationCapability,
  reportBytes: string | Uint8Array,
  seams: AuditPublicationSeams = {},
): Promise<AuditPublicationReceipt> {
  const platform = seams.platform ?? process.platform;
  const procFdRoot = seams.procFdRoot ?? '/proc/self/fd';
  const record = requireCapability(capability);
  if (record.state !== 'open') throw new Error('Audit publication capability is not open');
  record.state = 'publishing';

  let tempHandle: FileHandle | undefined;
  let tempName: string | undefined;
  let tempIdentity: { dev: bigint; ino: bigint } | undefined;
  let finalProven = false;
  let failure: unknown;

  try {
    if (platform !== 'linux') throw new Error('Audit publication requires Linux procfs');
    const procStat = await fsPromises.stat(procFdRoot);
    if (!procStat.isDirectory()) throw new Error('Audit publication requires Linux procfs');
    assertCanonicalCapabilityReachable(record, procFdRoot, seams);

    await seams.beforePublish?.();
    assertCanonicalCapabilityReachable(record, procFdRoot, seams);

    const anchoredFinal = descriptorPath(procFdRoot, record.fd, capability.outputName);
    try {
      await anchoredLstat(anchoredFinal);
      throw new Error('Audit output already exists');
    } catch (error) {
      if (!isNodeError(error, 'ENOENT')) throw error;
    }

    const bytes =
      typeof reportBytes === 'string' ? Buffer.from(reportBytes, 'utf8') : Buffer.from(reportBytes);
    const createFlags =
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const nonceBytes = (seams.randomBytes ?? nodeRandomBytes)(16);
      if (nonceBytes.length !== 16) throw new Error('Audit temp nonce must be exactly 16 bytes');
      const nonce = nonceBytes.toString('hex');
      const candidate = `.audit.json.${process.pid}.${nonce}.retained`;
      if (!/^[a-zA-Z0-9._-]+$/.test(candidate) || !validPathSegment(candidate))
        throw new Error('Invalid audit temp name');
      const candidatePath = descriptorPath(procFdRoot, record.fd, candidate);
      try {
        tempHandle = await fsPromises.open(candidatePath, createFlags, 0o600);
        tempName = candidate;
        break;
      } catch (error) {
        if (!isNodeError(error, 'EEXIST')) throw error;
      }
    }
    if (!tempHandle || !tempName) throw new Error('Audit temp name collision budget exhausted');

    const createdStat = await tempHandle.stat({ bigint: true });
    if (!createdStat.isFile()) throw new Error('Audit temp is not a regular file');
    tempIdentity = { dev: createdStat.dev, ino: createdStat.ino };

    let offset = 0;
    while (offset < bytes.length) {
      const { bytesWritten } = await tempHandle.write(bytes, offset, bytes.length - offset, null);
      if (bytesWritten <= 0) throw new Error('Audit temp write made no progress');
      offset += bytesWritten;
    }
    const writtenStat = await tempHandle.stat({ bigint: true });
    if (!writtenStat.isFile() || writtenStat.size !== BigInt(bytes.length))
      throw new Error('Audit temp file size mismatch');
    if (writtenStat.dev !== tempIdentity.dev || writtenStat.ino !== tempIdentity.ino)
      throw new Error('Audit temp handle identity changed');
    await tempHandle.sync();
    await tempHandle.chmod(0o400);
    await tempHandle.sync();

    await seams.afterTempSync?.(tempName);

    const immutableStat = await tempHandle.stat({ bigint: true });
    if (
      !immutableStat.isFile() ||
      immutableStat.dev !== tempIdentity.dev ||
      immutableStat.ino !== tempIdentity.ino ||
      immutableStat.size !== BigInt(bytes.length) ||
      (immutableStat.mode & 0o777n) !== 0o400n
    )
      throw new Error('Audit temp descriptor identity, size, or mode changed');

    let helperHandle: FileHandle | undefined;
    let helperFailure: unknown;
    try {
      helperHandle = await fsPromises.open(
        '/usr/bin/ln',
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      const helperStat = await helperHandle.stat({ bigint: true });
      if (
        !helperStat.isFile() ||
        helperStat.uid !== 0n ||
        (helperStat.mode & 0o111n) === 0n ||
        (helperStat.mode & 0o022n) !== 0n
      )
        throw new Error('Audit link helper is not a trusted root-owned executable');
      assertCanonicalCapabilityReachable(record, procFdRoot, seams);
      const helperResult = await (seams.invokeLinkHelper ?? invokeProductionLinkHelper)({
        tempFd: tempHandle.fd,
        parentFd: record.fd,
        helperFd: helperHandle.fd,
      });
      if (
        helperResult.status !== 0 ||
        helperResult.signal !== null ||
        Buffer.byteLength(helperResult.stderr, 'utf8') > 65_536
      )
        throw new Error(
          `Audit link helper failed: status=${String(helperResult.status)} signal=${String(helperResult.signal)} ${helperResult.stderr.slice(0, 65_536)}`,
        );
      assertCanonicalCapabilityReachable(record, procFdRoot, seams);
      assertCanonicalAuditVisible(record, tempIdentity, bytes.length, seams);
    } catch (error) {
      helperFailure = error;
    } finally {
      if (helperHandle) {
        try {
          await helperHandle.close();
        } catch (error) {
          helperFailure = mergeErrors(helperFailure, error);
        }
      }
    }
    if (helperFailure !== undefined) throw helperFailure;

    const finalStat = await anchoredLstat(anchoredFinal);
    if (
      !finalStat.isFile() ||
      finalStat.dev !== tempIdentity.dev ||
      finalStat.ino !== tempIdentity.ino ||
      finalStat.size !== BigInt(bytes.length) ||
      (finalStat.mode & 0o777n) !== 0o400n ||
      finalStat.nlink < 2n
    )
      throw new Error('Published audit output identity, size, or mode mismatch');
    const finalBytes = await fsPromises.readFile(anchoredFinal);
    if (!finalBytes.equals(bytes)) throw new Error('Published audit output bytes mismatch');
    fsyncSync(record.fd);
    assertCanonicalCapabilityReachable(record, procFdRoot, seams);
    assertCanonicalAuditVisible(record, tempIdentity, bytes.length, seams);
    finalProven = true;
  } catch (error) {
    failure = error;
  } finally {
    if (tempHandle && !finalProven) {
      try {
        await tempHandle.chmod(0o000);
        await tempHandle.sync();
      } catch (error) {
        failure = mergeErrors(failure, error);
      }
    }
    if (tempHandle) {
      try {
        await tempHandle.close();
      } catch (error) {
        failure = mergeErrors(failure, error);
      }
    }
    failure = closeCapabilityPreserving(capability, failure);
  }

  if (failure !== undefined) throw failure;
  if (!finalProven || !tempName) throw new Error('Audit report was not published');
  return { outputName: 'audit.json', retainedTempName: tempName };
}

export function parseAuditCli(argv: readonly string[], seams: AuditPathSeams = {}): CliOptions {
  const names = [
    'run-id',
    'scenario',
    'sale-id',
    'initial-stock',
    'expected-confirmed',
    'api-url',
    'worker-url',
    'database-url',
    'redis-url',
    'deadline-ms',
    'out',
  ] as const;
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (
      !flag?.startsWith('--') ||
      value === undefined ||
      values.has(flag.slice(2)) ||
      !names.includes(flag.slice(2) as (typeof names)[number])
    ) {
      throw new Error('Invalid, unknown, missing, or duplicate audit flag');
    }
    values.set(flag.slice(2), value);
  }
  if (values.size !== names.length) throw new Error('Every audit flag is required exactly once');
  const runId = values.get('run-id')!;
  const scenario = values.get('scenario') as StressScenario;
  const saleId = values.get('sale-id')!;
  if (!RUN_ID_PATTERN.test(runId)) throw new Error('Invalid run id');
  if (!STRESS_SCENARIOS.includes(scenario)) throw new Error('Invalid scenario');
  if (!SALE_ID_PATTERN.test(saleId)) throw new Error('Invalid sale id');
  const integer = (name: string, min: number, max = Number.MAX_SAFE_INTEGER) => {
    const value = Number(values.get(name));
    if (!Number.isSafeInteger(value) || value < min || value > max)
      throw new Error(`Invalid --${name}`);
    return value;
  };
  const initialStock = integer('initial-stock', 0);
  const expectedConfirmed = integer('expected-confirmed', 0);
  const deadlineMs = integer('deadline-ms', 10_000, 300_000);
  const urls = ['api-url', 'worker-url', 'database-url', 'redis-url'] as const;
  const parsed = Object.fromEntries(urls.map((name) => [name, new URL(values.get(name)!)]));
  for (const url of Object.values(parsed)) {
    if (!['127.0.0.1', 'localhost', '::1'].includes(url.hostname))
      throw new Error('Audit URLs must use loopback hosts');
  }
  const outArg = values.get('out')!;
  if (!isAbsolute(outArg)) throw new Error('Audit output must be absolute');

  const resolveRealpath = seams.realpathSync ?? realpathSync;
  const inspectPath = seams.lstatSync ?? lstatSync;
  const normalizedRawRoot = resolve(seams.rawResultsRoot ?? AUDIT_RAW_RESULTS_ROOT);
  const rawRootLexicalStat = inspectPath(normalizedRawRoot, { bigint: true });
  const realRawRoot = resolveRealpath(normalizedRawRoot);
  if (
    !rawRootLexicalStat.isDirectory() ||
    rawRootLexicalStat.isSymbolicLink() ||
    realRawRoot !== normalizedRawRoot
  )
    throw new Error('Audit raw results root must be a canonical directory');

  const lexicalRunRoot = join(normalizedRawRoot, runId);
  const realRunRoot = resolveRealpath(lexicalRunRoot);
  if (
    !inspectPath(realRunRoot).isDirectory() ||
    realRunRoot !== lexicalRunRoot ||
    !isStrictDescendant(realRawRoot, realRunRoot)
  )
    throw new Error('Audit run directory must be inside the raw results root');

  const out = resolve(outArg);
  const lexicalRelative = relative(lexicalRunRoot, out);
  if (
    lexicalRelative === '' ||
    lexicalRelative === '..' ||
    lexicalRelative.startsWith(`..${sep}`) ||
    isAbsolute(lexicalRelative)
  )
    throw new Error('Audit output must be inside load/results/raw');
  if (basename(out) !== 'audit.json') throw new Error('Audit output basename must be audit.json');

  const lexicalParent = resolve(out, '..');
  const realParent = resolveRealpath(lexicalParent);
  if (
    !inspectPath(realParent).isDirectory() ||
    realParent !== lexicalParent ||
    !isStrictDescendant(realRunRoot, realParent)
  )
    throw new Error('Audit output parent must be inside the exact run directory');

  const chainSegments = relative(realRawRoot, realParent).split(sep);
  if (chainSegments.length === 0 || chainSegments[0] !== runId)
    throw new Error('Audit output parent must be inside the exact run directory');
  let currentFd = -1;
  try {
    currentFd = openSync(
      realRawRoot,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    if (!fstatSync(currentFd).isDirectory())
      throw new Error('Audit raw results root must be a canonical directory');
    let chainPath = realRawRoot;
    for (const segment of chainSegments) {
      if (!validPathSegment(segment))
        throw new Error('Invalid audit publication directory segment');
      chainPath = join(chainPath, segment);
      const pathStat = inspectPath(chainPath, { bigint: true });
      if (pathStat.isSymbolicLink() || !pathStat.isDirectory())
        throw new Error('Audit output parent must contain only real directories');
      const childFd = openSync(
        descriptorPath('/proc/self/fd', currentFd, segment),
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      if (!fstatSync(childFd).isDirectory()) {
        closeSync(childFd);
        throw new Error('Audit output parent must contain only real directories');
      }
      closeSync(currentFd);
      currentFd = childFd;
    }
    if (readlinkSync(descriptorPath('/proc/self/fd', currentFd)) !== realParent)
      throw new Error('Audit output parent capability does not match canonical path');
    try {
      lstatSync(descriptorPath('/proc/self/fd', currentFd, 'audit.json'));
      throw new Error('Audit output already exists');
    } catch (error) {
      if (!isNodeError(error, 'ENOENT')) throw error;
    }
    const publication = new LiveAuditPublicationCapability(realParent, currentFd);
    currentFd = -1;
    return {
      runId,
      scenario,
      saleId,
      initialStock,
      expectedConfirmed,
      apiUrl: parsed['api-url']!,
      workerUrl: parsed['worker-url']!,
      databaseUrl: parsed['database-url']!,
      redisUrl: parsed['redis-url']!,
      deadlineMs,
      out,
      publication,
    };
  } finally {
    if (currentFd >= 0) closeSync(currentFd);
  }
}

export interface Snapshot {
  apiReady: boolean;
  workerReady: boolean;
  queue: AuditReport['convergence']['queue'];
  sale: SaleConfig;
  apiSale: SaleConfig;
  redisSale: SaleConfig;
  postgres: AuditReport['postgres'];
  redis: AuditReport['redis'];
  orders: AuditOrder[];
  buyers: Set<string>;
  reservations: Map<string, { reservationId: string; reservedAtMs: number }>;
  ledgerErrors: string[];
}

export interface ConvergenceEvidence {
  snapshot: Snapshot;
  elapsedMs: number;
  matchingSnapshots: 2;
  stableIntervalMs: number;
  finalLiveCollection: true;
  successfulCollections: number;
  collectionFailures: number;
}

async function readJson(url: URL): Promise<{ ok: boolean; body: Record<string, unknown> | null }> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1500) });
    const body = (await response.json()) as Record<string, unknown>;
    return { ok: response.ok, body };
  } catch {
    return { ok: false, body: null };
  }
}

async function collectSnapshot(
  options: CliOptions,
  pool: pg.Pool,
  redis: Redis,
): Promise<Snapshot> {
  const apiReadyResponse = await readJson(new URL('/api/health/ready', options.apiUrl));
  const workerReadyResponse = await readJson(new URL('/health/ready', options.workerUrl));
  const apiSaleResponse = await readJson(new URL('/api/sale/status', options.apiUrl));
  const queueBody = ((apiReadyResponse.body?.checks as Record<string, unknown> | undefined)
    ?.queue ?? {}) as Record<string, unknown>;
  const workerChecks = (workerReadyResponse.body?.checks ?? {}) as Record<string, unknown>;
  const saleRows = await pool.query<{
    id: string;
    name: string;
    total_stock: number;
    starts_at_ms: string;
    ends_at_ms: string;
  }>(
    `SELECT id, name, total_stock, (extract(epoch from starts_at) * 1000)::bigint::text starts_at_ms,
       (extract(epoch from ends_at) * 1000)::bigint::text ends_at_ms FROM sales WHERE id = $1`,
    [options.saleId],
  );
  if (saleRows.rowCount !== 1) throw new Error('Expected exactly one scoped sale row');
  const row = saleRows.rows[0]!;
  const sale = {
    id: row.id,
    name: row.name,
    totalStock: row.total_stock,
    startsAtMs: Number(row.starts_at_ms),
    endsAtMs: Number(row.ends_at_ms),
  };
  const counts = await pool.query<{ status: string; count: string }>(
    'SELECT status::text, count(*)::text count FROM orders WHERE sale_id = $1 GROUP BY status',
    [options.saleId],
  );
  const byStatus = new Map(counts.rows.map((item) => [item.status, Number(item.count)]));
  const duplicateGlobal = await pool.query<{ count: string }>(
    'SELECT count(*)::text count FROM (SELECT user_id FROM orders GROUP BY user_id HAVING count(*) > 1) d',
  );
  const duplicateSale = await pool.query<{ count: string }>(
    'SELECT count(*)::text count FROM (SELECT user_id FROM orders WHERE sale_id = $1 GROUP BY user_id HAVING count(*) > 1) d',
    [options.saleId],
  );
  const outside = await pool.query<{ count: string }>(
    'SELECT count(*)::text count FROM orders o JOIN sales s ON s.id=o.sale_id WHERE o.sale_id=$1 AND (o.created_at < s.starts_at OR o.created_at >= s.ends_at)',
    [options.saleId],
  );
  const orders: AuditOrder[] = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const page = await pool.query<{
      id: string;
      user_id: string;
      status: AuditOrder['status'];
      created_at_ms: string;
    }>(
      'SELECT id::text, user_id, status::text, (extract(epoch from created_at)*1000)::bigint::text created_at_ms FROM orders WHERE sale_id=$1 ORDER BY id LIMIT $2 OFFSET $3',
      [options.saleId, PAGE_SIZE, offset],
    );
    orders.push(
      ...page.rows.map((item) => ({
        id: item.id,
        userId: item.user_id,
        status: item.status,
        createdAtMs: Number(item.created_at_ms),
      })),
    );
    if (page.rows.length < PAGE_SIZE) break;
  }
  const keys = saleKeys(options.saleId);
  const [stockRaw, configRaw, metricsConfirmedRaw] = await Promise.all([
    redis.get(keys.stock),
    redis.hmget(keys.config, 'name', 'startsAtMs', 'endsAtMs', 'totalStock'),
    redis.hget(keys.metrics, 'confirmed'),
  ]);
  const buyers = await scanSet(redis, keys.buyers);
  const reservations = await scanReservations(redis, keys.reservations);
  const apiBody = apiSaleResponse.body ?? {};
  const redisSale = {
    id: options.saleId,
    name: configRaw[0] ?? '',
    startsAtMs: Number(configRaw[1]),
    endsAtMs: Number(configRaw[2]),
    totalStock: Number(configRaw[3]),
  };
  const apiSale = {
    id: String(apiBody.saleId ?? ''),
    name: String(apiBody.name ?? ''),
    startsAtMs: Number(apiBody.startsAtMs),
    endsAtMs: Number(apiBody.endsAtMs),
    totalStock: Number(apiBody.totalStock),
  };
  return {
    apiReady:
      apiReadyResponse.ok &&
      apiReadyResponse.body?.status === 'ok' &&
      apiSale.id === options.saleId,
    workerReady:
      workerReadyResponse.ok &&
      workerChecks.bootstrapReconciled === true &&
      workerChecks.consumerReady === true &&
      workerChecks.reconciliationHealthy === true &&
      Number(workerChecks.activeJobs ?? 0) === 0 &&
      Number(workerChecks.failedJobs ?? 0) === 0,
    queue: {
      waiting: Number(queueBody.waiting ?? -1),
      active: Number(queueBody.active ?? -1),
      delayed: Number(queueBody.delayed ?? -1),
      failed: Number(queueBody.failed ?? -1),
    },
    sale,
    apiSale,
    redisSale,
    postgres: {
      totalStock: sale.totalStock,
      persisted: byStatus.get('persisted') ?? 0,
      compensated: byStatus.get('compensated') ?? 0,
      reserved: byStatus.get('reserved') ?? 0,
      duplicateUsersGlobal: Number(duplicateGlobal.rows[0]?.count ?? -1),
      duplicateUsersInSale: Number(duplicateSale.rows[0]?.count ?? -1),
      outsideWindow: Number(outside.rows[0]?.count ?? -1),
    },
    redis: {
      stock: Number(stockRaw),
      buyers: buyers.size,
      reservations: reservations.size,
      metricsConfirmed: Number(metricsConfirmedRaw ?? 0),
    },
    orders,
    buyers,
    reservations,
    ledgerErrors: [],
  };
}

async function scanSet(redis: Redis, key: string): Promise<Set<string>> {
  const values = new Set<string>();
  let cursor = '0';
  do {
    const [next, page] = await redis.sscan(key, cursor, 'COUNT', PAGE_SIZE);
    cursor = next;
    for (const value of page) values.add(value);
  } while (cursor !== '0');
  return values;
}

async function scanReservations(
  redis: Redis,
  key: string,
): Promise<Map<string, { reservationId: string; reservedAtMs: number }>> {
  const values = new Map<string, { reservationId: string; reservedAtMs: number }>();
  let cursor = '0';
  do {
    const [next, page] = await redis.hscan(key, cursor, 'COUNT', PAGE_SIZE);
    cursor = next;
    for (let index = 0; index < page.length; index += 2) {
      const userId = page[index]!;
      const raw = page[index + 1]!;
      const split = raw.lastIndexOf(':');
      const reservationId = raw.slice(0, split);
      const reservedAtMs = Number(raw.slice(split + 1));
      if (split < 1 || !reservationId || !Number.isSafeInteger(reservedAtMs))
        throw new Error('Malformed Redis reservation ledger entry');
      values.set(userId, { reservationId, reservedAtMs });
    }
  } while (cursor !== '0');
  return values;
}

function converged(snapshot: Snapshot): boolean {
  const queue = snapshot.queue;
  return (
    snapshot.apiReady &&
    snapshot.workerReady &&
    queue.waiting === 0 &&
    queue.active === 0 &&
    queue.delayed === 0 &&
    queue.failed === 0
  );
}

function canonicalFingerprint(snapshot: Snapshot): string {
  const compare = (left: readonly unknown[], right: readonly unknown[]) => {
    const leftText = JSON.stringify(left);
    const rightText = JSON.stringify(right);
    return leftText < rightText ? -1 : leftText > rightText ? 1 : 0;
  };
  const orders = snapshot.orders
    .map((order) => [order.id, order.userId, order.status, order.createdAtMs] as const)
    .sort(compare);
  const buyers = [...snapshot.buyers].sort();
  const reservations = [...snapshot.reservations.entries()]
    .map(
      ([userId, reservation]) =>
        [userId, reservation.reservationId, reservation.reservedAtMs] as const,
    )
    .sort(compare);

  return JSON.stringify([
    snapshot.apiReady,
    snapshot.workerReady,
    [snapshot.queue.waiting, snapshot.queue.active, snapshot.queue.delayed, snapshot.queue.failed],
    saleFingerprint(snapshot.sale),
    saleFingerprint(snapshot.apiSale),
    saleFingerprint(snapshot.redisSale),
    [
      snapshot.postgres.totalStock,
      snapshot.postgres.persisted,
      snapshot.postgres.compensated,
      snapshot.postgres.reserved,
      snapshot.postgres.duplicateUsersGlobal,
      snapshot.postgres.duplicateUsersInSale,
      snapshot.postgres.outsideWindow,
    ],
    [
      snapshot.redis.stock,
      snapshot.redis.buyers,
      snapshot.redis.reservations,
      snapshot.redis.metricsConfirmed,
    ],
    orders,
    buyers,
    reservations,
    [...snapshot.ledgerErrors].sort(),
  ]);
}

function saleFingerprint(sale: SaleConfig): readonly [string, string, number, number, number] {
  return [sale.id, sale.name, sale.totalStock, sale.startsAtMs, sale.endsAtMs];
}

function diagnostic(snapshot: Snapshot | undefined): string {
  if (!snapshot) return 'null';
  return JSON.stringify({
    apiReady: snapshot.apiReady,
    workerReady: snapshot.workerReady,
    queue: snapshot.queue,
    postgres: snapshot.postgres,
    redis: snapshot.redis,
  });
}

function realDelay(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

export async function waitForConvergence(
  collect: () => Promise<Snapshot>,
  options: {
    deadlineMs: number;
    now?: () => number;
    delay?: (milliseconds: number) => Promise<void>;
  },
): Promise<ConvergenceEvidence> {
  const now = options.now ?? Date.now;
  const delayFor = options.delay ?? realDelay;
  const startedAt = now();
  let backoffMs = 100;
  let candidateFingerprint: string | undefined;
  let candidateAt: number | undefined;
  let matchingSnapshots: 0 | 1 | 2 = 0;
  let successfulCollections = 0;
  let collectionFailures = 0;
  let lastComplete: Snapshot | undefined;
  let lastCollectionError: string | undefined;

  const reset = () => {
    candidateFingerprint = undefined;
    candidateAt = undefined;
    matchingSnapshots = 0;
  };
  const remaining = () => options.deadlineMs - (now() - startedAt);
  const sleepForRetry = async () => {
    const milliseconds = Math.min(backoffMs, Math.max(0, remaining()));
    backoffMs = Math.min(2000, Math.ceil(backoffMs * 1.5));
    if (milliseconds > 0) await delayFor(milliseconds);
  };
  const collectOne = async (): Promise<Snapshot | undefined> => {
    try {
      const snapshot = await collect();
      successfulCollections += 1;
      lastComplete = snapshot;
      return snapshot;
    } catch (error) {
      collectionFailures += 1;
      lastCollectionError = redact(error);
      reset();
      return undefined;
    }
  };

  while (remaining() > 0) {
    const snapshot = await collectOne();
    if (remaining() <= 0) break;

    if (!snapshot || !converged(snapshot)) {
      if (snapshot) reset();
      await sleepForRetry();
      continue;
    }

    const fingerprint = canonicalFingerprint(snapshot);
    const completedAt = now();
    if (candidateFingerprint === undefined || fingerprint !== candidateFingerprint) {
      candidateFingerprint = fingerprint;
      candidateAt = completedAt;
      matchingSnapshots = 1;
      await sleepForRetry();
      continue;
    }

    const stableIntervalMs = completedAt - candidateAt!;
    if (stableIntervalMs < 250) {
      await sleepForRetry();
      continue;
    }
    matchingSnapshots = 2;

    if (remaining() <= 0) break;
    const finalSnapshot = await collectOne();
    if (remaining() <= 0) break;
    if (
      finalSnapshot &&
      converged(finalSnapshot) &&
      canonicalFingerprint(finalSnapshot) === candidateFingerprint
    ) {
      return {
        snapshot: finalSnapshot,
        elapsedMs: now() - startedAt,
        matchingSnapshots,
        stableIntervalMs,
        finalLiveCollection: true,
        successfulCollections,
        collectionFailures,
      };
    }
    reset();
    await sleepForRetry();
  }

  throw new Error(
    `Convergence deadline expired; last=${diagnostic(lastComplete)}; lastCollectionError=${lastCollectionError ?? 'none'}`,
  );
}

async function runCli(): Promise<void> {
  let options: CliOptions | undefined;
  let pool: pg.Pool | undefined;
  let redis: Redis | undefined;
  try {
    let parsedOptions: CliOptions;
    try {
      parsedOptions = parseAuditCli(process.argv.slice(2));
    } catch (error) {
      throw new Error(redact(error));
    }
    options = parsedOptions;
    pool = new Pool({
      connectionString: parsedOptions.databaseUrl.toString(),
      max: 2,
      connectionTimeoutMillis: 2000,
      statement_timeout: 5000,
    });
    redis = new Redis(parsedOptions.redisUrl.toString(), {
      lazyConnect: true,
      connectTimeout: 2000,
      commandTimeout: 5000,
      maxRetriesPerRequest: 1,
    });
    await redis.connect();
    const convergence = await waitForConvergence(
      () => collectSnapshot(parsedOptions, pool!, redis!),
      {
        deadlineMs: parsedOptions.deadlineMs,
      },
    );
    const snapshot = convergence.snapshot;
    const report = evaluateAudit({
      runId: parsedOptions.runId,
      scenario: parsedOptions.scenario,
      saleId: parsedOptions.saleId,
      initialStock: parsedOptions.initialStock,
      expectedConfirmed: parsedOptions.expectedConfirmed,
      sale: snapshot.sale,
      apiSale: snapshot.apiSale,
      redisSale: snapshot.redisSale,
      convergence: {
        elapsedMs: convergence.elapsedMs,
        apiReady: snapshot.apiReady,
        workerReady: snapshot.workerReady,
        queue: snapshot.queue,
        matchingSnapshots: convergence.matchingSnapshots,
        stableIntervalMs: convergence.stableIntervalMs,
        finalLiveCollection: convergence.finalLiveCollection,
        successfulCollections: convergence.successfulCollections,
        collectionFailures: convergence.collectionFailures,
      },
      postgres: snapshot.postgres,
      redis: snapshot.redis,
      orders: snapshot.orders,
      buyers: snapshot.buyers,
      reservations: snapshot.reservations,
      ledgerErrors: snapshot.ledgerErrors,
    });
    await publishAuditReport(parsedOptions.publication, `${JSON.stringify(report, null, 2)}\n`);
    console.table(
      Object.entries(report.invariants).map(([invariant, value]) => ({
        invariant,
        pass: value.pass,
        evidence: value.evidence.join('; '),
      })),
    );
    if (!report.pass) process.exitCode = 1;
  } finally {
    await Promise.allSettled([
      pool?.end() ?? Promise.resolve(),
      redis?.quit() ?? Promise.resolve(),
    ]);
    if (options) closeAuditCliOptions(options);
  }
}

function redact(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(
    /([a-z]+:\/\/[^:/\s]+:)[^@\s]+@/gi,
    '$1[REDACTED]@',
  );
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain)
  runCli().catch((error) => {
    console.error(`audit: ${redact(error)}`);
    process.exitCode = 1;
  });
