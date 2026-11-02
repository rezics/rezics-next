import { createHash, randomUUID } from 'node:crypto';
import { spawn, type SpawnOptions } from 'node:child_process';
import {
  chmodSync,
  closeSync,
  fsyncSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  checkRunBindingHash,
  checkRunNativeReceiptDigest,
  decodeCheckRunMessage,
  validateCheckRunPreparedDescriptor,
  type CheckRunFinalCustody,
  type CheckRunFinalSettlement,
  type CheckRunInvocationBinding,
  type CheckRunNativeDisposition,
  type CheckRunNativeTerminalMessage,
  type CheckRunPhysicalIdentity,
  type CheckRunPreparedDescriptor,
} from '../../../scripts/check-run-settlement.ts';

const BINDING_FIELDS = [
  'sourceRevision',
  'indexTree',
  'sourceSha256',
  'argvSha256',
  'cwd',
  'semanticEnvironmentSha256',
  'relocatedEnvironmentSha256',
  'producerClosureSha256',
  'hostsSha256',
  'preparationCommandsSha256',
  'returnsSha256',
] as const;
const MAX_DESCRIPTOR_BYTES = 64 * 1024;
const MAX_FINAL_BYTES = 64 * 1024;
const MAX_NATIVE_BYTES = 64 * 1024;
const MAX_RECORD_BYTES = 1024 * 1024;
const MAX_STATUS_BYTES = 10 * 1024 * 1024;
const MAX_RECEIPT_CHUNKS = 256;
const MAX_RECOVERY_HELPERS = 16;
export const WEB_CHECK_RECOVERY_LIMITS = {
  observationMs: 30_000,
  terminationGraceMs: 5_000,
  terminationSettleMs: 5_000,
  outputSettleMs: 5_000,
} as const;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH = /^[a-f0-9]{64}$/;

export type CheckRunBinding = CheckRunInvocationBinding;
export type PreparedCheckRunDescriptor = CheckRunPreparedDescriptor;

export type WebCheckPrivateFiles = {
  directory: string;
  environmentFile: string;
  descriptorFile: string;
  recordFile: string;
  evidenceFile: string;
  close: () => void;
};

export type WebCheckDriverProcess = {
  code: number | null;
  signal: NodeJS.Signals | null;
  closed: boolean;
  output: string;
  outputOverflow: boolean;
  parentClosed?: boolean;
  outputClosed?: boolean;
  groupClosed?: boolean | null;
  timedOut?: boolean;
  cancelled?: boolean;
};

export type WebCheckHelperStart = { pid: number | null; startedAt: string };

export type WebCheckHelperLifetime = {
  parentClosed?: boolean;
  outputClosed?: boolean;
  groupClosed?: boolean | null;
  timedOut?: boolean;
  cancelled?: boolean;
  outputOverflow?: boolean;
};

export type WebCheckProcessLimits = {
  observationMs: number;
  terminationGraceMs: number;
  terminationSettleMs: number;
  outputSettleMs: number;
};

export type WebCheckDriverInvocation = {
  phase: 'prepare' | 'run-prepared' | 'status' | 'reconcile';
  command: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  onReceipt?: (chunk: Uint8Array) => void;
  limits?: WebCheckProcessLimits;
  onStart?: (identity: WebCheckHelperStart) => void;
  onLifetime?: (lifetime: WebCheckHelperLifetime) => void;
};

export type WebCheckCustodyRuntime = {
  invoke: (input: WebCheckDriverInvocation) => Promise<WebCheckDriverProcess>;
  cleanup: (files: WebCheckPrivateFiles) => void | Promise<void>;
};

export type WebCheckCustodyOutcome = {
  code: number;
  custody: 'settled' | 'occupied';
  invocationId: string | null;
  nativeExitCode: number | null;
  source: 'verified' | 'unknown';
  returns: 'verified' | 'unknown';
  finalCustody: 'settled' | 'pending' | 'unknown';
  privateCleanup: 'settled' | 'retained' | 'unknown';
  cancellation: 'none' | 'requested' | 'settled' | 'unknown';
  descriptorFile: string;
};

type PhysicalIdentity = CheckRunPhysicalIdentity;
type NativeDisposition = CheckRunNativeDisposition;
type NativeTerminal = Omit<CheckRunNativeTerminalMessage, 'receipt'> & {
  receipt: {
    schema: 1;
    host: 'a' | 'b';
    run: string;
    exitCode: number;
    lifetimeFailure: unknown;
    resources: unknown;
  };
};
type FinalSettlement = Omit<CheckRunFinalSettlement, 'native'> & { native: NativeDisposition };

type ExpectedInvocation = {
  driverRoot: string;
  hostsFile: string;
  workspace: string;
  cwd: string;
  sourceRevision: string;
  commandSha256: string;
  semanticEnvironmentSha256: string;
  relocatedEnvironmentSha256: string;
  returns: string[];
  returnsSha256: string;
};

type WebCustodyRecord = {
  schema: 1;
  type: 'web-check-custody';
  descriptorFile: string;
  environmentFile: string;
  expected: ExpectedInvocation;
  descriptor: PreparedCheckRunDescriptor | null;
  registered: RegisteredInvocation | null;
  caller: CallerLifetime;
  recovery: RecoveryHelper[];
  ingress: ReceiptIngress;
  validation: { source: EvidenceState; returns: EvidenceState };
  cleanup: {
    state: 'not-attempted' | 'dispatching' | 'settled' | 'unknown';
    detail: string | null;
    environmentInput: 'present' | 'removed' | 'unknown';
  };
  cancellation: { requested: boolean; signal: 1 | 2 | 15 | null };
  native: NativeTerminal | null;
  final: FinalSettlement | null;
  rejectedEvidence: boolean;
  failure: string | null;
};

type PrivateReference = { file: string; sha256: string } | null;
type RegisteredInvocation = {
  binding: CheckRunBinding;
  candidateWorkspace: string;
  snapshot: NonNullable<StatusRecord['snapshot']>;
  returns: string[];
  preparedExecution: Exclude<PrivateReference, null>;
  descriptor: Exclude<PrivateReference, null>;
  preparationIntent: PrivateReference;
};
type ProcessLifetime = {
  state: 'not-started' | 'dispatching' | 'closed' | 'unknown';
  code: number | null;
  signal: string | null;
  outputSha256: string | null;
  outputOverflow: boolean;
};
type CallerLifetime = { prepare: ProcessLifetime; run: ProcessLifetime };
type RecoveryHelper = {
  id: string;
  operation: 'status' | 'reconcile';
  pid: number | null;
  startedAt: string;
  finishedAt: string | null;
  state: 'dispatching' | 'closed' | 'unknown';
  parentClosed: boolean | null;
  outputClosed: boolean | null;
  groupClosed: boolean | null;
  timedOut: boolean;
  cancelled: boolean;
  outputOverflow: boolean | null;
};
type EvidenceState = 'unknown' | 'verified' | 'rejected';
type IngressMessage = {
  state: 'absent' | 'received' | 'reconciled' | 'rejected';
  start: number | null;
  end: number | null;
  rawSha256: string | null;
  bodySha256: string | null;
  originalSha256: string | null;
};
type ReceiptIngress = {
  streamBytes: number;
  streamSha256: string;
  complete: boolean;
  native: IngressMessage;
  final: IngressMessage;
};

type StatusRecord = {
  invocationId: string;
  nonce: string;
  phase: string;
  binding: CheckRunBinding;
  physical: PhysicalIdentity | null;
  native: NativeDisposition | null;
  returns: string[];
  candidateWorkspace: string | null;
  preparedExecution: PrivateReference;
  descriptor: PrivateReference;
  preparationIntent: PrivateReference;
  snapshot: { workspace: string; scratch: string; sourceSha256: string; inputFiles: string[] } | null;
  snapshotCustody: 'owned' | 'removed' | 'unknown' | null;
  cancellation: { requested: boolean; signal: 1 | 2 | 15 | null };
  final: FinalSettlement | null;
  rejectedObservation: boolean;
  finalCustody: CheckRunFinalCustody | null;
};

function sha256(bytes: string | Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function jsonSha256(value: unknown): string {
  return sha256(JSON.stringify(value));
}

function privateReferenceSha256(reference: PrivateReference): string | null {
  return reference === null ? null : jsonSha256(reference);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function closed(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (
    !isObject(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
    Reflect.ownKeys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  )
    throw new Error(`Web check custody: invalid ${label}`);
  return value;
}

function text(value: unknown, label: string, max = 2048): string {
  if (typeof value !== 'string' || value.length > max || /[\0\r]/.test(value))
    throw new Error(`Web check custody: invalid ${label}`);
  return value;
}

function hash(value: unknown, label: string): string {
  if (typeof value !== 'string' || !HASH.test(value)) throw new Error(`Web check custody: invalid ${label}`);
  return value;
}

function count(value: unknown, label: string, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > max)
    throw new Error(`Web check custody: invalid ${label}`);
  return value as number;
}

function parseUniqueJson(raw: string): unknown {
  let index = 0;
  let nodes = 0;
  const whitespace = () => {
    while (index < raw.length && /[\t\n\r ]/.test(raw[index]!)) index += 1;
  };
  const stringToken = (): string => {
    if (raw[index] !== '"') throw new Error('invalid JSON string');
    const start = index++;
    while (index < raw.length) {
      const character = raw[index++]!;
      if (character === '"') return JSON.parse(raw.slice(start, index)) as string;
      if (character === '\\') index += 1;
      else if (character.charCodeAt(0) < 0x20) throw new Error('invalid JSON string');
    }
    throw new Error('incomplete JSON string');
  };
  const visit = (depth: number): void => {
    if (depth > 64 || ++nodes > 20_000) throw new Error('JSON structure exceeds its bound');
    whitespace();
    const character = raw[index];
    if (character === '{') {
      index += 1;
      whitespace();
      const keys = new Set<string>();
      if (raw[index] === '}') {
        index += 1;
        return;
      }
      while (true) {
        whitespace();
        const key = stringToken();
        if (keys.has(key)) throw new Error('duplicate JSON object key');
        keys.add(key);
        whitespace();
        if (raw[index++] !== ':') throw new Error('invalid JSON object');
        visit(depth + 1);
        whitespace();
        const separator = raw[index++];
        if (separator === '}') return;
        if (separator !== ',') throw new Error('invalid JSON object');
      }
    }
    if (character === '[') {
      index += 1;
      whitespace();
      if (raw[index] === ']') {
        index += 1;
        return;
      }
      while (true) {
        visit(depth + 1);
        whitespace();
        const separator = raw[index++];
        if (separator === ']') return;
        if (separator !== ',') throw new Error('invalid JSON array');
      }
    }
    if (character === '"') {
      stringToken();
      return;
    }
    const rest = raw.slice(index);
    const literal = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(rest)?.[0];
    if (!literal) throw new Error('invalid JSON value');
    index += literal.length;
  };
  visit(0);
  whitespace();
  if (index !== raw.length) throw new Error('trailing JSON data');
  return JSON.parse(raw) as unknown;
}

function validateBinding(value: unknown): CheckRunBinding {
  const item = closed(value, BINDING_FIELDS, 'eleven-field invocation binding');
  const sourceRevision = text(item.sourceRevision, 'source revision', 64);
  const indexTree = text(item.indexTree, 'index tree', 64);
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(sourceRevision) || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(indexTree))
    throw new Error('Web check custody: invalid source or snapshot revision');
  if (sourceRevision.length !== indexTree.length) throw new Error('Web check custody: source/snapshot format mismatch');
  const cwd = text(item.cwd, 'workspace-relative cwd', 4096);
  if (
    !cwd ||
    (cwd !== '.' &&
      (cwd.startsWith('/') ||
        /^[A-Za-z]:/.test(cwd) ||
        /[\\\0\r\n]/.test(cwd) ||
        cwd.split('/').some((part) => ['.', '..', ''].includes(part))))
  )
    throw new Error('Web check custody: cwd is not workspace-relative');
  return {
    sourceRevision,
    indexTree,
    sourceSha256: hash(item.sourceSha256, 'source snapshot hash'),
    argvSha256: hash(item.argvSha256, 'argv hash'),
    cwd,
    semanticEnvironmentSha256: hash(item.semanticEnvironmentSha256, 'semantic environment hash'),
    relocatedEnvironmentSha256: hash(item.relocatedEnvironmentSha256, 'relocated environment hash'),
    producerClosureSha256: hash(item.producerClosureSha256, 'producer closure hash'),
    hostsSha256: hash(item.hostsSha256, 'host configuration hash'),
    preparationCommandsSha256: hash(item.preparationCommandsSha256, 'preparation commands hash'),
    returnsSha256: hash(item.returnsSha256, 'return declarations hash'),
  };
}

function validateDescriptor(value: unknown): PreparedCheckRunDescriptor {
  try {
    const descriptor = validateCheckRunPreparedDescriptor(value);
    return {
      ...descriptor,
      binding: validateBinding(descriptor.binding),
      cancellation: { file: resolve(descriptor.cancellation.file), id: descriptor.invocationId },
    };
  } catch {
    throw new Error('Web check custody: invalid prepared descriptor under the producer schema');
  }
}

function validatePhysical(value: unknown): PhysicalIdentity {
  const item = closed(value, ['host', 'run'], 'physical run identity');
  if (item.host !== 'a' && item.host !== 'b') throw new Error('Web check custody: invalid physical host');
  const run = text(item.run, 'physical run id', 96);
  if (!/^[a-zA-Z0-9-]+$/.test(run)) throw new Error('Web check custody: invalid physical run id');
  return { host: item.host, run };
}

function validateLifetimeFailure(value: unknown, host: string, run: string, exitCode: number): unknown {
  if (value === null) return null;
  const item = closed(
    value,
    ['schema', 'status', 'phase', 'host', 'run', 'limitMs', 'elapsedMs', 'command'],
    'native lifetime failure',
  );
  if (
    item.schema !== 1 ||
    item.status !== 'infrastructure-failure' ||
    item.phase !== 'run-lifetime' ||
    item.host !== host ||
    item.run !== run ||
    exitCode !== 124 ||
    !Number.isSafeInteger(item.limitMs) ||
    (item.limitMs as number) < 1 ||
    !Number.isSafeInteger(item.elapsedMs) ||
    (item.elapsedMs as number) < (item.limitMs as number)
  )
    throw new Error('Web check custody: invalid native lifetime receipt');
  text(item.command, 'native command receipt', 256);
  return {
    schema: 1,
    status: 'infrastructure-failure',
    phase: 'run-lifetime',
    host,
    run,
    limitMs: item.limitMs as number,
    elapsedMs: item.elapsedMs as number,
    command: item.command as string,
  };
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function validateResources(value: unknown, host: string, run: string): unknown {
  if (value === null) return null;
  const item = closed(
    value,
    [
      'schema',
      'host',
      'run',
      'boot',
      'supervisor',
      'cgroup',
      'cadenceMs',
      'startedMonoMs',
      'commandStartedMonoMs',
      'terminalMonoMs',
      'samples',
      'sampledMaxCores',
    ],
    'physical resource receipt',
  );
  if (
    item.schema !== 1 ||
    item.host !== host ||
    item.run !== run ||
    typeof item.boot !== 'string' ||
    item.cadenceMs !== 5000
  )
    throw new Error('Web check custody: physical resource receipt identity mismatch');
  const supervisor = closed(item.supervisor, ['pid', 'start', 'group'], 'resource supervisor');
  count(supervisor.pid, 'supervisor pid', 2 ** 31 - 1);
  text(supervisor.start, 'supervisor start', 64);
  count(supervisor.group, 'supervisor group', 2 ** 31 - 1);
  if (item.cgroup !== null) {
    const cgroup = closed(item.cgroup, ['path', 'device', 'inode', 'invocation'], 'resource cgroup');
    if (
      typeof cgroup.path !== 'string' ||
      !cgroup.path.startsWith('/') ||
      !text(cgroup.invocation, 'cgroup invocation', 128)
    )
      throw new Error('Web check custody: invalid resource cgroup');
    count(cgroup.device, 'cgroup device');
    count(cgroup.inode, 'cgroup inode');
  }
  const started = item.startedMonoMs;
  const terminal = item.terminalMonoMs;
  if (!finite(started) || !finite(terminal) || terminal < started)
    throw new Error('Web check custody: invalid resource receipt time range');
  if (
    item.commandStartedMonoMs !== null &&
    (!finite(item.commandStartedMonoMs) || item.commandStartedMonoMs < started || item.commandStartedMonoMs > terminal)
  )
    throw new Error('Web check custody: invalid command start time');
  if (
    !Array.isArray(item.samples) ||
    item.samples.length > 1444 ||
    (item.sampledMaxCores !== null && !finite(item.sampledMaxCores))
  )
    throw new Error('Web check custody: invalid resource samples');
  let prior = started;
  for (const raw of item.samples) {
    const sample = closed(
      raw,
      ['monoMs', 'phase', 'usageUsec', 'memoryPeakBytes', 'intervalMs', 'cores', 'unavailable'],
      'resource sample',
    );
    if (
      !finite(sample.monoMs) ||
      sample.monoMs < prior ||
      sample.monoMs > terminal ||
      !['preparation', 'command', 'terminal'].includes(String(sample.phase)) ||
      [sample.usageUsec, sample.memoryPeakBytes, sample.intervalMs, sample.cores].some(
        (value) => value !== null && !finite(value),
      ) ||
      (sample.unavailable !== null && typeof sample.unavailable !== 'string')
    )
      throw new Error('Web check custody: invalid ordered resource sample');
    prior = sample.monoMs as number;
  }
  return item;
}

function validateNativeTerminal(value: unknown, descriptor: PreparedCheckRunDescriptor): NativeTerminal {
  const item = closed(
    value,
    ['schema', 'type', 'invocationId', 'nonce', 'binding', 'physical', 'receipt'],
    'native terminal message',
  );
  if (
    item.schema !== 1 ||
    item.type !== 'native-terminal' ||
    item.invocationId !== descriptor.invocationId ||
    item.nonce !== descriptor.nonce
  )
    throw new Error('Web check custody: native terminal belongs to another prepared invocation');
  const binding = validateBinding(item.binding);
  if (jsonSha256(binding) !== jsonSha256(descriptor.binding))
    throw new Error('Web check custody: native binding differs from preparation');
  const physical = validatePhysical(item.physical);
  const receipt = closed(
    item.receipt,
    ['schema', 'host', 'run', 'exitCode', 'lifetimeFailure', 'resources'],
    'native physical receipt',
  );
  if (
    receipt.schema !== 1 ||
    receipt.host !== physical.host ||
    receipt.run !== physical.run ||
    !Number.isInteger(receipt.exitCode) ||
    (receipt.exitCode as number) < 0 ||
    (receipt.exitCode as number) > 255
  )
    throw new Error('Web check custody: native receipt does not match its physical run');
  const lifetimeFailure = validateLifetimeFailure(
    receipt.lifetimeFailure,
    physical.host,
    physical.run,
    receipt.exitCode as number,
  );
  const resources = validateResources(receipt.resources, physical.host, physical.run);
  return {
    schema: 1,
    type: 'native-terminal',
    invocationId: descriptor.invocationId,
    nonce: descriptor.nonce,
    binding,
    physical,
    receipt: {
      schema: 1,
      host: physical.host,
      run: physical.run,
      exitCode: receipt.exitCode as number,
      lifetimeFailure,
      resources,
    },
  };
}

function validatePath(value: unknown, label: string, max = 1024): string {
  const path = text(value, label, max);
  if (
    !path ||
    path.startsWith('/') ||
    /^[A-Za-z]:/.test(path) ||
    /[\\\0\r\n]/.test(path) ||
    path.split('/').some((part) => ['', '.', '..'].includes(part))
  )
    throw new Error(`Web check custody: invalid ${label}`);
  return path;
}

function validateStringList(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length > 64) throw new Error(`Web check custody: invalid ${label} list`);
  return value.map((item) => text(item, label));
}

function validateFinalSettlement(
  value: unknown,
  descriptor: PreparedCheckRunDescriptor,
  native: NativeTerminal,
  expected: ExpectedInvocation,
): FinalSettlement {
  const item = closed(
    value,
    [
      'schema',
      'type',
      'invocationId',
      'nonce',
      'binding',
      'physical',
      'native',
      'preparedInputs',
      'returns',
      'cleanup',
      'failures',
    ],
    'final settlement message',
  );
  if (
    item.schema !== 1 ||
    item.type !== 'final-settlement' ||
    item.invocationId !== descriptor.invocationId ||
    item.nonce !== descriptor.nonce
  )
    throw new Error('Web check custody: final belongs to another prepared invocation');
  const binding = validateBinding(item.binding);
  if (jsonSha256(binding) !== jsonSha256(descriptor.binding))
    throw new Error('Web check custody: final binding differs from preparation');
  const physical = validatePhysical(item.physical);
  if (physical.host !== native.physical.host || physical.run !== native.physical.run)
    throw new Error('Web check custody: final names a different physical run');
  const nativeValue = closed(item.native, ['exitCode', 'lifetimeFailure', 'receiptSha256'], 'final native disposition');
  const finalNativeDisposition: NativeDisposition = {
    exitCode: count(nativeValue.exitCode, 'native exit code', 255),
    lifetimeFailure: nativeValue.lifetimeFailure === true,
    receiptSha256: hash(nativeValue.receiptSha256, 'native receipt digest'),
  };
  const receiptDigest = nativeDisposition(native).receiptSha256;
  if (
    finalNativeDisposition.exitCode !== native.receipt.exitCode ||
    finalNativeDisposition.lifetimeFailure !== (native.receipt.lifetimeFailure !== null) ||
    finalNativeDisposition.receiptSha256 !== receiptDigest
  )
    throw new Error('Web check custody: final native result differs from the original terminal receipt');

  const prepared = closed(
    item.preparedInputs,
    ['status', 'sourceSha256', 'manifestSha256', 'fileCount', 'totalBytes'],
    'prepared source evidence',
  );
  if (!['verified', 'unavailable'].includes(String(prepared.status)))
    throw new Error('Web check custody: invalid prepared source status');
  const preparedInputs = {
    status: prepared.status as 'verified' | 'unavailable',
    sourceSha256: prepared.sourceSha256 === null ? null : hash(prepared.sourceSha256, 'prepared source hash'),
    manifestSha256: prepared.manifestSha256 === null ? null : hash(prepared.manifestSha256, 'prepared manifest hash'),
    fileCount: count(prepared.fileCount, 'prepared input count', 50_000),
    totalBytes: count(prepared.totalBytes, 'prepared input size', 1024 * 1024 * 1024),
  };
  if (preparedInputs.status === 'verified' && (!preparedInputs.sourceSha256 || !preparedInputs.manifestSha256))
    throw new Error('Web check custody: verified source evidence is incomplete');
  if (preparedInputs.status === 'unavailable' && (preparedInputs.sourceSha256 || preparedInputs.manifestSha256))
    throw new Error('Web check custody: unavailable source evidence contains hashes');

  const rawReturns = closed(
    item.returns,
    ['status', 'declarationsSha256', 'entries', 'missing', 'failures'],
    'return evidence',
  );
  if (!['empty', 'restored', 'missing', 'failed', 'unknown'].includes(String(rawReturns.status)))
    throw new Error('Web check custody: invalid return status');
  const entriesValue = rawReturns.entries;
  if (!Array.isArray(entriesValue) || entriesValue.length > 64)
    throw new Error('Web check custody: invalid returned files');
  const entries = entriesValue.map((entry) => {
    const artifact = closed(entry, ['path', 'size', 'sha256'], 'returned file');
    return {
      path: validatePath(artifact.path, 'returned file path'),
      size: count(artifact.size, 'returned file size', 256 * 1024 * 1024),
      sha256: hash(artifact.sha256, 'returned file hash'),
    };
  });
  if (
    new Set(entries.map((entry) => entry.path)).size !== entries.length ||
    entries.reduce((sum, entry) => sum + entry.size, 0) > 256 * 1024 * 1024
  )
    throw new Error('Web check custody: duplicate or oversized returned file evidence');
  if (!Array.isArray(rawReturns.missing)) throw new Error('Web check custody: invalid missing return paths');
  const missing = rawReturns.missing.map((path) => validatePath(path, 'missing return path'));
  const returnFailures = validateStringList(rawReturns.failures, 'return failure');
  const returns = {
    status: rawReturns.status as FinalSettlement['returns']['status'],
    declarationsSha256: hash(rawReturns.declarationsSha256, 'return declaration hash'),
    entries,
    missing,
    failures: returnFailures,
  };
  if (
    returns.declarationsSha256 !== descriptor.binding.returnsSha256 ||
    returns.declarationsSha256 !== expected.returnsSha256
  )
    throw new Error('Web check custody: return declarations differ from the prepared caller request');
  if (
    (expected.returns.length === 0 && returns.status !== 'empty') ||
    (expected.returns.length > 0 && returns.status !== 'restored')
  )
    throw new Error('Web check custody: final return status differs from the caller declarations');
  const withinDeclaration = (path: string) =>
    expected.returns.some((declared) => path === declared || path.startsWith(`${declared}/`));
  if (entries.some((entry) => !withinDeclaration(entry.path)) || missing.some((path) => !withinDeclaration(path)))
    throw new Error('Web check custody: return evidence escapes its declarations');

  const rawCleanup = closed(
    item.cleanup,
    ['disposition', 'remote', 'transportChild', 'source', 'localWorktree', 'failures'],
    'cleanup evidence',
  );
  if (
    !['settled', 'unknown'].includes(String(rawCleanup.disposition)) ||
    !['verified', 'failed', 'unknown'].includes(String(rawCleanup.remote)) ||
    !['reaped', 'unknown'].includes(String(rawCleanup.transportChild)) ||
    !['verified', 'changed', 'unknown'].includes(String(rawCleanup.source)) ||
    !['removed', 'retained', 'unknown'].includes(String(rawCleanup.localWorktree))
  )
    throw new Error('Web check custody: invalid cleanup disposition');
  const cleanup = {
    disposition: rawCleanup.disposition as FinalSettlement['cleanup']['disposition'],
    remote: rawCleanup.remote as FinalSettlement['cleanup']['remote'],
    transportChild: rawCleanup.transportChild as FinalSettlement['cleanup']['transportChild'],
    source: rawCleanup.source as FinalSettlement['cleanup']['source'],
    localWorktree: rawCleanup.localWorktree as FinalSettlement['cleanup']['localWorktree'],
    failures: validateStringList(rawCleanup.failures, 'cleanup failure'),
  };
  const rawFailures = closed(item.failures, ['primary', 'cleanup'], 'final failure groups');
  const failures = {
    primary: validateStringList(rawFailures.primary, 'primary failure'),
    cleanup: validateStringList(rawFailures.cleanup, 'final cleanup failure'),
  };
  return {
    schema: 1,
    type: 'final-settlement',
    invocationId: descriptor.invocationId,
    nonce: descriptor.nonce,
    binding,
    physical,
    native: finalNativeDisposition,
    preparedInputs,
    returns,
    cleanup,
    failures,
  };
}

function hashEnvironment(values: Record<string, string>, priority: string | null): string {
  return jsonSha256({ values: Object.entries(values).sort(([left], [right]) => left.localeCompare(right)), priority });
}

function expectedInvocation(input: {
  driverRoot: string;
  hostsFile: string;
  workspace: string;
  cwd: string;
  sourceRevision: string;
  command: readonly string[];
  environment: Record<string, string>;
  priority: string | null;
  returns: readonly string[];
}): ExpectedInvocation {
  const hostStats = lstatSync(input.hostsFile);
  if (!hostStats.isFile() || hostStats.isSymbolicLink())
    throw new Error('Web check custody: hosts file is not a regular file');
  const hostHash = sha256(readFileSync(input.hostsFile));
  const returns = [...new Set(input.returns)];
  const environmentHash = hashEnvironment(input.environment, input.priority);
  return {
    driverRoot: resolve(input.driverRoot),
    hostsFile: resolve(input.hostsFile),
    workspace: resolve(input.workspace),
    cwd: input.cwd,
    sourceRevision: input.sourceRevision,
    commandSha256: jsonSha256([...input.command]),
    semanticEnvironmentSha256: environmentHash,
    // Web's absolute path settings are relocated before the private environment file is written.
    relocatedEnvironmentSha256: environmentHash,
    returns,
    returnsSha256: jsonSha256(returns),
  };
}

function validatePreparedBinding(descriptor: PreparedCheckRunDescriptor, expected: ExpectedInvocation): void {
  const binding = descriptor.binding;
  if (
    binding.sourceRevision !== expected.sourceRevision ||
    binding.cwd !== expected.cwd ||
    binding.argvSha256 !== expected.commandSha256 ||
    binding.semanticEnvironmentSha256 !== expected.semanticEnvironmentSha256 ||
    binding.relocatedEnvironmentSha256 !== expected.relocatedEnvironmentSha256 ||
    binding.hostsSha256 !== sha256(readFileSync(expected.hostsFile)) ||
    binding.returnsSha256 !== expected.returnsSha256
  )
    throw new Error('Web check custody: prepared binding differs from the prior Web request');
}

function readPreparedFile(
  files: WebCheckPrivateFiles,
  expected: ExpectedInvocation,
): { descriptor: PreparedCheckRunDescriptor; raw: Buffer } {
  const stat = lstatSync(files.descriptorFile);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_DESCRIPTOR_BYTES || (stat.mode & 0o077) !== 0)
    throw new Error('Web check custody: prepared descriptor is not a private bounded file');
  const parent = resolve(dirname(files.descriptorFile));
  if (realpathSync(parent) !== parent) throw new Error('Web check custody: descriptor parent is not canonical');
  const raw = readFileSync(files.descriptorFile);
  const contents = raw.toString('utf8');
  if (!contents.endsWith('\n') || contents.includes('\r') || contents.split('\n').length !== 2)
    throw new Error('Web check custody: persisted descriptor is not one closed line');
  const descriptor = validateDescriptor(parseUniqueJson(contents.slice(0, -1)));
  validatePreparedBinding(descriptor, expected);
  return { descriptor, raw };
}

function validatePreparedFile(files: WebCheckPrivateFiles, expected: ExpectedInvocation): PreparedCheckRunDescriptor {
  return readPreparedFile(files, expected).descriptor;
}

function parsePreparedOutput(
  output: string,
  files: WebCheckPrivateFiles,
  expected: ExpectedInvocation,
): { descriptor: PreparedCheckRunDescriptor; raw: Buffer } {
  if (!output.endsWith('\n') || output.includes('\r') || output.split('\n').length !== 2)
    throw new Error('Web check custody: prepare did not return one closed descriptor line');
  const descriptor = validateDescriptor(parseUniqueJson(output.slice(0, -1)));
  validatePreparedBinding(descriptor, expected);
  const persisted = readPreparedFile(files, expected);
  const outputBytes = Buffer.from(output);
  if (!outputBytes.equals(persisted.raw))
    throw new Error('Web check custody: prepare output bytes differ from its persisted descriptor');
  return { descriptor, raw: outputBytes };
}

function assertPrivateFiles(files: WebCheckPrivateFiles, workspace: string): void {
  if (
    ![files.directory, files.environmentFile, files.descriptorFile, files.recordFile, files.evidenceFile].every(
      isAbsolute,
    )
  )
    throw new Error('Web check custody: private file paths must be absolute');
  const directory = resolve(files.directory);
  if (
    directory !== files.directory ||
    files.environmentFile !== join(directory, 'environment.json') ||
    files.descriptorFile !== join(directory, 'prepared-descriptor.json') ||
    files.recordFile !== join(directory, 'web-custody.json') ||
    files.evidenceFile !== join(directory, 'receipts.ndjson')
  )
    throw new Error('Web check custody: private file layout differs from the receiving contract');
  const candidate = realpathSync(workspace);
  const inside = relative(candidate, directory);
  if (inside === '' || (inside !== '..' && !inside.startsWith(`..${sep}`) && !isAbsolute(inside)))
    throw new Error('Web check custody: private descriptor must be outside candidate source');
  const stats = lstatSync(directory);
  if (
    !stats.isDirectory() ||
    stats.isSymbolicLink() ||
    (stats.mode & 0o077) !== 0 ||
    realpathSync(directory) !== directory ||
    (typeof process.getuid === 'function' && stats.uid !== process.getuid())
  )
    throw new Error('Web check custody: invocation directory is not owner-private');
  for (const [file, maxBytes, optional] of [
    [files.environmentFile, 1024 * 1024, true],
    [files.evidenceFile, MAX_NATIVE_BYTES + MAX_FINAL_BYTES, false],
  ] as const) {
    let fileStats: ReturnType<typeof lstatSync>;
    try {
      fileStats = lstatSync(file);
    } catch (error) {
      if (optional && (error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    if (
      !fileStats.isFile() ||
      fileStats.isSymbolicLink() ||
      (fileStats.mode & 0o077) !== 0 ||
      fileStats.size > maxBytes ||
      (typeof process.getuid === 'function' && fileStats.uid !== process.getuid())
    )
      throw new Error('Web check custody: environment/evidence input is not a private regular file');
  }
  for (const file of [files.descriptorFile, files.recordFile]) {
    try {
      const fileStats = lstatSync(file);
      if (
        !fileStats.isFile() ||
        fileStats.isSymbolicLink() ||
        (fileStats.mode & 0o077) !== 0 ||
        (typeof process.getuid === 'function' && fileStats.uid !== process.getuid())
      )
        throw new Error('Web check custody: retained descriptor or record is not a private regular file');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}

function writePrivate(path: string, contents: string, directory: string): void {
  if (Buffer.byteLength(contents) > MAX_RECORD_BYTES)
    throw new Error('Web check custody: private evidence exceeds its byte bound');
  const temporary = `${path}.${process.pid}.pending`;
  const descriptor = openSync(temporary, 'wx', PRIVATE_FILE_MODE);
  try {
    const bytes = Buffer.from(contents);
    let offset = 0;
    while (offset < bytes.length) offset += writeSync(descriptor, bytes, offset, bytes.length - offset);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  renameSync(temporary, path);
  const directoryHandle = openSync(directory, 'r');
  try {
    fsyncSync(directoryHandle);
  } finally {
    closeSync(directoryHandle);
  }
}

function appendPrivate(path: string, bytes: Uint8Array): void {
  const descriptor = openSync(path, 'a', PRIVATE_FILE_MODE);
  try {
    let offset = 0;
    while (offset < bytes.length) offset += writeSync(descriptor, bytes, offset, bytes.length - offset);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function persistRecord(files: WebCheckPrivateFiles, record: WebCustodyRecord): void {
  writePrivate(files.recordFile, `${JSON.stringify(record)}\n`, files.directory);
}

function emptyIngressMessage(): IngressMessage {
  return { state: 'absent', start: null, end: null, rawSha256: null, bodySha256: null, originalSha256: null };
}

function emptyReceiptIngress(): ReceiptIngress {
  return {
    streamBytes: 0,
    streamSha256: sha256(''),
    complete: true,
    native: emptyIngressMessage(),
    final: emptyIngressMessage(),
  };
}

function emptyProcessLifetime(): ProcessLifetime {
  return { state: 'not-started', code: null, signal: null, outputSha256: null, outputOverflow: false };
}

function removeEnvironmentInput(files: WebCheckPrivateFiles, record: WebCustodyRecord): boolean {
  try {
    disposeWebCheckEnvironmentInput(files);
    record.cleanup.environmentInput = 'removed';
    persistRecord(files, record);
    return true;
  } catch {
    record.cleanup.environmentInput = 'unknown';
    record.cleanup.state = 'unknown';
    record.cleanup.detail = 'private environment input disposal could not be verified';
    try {
      persistRecord(files, record);
    } catch {
      /* Keep original descriptor/evidence on disk. */
    }
    return false;
  }
}

/** Remove the private input after its last consuming caller closes, or while unwinding before dispatch. */
export function disposeWebCheckEnvironmentInput(files: WebCheckPrivateFiles): void {
  if (files.environmentFile !== join(resolve(files.directory), 'environment.json'))
    throw new Error('Web check custody: private environment path escaped its invocation directory');
  if (!directoryExists(files.directory)) return;
  try {
    const stat = lstatSync(files.environmentFile);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0)
      throw new Error('Web check custody: private environment input is not an owner-private regular file');
    unlinkSync(files.environmentFile);
    const directory = openSync(files.directory, 'r');
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
}

function processLifetime(result: WebCheckDriverProcess): ProcessLifetime {
  return {
    state: result.closed ? 'closed' : 'unknown',
    code: result.code,
    signal: result.signal,
    outputSha256: sha256(result.output),
    outputOverflow: result.outputOverflow,
  };
}

function registerPreparedInvocation(
  status: StatusRecord,
  descriptor: PreparedCheckRunDescriptor,
  files: WebCheckPrivateFiles,
  expected: ExpectedInvocation,
): RegisteredInvocation {
  const descriptorFile = readPreparedFile(files, expected);
  if (
    status.phase !== 'prepared' ||
    status.invocationId !== descriptor.invocationId ||
    status.nonce !== descriptor.nonce ||
    status.candidateWorkspace !== expected.workspace ||
    !status.snapshot ||
    status.snapshotCustody !== 'owned' ||
    status.physical !== null ||
    status.native !== null ||
    status.final !== null ||
    status.finalCustody !== null ||
    !status.preparedExecution ||
    !status.descriptor ||
    status.descriptor.file !== files.descriptorFile ||
    status.descriptor.sha256 !== sha256(descriptorFile.raw) ||
    JSON.stringify(status.binding) !== JSON.stringify(descriptor.binding) ||
    JSON.stringify(status.returns) !== JSON.stringify(expected.returns) ||
    status.snapshot.sourceSha256 !== descriptor.binding.sourceSha256
  )
    throw new Error('Web check custody: producer did not register the exact prepared snapshot before run-prepared');
  return {
    binding: status.binding,
    candidateWorkspace: status.candidateWorkspace,
    snapshot: status.snapshot,
    returns: status.returns,
    preparedExecution: status.preparedExecution,
    descriptor: status.descriptor,
    preparationIntent: status.preparationIntent,
  };
}

function commandForPrepare(input: {
  driverRoot: string;
  hostsFile: string;
  workspace: string;
  cwd: string;
  sourceRevision: string;
  environmentFile: string;
  descriptorFile: string;
  command: readonly string[];
  returns: readonly string[];
}): string[] {
  return [
    'bun',
    join(input.driverRoot, 'scripts/check-run.ts'),
    'prepare',
    '--descriptor',
    input.descriptorFile,
    '--hosts',
    input.hostsFile,
    '--workspace',
    input.workspace,
    '--cwd',
    input.cwd,
    '--source-revision',
    input.sourceRevision,
    '--env-file',
    input.environmentFile,
    ...input.returns.flatMap((path) => ['--returns', path]),
    '--',
    ...input.command,
  ];
}

function commandForRunPrepared(driverRoot: string, descriptorFile: string): string[] {
  return ['bun', join(driverRoot, 'scripts/check-run.ts'), 'run-prepared', '--descriptor', descriptorFile];
}

function commandForStatus(driverRoot: string, invocationId: string): string[] {
  return ['bun', join(driverRoot, 'scripts/check-run-settlement.ts'), 'status', invocationId];
}

function commandForReconcile(driverRoot: string, descriptorFile: string, hostsFile: string): string[] {
  return [
    'bun',
    join(driverRoot, 'scripts/check-run-settlement.ts'),
    'reconcile',
    '--descriptor',
    descriptorFile,
    '--hosts',
    hostsFile,
  ];
}

function baseEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (env.WEB_STORYBOOK_LOCAL_PUBLICATION_REVISION === undefined) return env;
  const output = { ...env };
  delete output.WEB_STORYBOOK_LOCAL_PUBLICATION_REVISION;
  return output;
}

function processEnvironmentForPrepared(
  env: NodeJS.ProcessEnv,
  descriptor: PreparedCheckRunDescriptor,
): NodeJS.ProcessEnv {
  return {
    ...baseEnvironment(env),
    REMOTE_CHECK_RECEIPT_FD: '3',
    REMOTE_CHECK_RECEIPT_NONCE: descriptor.nonce,
    REMOTE_CHECK_INVOCATION_ID: descriptor.invocationId,
  };
}

function parseSingleOutput(output: string, label: string): unknown {
  if (!output.endsWith('\n') || output.includes('\r') || output.split('\n').length !== 2)
    throw new Error(`Web check custody: ${label} did not return one record line`);
  return parseUniqueJson(output.slice(0, -1));
}

function validatePrivateReference(value: unknown, label: string): { file: string; sha256: string } | null {
  if (value === null) return null;
  const item = closed(value, ['file', 'sha256'], `${label} reference`);
  const file = text(item.file, `${label} path`, 4096);
  if (!isAbsolute(file) || resolve(file) !== file)
    throw new Error(`Web check custody: invalid ${label} reference path`);
  return { file, sha256: hash(item.sha256, `${label} reference hash`) };
}

function validTimestamp(value: unknown, label: string): string {
  const result = text(value, label, 64);
  if (!result || !Number.isFinite(Date.parse(result))) throw new Error(`Web check custody: invalid ${label}`);
  return result;
}

function validateCustodyObservation(
  value: unknown,
  descriptor: PreparedCheckRunDescriptor,
  expected: ExpectedInvocation,
  native: NativeTerminal | null,
): { value: Record<string, unknown>; rejected: boolean } {
  const item = closed(
    value,
    ['observedAt', 'disposition', 'transportIdentity', 'final', 'reason'],
    'custody observation',
  );
  const observedAt = validTimestamp(item.observedAt, 'custody observation time');
  if (!['unknown', 'settled', 'rejected'].includes(String(item.disposition)))
    throw new Error('Web check custody: invalid custody observation disposition');
  if (
    item.transportIdentity !== null &&
    !['live-same', 'gone-or-replaced', 'unknown'].includes(String(item.transportIdentity))
  )
    throw new Error('Web check custody: invalid custody transport identity');
  const rejected = item.disposition === 'rejected';
  let final: FinalSettlement | null = null;
  if (item.final !== null) {
    if (rejected) {
      if (!isObject(item.final)) throw new Error('Web check custody: rejected observation final is malformed');
    } else {
      final = validateFinalSettlement(item.final, descriptor, requireNative(native), expected);
    }
  }
  const reason = item.reason === null ? null : text(item.reason, 'custody observation reason');
  return {
    value: {
      observedAt,
      disposition: item.disposition,
      transportIdentity: item.transportIdentity,
      final: rejected ? item.final : final,
      reason,
    },
    rejected,
  };
}

function observationChainHash(previous: string | null, observation: Record<string, unknown>): string {
  return createHash('sha256')
    .update('check-run-final-custody-observations-v1\0')
    .update(previous ?? '')
    .update('\0')
    .update(JSON.stringify(observation))
    .digest('hex');
}

function validateFinalCustody(
  value: unknown,
  descriptor: PreparedCheckRunDescriptor,
  expected: ExpectedInvocation,
  native: NativeTerminal | null,
  physical: PhysicalIdentity | null,
  snapshot: StatusRecord['snapshot'],
  final: FinalSettlement | null,
  registered: RegisteredInvocation | null,
): { value: NonNullable<StatusRecord['finalCustody']>; rejectedObservation: boolean } {
  const item = closed(
    value,
    [
      'schema',
      'aggregate',
      'delivery',
      'deliverySha256',
      'privateFiles',
      'reconciliation',
      'originalFinalSha256',
      'identity',
      'observations',
      'continuation',
    ],
    'aggregate final custody',
  );
  if (item.schema !== 1 || !['pending', 'settled', 'unknown'].includes(String(item.aggregate)))
    throw new Error('Web check custody: invalid aggregate custody');
  if (!['not-required', 'pending', 'delivered', 'unknown', 'received', 'reconciled'].includes(String(item.delivery)))
    throw new Error('Web check custody: invalid final delivery state');
  if (
    !['pending', 'settled', 'unknown'].includes(String(item.privateFiles)) ||
    !['unknown', 'settled'].includes(String(item.reconciliation))
  )
    throw new Error('Web check custody: invalid private/reconciliation custody');
  const deliverySha256 = hash(item.deliverySha256, 'final delivery hash');
  const originalFinalSha256 = hash(item.originalFinalSha256, 'original final hash');
  const identityValue = closed(
    item.identity,
    [
      'sha256',
      'bindingSha256',
      'physical',
      'sourceSha256',
      'snapshotSha256',
      'candidateWorkspaceSha256',
      'returnsSha256',
      'preparedExecutionReferenceSha256',
      'descriptorReferenceSha256',
      'preparationIntentReferenceSha256',
    ],
    'final custody identity',
  );
  const identityPhysical = validatePhysical(identityValue.physical);
  const identityCore = {
    bindingSha256: hash(identityValue.bindingSha256, 'final binding digest'),
    physical: identityPhysical,
    sourceSha256: identityValue.sourceSha256 === null ? null : hash(identityValue.sourceSha256, 'final source digest'),
    snapshotSha256:
      identityValue.snapshotSha256 === null ? null : hash(identityValue.snapshotSha256, 'snapshot identity digest'),
    candidateWorkspaceSha256:
      identityValue.candidateWorkspaceSha256 === null
        ? null
        : hash(identityValue.candidateWorkspaceSha256, 'candidate workspace identity digest'),
    returnsSha256: hash(identityValue.returnsSha256, 'final returns digest'),
    preparedExecutionReferenceSha256:
      identityValue.preparedExecutionReferenceSha256 === null
        ? null
        : hash(identityValue.preparedExecutionReferenceSha256, 'prepared execution reference digest'),
    descriptorReferenceSha256:
      identityValue.descriptorReferenceSha256 === null
        ? null
        : hash(identityValue.descriptorReferenceSha256, 'prepared descriptor reference digest'),
    preparationIntentReferenceSha256:
      identityValue.preparationIntentReferenceSha256 === null
        ? null
        : hash(identityValue.preparationIntentReferenceSha256, 'preparation intent reference digest'),
  };
  if (
    hash(identityValue.sha256, 'final custody identity digest') !== jsonSha256(identityCore) ||
    identityCore.bindingSha256 !== bindingHash(descriptor.binding) ||
    identityCore.returnsSha256 !== descriptor.binding.returnsSha256 ||
    (physical && (identityPhysical.host !== physical.host || identityPhysical.run !== physical.run)) ||
    (snapshot && identityCore.snapshotSha256 !== jsonSha256(snapshot)) ||
    (snapshot && identityCore.sourceSha256 !== snapshot.sourceSha256) ||
    identityCore.candidateWorkspaceSha256 !== jsonSha256(expected.workspace) ||
    (registered !== null &&
      (identityCore.preparedExecutionReferenceSha256 !== privateReferenceSha256(registered.preparedExecution) ||
        identityCore.descriptorReferenceSha256 !== privateReferenceSha256(registered.descriptor) ||
        identityCore.preparationIntentReferenceSha256 !== privateReferenceSha256(registered.preparationIntent) ||
        identityCore.snapshotSha256 !== jsonSha256(registered.snapshot) ||
        identityCore.sourceSha256 !== registered.snapshot.sourceSha256 ||
        identityCore.candidateWorkspaceSha256 !== jsonSha256(registered.candidateWorkspace) ||
        identityCore.returnsSha256 !== jsonSha256(registered.returns)))
  )
    throw new Error('Web check custody: aggregate custody identity differs from the prepared invocation');
  if (final && originalFinalSha256 !== jsonSha256(final))
    throw new Error('Web check custody: aggregate custody does not bind its immutable final');
  if (!Array.isArray(item.observations) || item.observations.length > 16)
    throw new Error('Web check custody: invalid custody observations');
  const observations = item.observations.map((observation) =>
    validateCustodyObservation(observation, descriptor, expected, native),
  );
  let rejectedObservation = observations.some((observation) => observation.rejected);
  let continuation: CheckRunFinalCustody['continuation'] = null;
  if (item.continuation !== null) {
    const raw = closed(item.continuation, ['count', 'sha256', 'first', 'latest'], 'custody observation continuation');
    const countValue = count(raw.count, 'custody continuation count');
    if (countValue < 1 || observations.length !== 16)
      throw new Error('Web check custody: invalid custody continuation');
    const digest = hash(raw.sha256, 'custody continuation digest');
    const first = validateCustodyObservation(raw.first, descriptor, expected, native);
    const latest = validateCustodyObservation(raw.latest, descriptor, expected, native);
    rejectedObservation ||= first.rejected || latest.rejected;
    if (
      countValue === 1 &&
      (JSON.stringify(first.value) !== JSON.stringify(latest.value) ||
        digest !== observationChainHash(null, first.value))
    )
      throw new Error('Web check custody: invalid initial custody continuation');
    continuation = {
      count: countValue,
      sha256: digest,
      first: first.value as CheckRunFinalCustody['observations'][number],
      latest: latest.value as CheckRunFinalCustody['observations'][number],
    };
  }
  const unknown = item.delivery === 'unknown' || item.privateFiles === 'unknown' || item.reconciliation === 'unknown';
  const pending = item.delivery === 'pending' || item.privateFiles === 'pending';
  const aggregate = unknown ? 'unknown' : pending ? 'pending' : 'settled';
  if (item.aggregate !== aggregate) throw new Error('Web check custody: aggregate final custody is inconsistent');
  return {
    value: {
      schema: 1,
      aggregate,
      delivery: item.delivery as NonNullable<StatusRecord['finalCustody']>['delivery'],
      deliverySha256,
      privateFiles: item.privateFiles as NonNullable<StatusRecord['finalCustody']>['privateFiles'],
      reconciliation: item.reconciliation as NonNullable<StatusRecord['finalCustody']>['reconciliation'],
      originalFinalSha256,
      identity: { sha256: hash(identityValue.sha256, 'final custody identity digest'), ...identityCore },
      observations: observations.map(
        (observation) => observation.value as CheckRunFinalCustody['observations'][number],
      ),
      continuation,
    },
    rejectedObservation,
  };
}

function validateStatusRecord(
  value: unknown,
  descriptor: PreparedCheckRunDescriptor,
  expected: ExpectedInvocation,
  originalNative: NativeTerminal | null,
  registered: RegisteredInvocation | null = null,
): StatusRecord {
  const item = closed(
    value,
    [
      'schema',
      'invocationId',
      'nonce',
      'createdAt',
      'updatedAt',
      'phase',
      'binding',
      'physical',
      'transportChild',
      'native',
      'snapshot',
      'candidateWorkspace',
      'preparedExecution',
      'descriptor',
      'preparationIntent',
      'snapshotCustody',
      'returns',
      'cancellation',
      'final',
      'finalCustody',
      'failure',
    ],
    'registered invocation status',
  );
  if (
    item.schema !== 1 ||
    item.invocationId !== descriptor.invocationId ||
    item.nonce !== descriptor.nonce ||
    ![
      'registered',
      'prepared',
      'claimed',
      'queued',
      'uploading',
      'running',
      'native-terminal',
      'settled',
      'unknown',
      'cancel-requested',
      'cancelled',
    ].includes(String(item.phase))
  )
    throw new Error('Web check custody: status belongs to another invocation');
  validTimestamp(item.createdAt, 'status creation time');
  validTimestamp(item.updatedAt, 'status update time');
  const binding = validateBinding(item.binding);
  if (jsonSha256(binding) !== jsonSha256(descriptor.binding))
    throw new Error('Web check custody: status binding differs from original preparation');
  if (!Array.isArray(item.returns) || JSON.stringify(item.returns) !== JSON.stringify(expected.returns))
    throw new Error('Web check custody: registered returns differ from original declarations');
  const physical = item.physical === null ? null : validatePhysical(item.physical);
  const native = item.native === null ? null : validateNativeDisposition(item.native);
  const snapshot = item.snapshot === null ? null : validateSnapshot(item.snapshot, binding);
  const candidateWorkspace =
    item.candidateWorkspace === null ? null : text(item.candidateWorkspace, 'candidate workspace', 4096);
  if (candidateWorkspace !== null && resolve(candidateWorkspace) !== expected.workspace)
    throw new Error('Web check custody: registered candidate workspace differs from the Web request');
  const preparedExecution = validatePrivateReference(item.preparedExecution, 'prepared execution');
  const descriptorReference = validatePrivateReference(item.descriptor, 'prepared descriptor');
  const preparationIntent = validatePrivateReference(item.preparationIntent, 'preparation intent');
  if (
    registered &&
    (candidateWorkspace !== registered.candidateWorkspace ||
      JSON.stringify(snapshot) !== JSON.stringify(registered.snapshot) ||
      JSON.stringify(item.returns) !== JSON.stringify(registered.returns) ||
      (preparedExecution !== null &&
        JSON.stringify(preparedExecution) !== JSON.stringify(registered.preparedExecution)) ||
      (descriptorReference !== null && JSON.stringify(descriptorReference) !== JSON.stringify(registered.descriptor)) ||
      (preparationIntent !== null &&
        JSON.stringify(preparationIntent) !== JSON.stringify(registered.preparationIntent)))
  )
    throw new Error('Web check custody: producer status changed the original prepared registration');
  if (item.transportChild !== null) {
    const child = closed(item.transportChild, ['pid', 'bootId', 'start'], 'transport child identity');
    count(child.pid, 'transport child pid', 2 ** 31 - 1);
    text(child.bootId, 'transport child boot id', 128);
    text(child.start, 'transport child start time', 64);
  }
  const cancellation = closed(item.cancellation, ['requested', 'signal'], 'cancellation status');
  if (
    typeof cancellation.requested !== 'boolean' ||
    (cancellation.signal !== null &&
      (typeof cancellation.signal !== 'number' || ![1, 2, 15].includes(cancellation.signal)))
  )
    throw new Error('Web check custody: invalid registered cancellation status');
  const snapshotCustody = item.snapshotCustody;
  if (snapshotCustody !== null && !['owned', 'removed', 'unknown'].includes(String(snapshotCustody)))
    throw new Error('Web check custody: invalid snapshot custody');
  const final =
    item.final === null
      ? null
      : validateFinalSettlement(item.final, descriptor, requireNative(originalNative), expected);
  const rawFinalCustody =
    item.finalCustody === null
      ? null
      : validateFinalCustody(
          item.finalCustody,
          descriptor,
          expected,
          originalNative,
          physical,
          snapshot,
          final,
          registered,
        );
  const finalCustody = rawFinalCustody?.value ?? null;
  if (item.failure !== null) text(item.failure, 'registered failure', 1024);
  if (physical && final && (physical.host !== final.physical.host || physical.run !== final.physical.run))
    throw new Error('Web check custody: status final differs from original physical run');
  if (native && originalNative && JSON.stringify(native) !== JSON.stringify(nativeDisposition(originalNative)))
    throw new Error('Web check custody: status native terminal differs from the original FD 3 receipt');
  if (native && final && JSON.stringify(native) !== JSON.stringify(final.native))
    throw new Error('Web check custody: status native terminal differs from original final');
  if (snapshot && final && snapshot.sourceSha256 !== final.preparedInputs.sourceSha256)
    throw new Error('Web check custody: status snapshot source differs from final evidence');
  if (final && !finalCustody) throw new Error('Web check custody: final status has no aggregate custody record');
  return {
    invocationId: descriptor.invocationId,
    nonce: descriptor.nonce,
    phase: item.phase as string,
    binding,
    physical,
    native,
    returns: item.returns as string[],
    candidateWorkspace,
    preparedExecution,
    descriptor: descriptorReference,
    preparationIntent,
    snapshot,
    snapshotCustody: snapshotCustody as StatusRecord['snapshotCustody'],
    cancellation: {
      requested: cancellation.requested,
      signal: cancellation.signal as 1 | 2 | 15 | null,
    },
    final,
    rejectedObservation: rawFinalCustody?.rejectedObservation ?? false,
    finalCustody,
  };
}

function validateNativeDisposition(value: unknown): NativeDisposition {
  const item = closed(value, ['exitCode', 'lifetimeFailure', 'receiptSha256'], 'registered native disposition');
  if (typeof item.lifetimeFailure !== 'boolean')
    throw new Error('Web check custody: invalid registered lifetime evidence');
  return {
    exitCode: count(item.exitCode, 'registered native exit code', 255),
    lifetimeFailure: item.lifetimeFailure,
    receiptSha256: hash(item.receiptSha256, 'registered native receipt hash'),
  };
}

function validateSnapshot(value: unknown, binding: CheckRunBinding): StatusRecord['snapshot'] {
  const item = closed(value, ['workspace', 'scratch', 'sourceSha256', 'inputFiles'], 'registered snapshot');
  const sourceSha256 = hash(item.sourceSha256, 'registered snapshot source');
  if (
    sourceSha256 !== binding.sourceSha256 ||
    typeof item.workspace !== 'string' ||
    !isAbsolute(item.workspace) ||
    resolve(item.workspace) !== item.workspace ||
    typeof item.scratch !== 'string' ||
    !isAbsolute(item.scratch) ||
    resolve(item.scratch) !== item.scratch ||
    !Array.isArray(item.inputFiles) ||
    item.inputFiles.length > 50_000
  )
    throw new Error('Web check custody: registered snapshot differs from its prepared source');
  return {
    workspace: text(item.workspace, 'snapshot workspace', 4096),
    scratch: text(item.scratch, 'snapshot scratch', 4096),
    sourceSha256,
    inputFiles: item.inputFiles.map((path) => validatePath(path, 'snapshot input', 4096)),
  };
}

function requireNative(native: NativeTerminal | null): NativeTerminal {
  if (!native) throw new Error('Web check custody: status final has no original native receipt');
  return native;
}

function bindingHash(binding: CheckRunBinding): string {
  return checkRunBindingHash(binding);
}

function finalCustodySettled(
  status: StatusRecord,
  final: FinalSettlement,
  receivedFinalRaw: Uint8Array | null,
  registered: RegisteredInvocation,
): boolean {
  const custody = status.finalCustody;
  if (
    status.phase !== 'settled' ||
    status.snapshotCustody !== 'removed' ||
    !status.physical ||
    !status.native ||
    !status.snapshot ||
    status.rejectedObservation ||
    !custody ||
    !status.final ||
    jsonSha256(status.final) !== jsonSha256(final) ||
    custody.aggregate !== 'settled' ||
    custody.privateFiles !== 'settled' ||
    custody.reconciliation !== 'settled' ||
    custody.originalFinalSha256 !== jsonSha256(final) ||
    status.physical.host !== final.physical.host ||
    status.physical.run !== final.physical.run ||
    status.native.exitCode !== final.native.exitCode ||
    status.native.lifetimeFailure !== final.native.lifetimeFailure ||
    status.native.receiptSha256 !== final.native.receiptSha256 ||
    status.snapshot.sourceSha256 !== final.preparedInputs.sourceSha256 ||
    final.returns.declarationsSha256 !== status.binding.returnsSha256
  )
    return false;
  if (receivedFinalRaw) {
    const body = Buffer.from(receivedFinalRaw);
    const encodedBody = body.length && body[body.length - 1] === 0x0a ? body.subarray(0, -1) : body;
    if (
      !['delivered', 'received'].includes(custody.delivery) ||
      custody.deliverySha256 !== sha256(encodedBody) ||
      custody.identity.preparedExecutionReferenceSha256 !== privateReferenceSha256(registered.preparedExecution) ||
      custody.identity.descriptorReferenceSha256 !== privateReferenceSha256(registered.descriptor) ||
      custody.identity.preparationIntentReferenceSha256 !== privateReferenceSha256(registered.preparationIntent)
    )
      return false;
  } else if (custody.delivery !== 'reconciled') return false;
  return (
    final.cleanup.disposition === 'settled' &&
    final.cleanup.remote === 'verified' &&
    final.cleanup.transportChild === 'reaped' &&
    final.cleanup.source === 'verified' &&
    final.cleanup.localWorktree === 'removed' &&
    final.cleanup.failures.length === 0 &&
    final.failures.primary.length === 0 &&
    final.failures.cleanup.length === 0 &&
    final.preparedInputs.status === 'verified' &&
    final.preparedInputs.sourceSha256 === final.binding.sourceSha256 &&
    ((status.returns.length === 0 && final.returns.status === 'empty') ||
      (status.returns.length > 0 && final.returns.status === 'restored')) &&
    final.returns.missing.length === 0 &&
    final.returns.failures.length === 0
  );
}

function validateStatusAgainstOriginal(
  status: StatusRecord,
  descriptor: PreparedCheckRunDescriptor,
  expected: ExpectedInvocation,
  native: NativeTerminal | null,
  registered: RegisteredInvocation,
): FinalSettlement | null {
  if (
    status.physical &&
    native &&
    (status.physical.host !== native.physical.host || status.physical.run !== native.physical.run)
  )
    throw new Error('Web check custody: status names a replacement physical run');
  if (status.native && native) {
    const expectedNative = nativeDisposition(native);
    if (JSON.stringify(status.native) !== JSON.stringify(expectedNative))
      throw new Error('Web check custody: status native receipt differs from original FD 3 evidence');
  }
  if (native && (!status.physical || !status.native))
    throw new Error('Web check custody: status lacks original physical/native terminal evidence');
  if (!status.final) return null;
  if (!native) throw new Error('Web check custody: final status has no received original native receipt');
  const final = validateFinalSettlement(status.final, descriptor, native, expected);
  if (status.finalCustody?.originalFinalSha256 !== jsonSha256(final))
    throw new Error('Web check custody: retained final digest differs from original final');
  if (
    JSON.stringify(status.snapshot) !== JSON.stringify(registered.snapshot) ||
    status.candidateWorkspace !== registered.candidateWorkspace
  )
    throw new Error('Web check custody: final status changed the original snapshot or candidate');
  return final;
}

function nativeDisposition(native: NativeTerminal): NativeDisposition {
  return {
    exitCode: native.receipt.exitCode,
    lifetimeFailure: native.receipt.lifetimeFailure !== null,
    receiptSha256: checkRunNativeReceiptDigest(native.receipt as CheckRunNativeTerminalMessage['receipt']),
  };
}

function validateRecovery(
  value: unknown,
  descriptor: PreparedCheckRunDescriptor | null,
  expected: ExpectedInvocation,
  native: NativeTerminal | null,
  registered: RegisteredInvocation | null,
): { status: StatusRecord | null; cleanedPreparation: boolean } {
  if (isObject(value) && value.type === 'check-run-preparation-reconciliation') {
    const preparation = closed(
      value,
      ['schema', 'type', 'invocationId', 'snapshotCustody', 'preparationIntent'],
      'pre-exposure preparation reconciliation',
    );
    if (
      preparation.schema !== 1 ||
      typeof preparation.invocationId !== 'string' ||
      !UUID.test(preparation.invocationId) ||
      (descriptor !== null && preparation.invocationId.toLowerCase() !== descriptor.invocationId) ||
      preparation.snapshotCustody !== 'removed' ||
      preparation.preparationIntent !== 'removed'
    )
      throw new Error('Web check custody: preparation reconciliation did not verify disposal');
    return { status: null, cleanedPreparation: true };
  }
  if (!descriptor) throw new Error('Web check custody: original descriptor is unavailable for reconciliation');
  const status = validateStatusRecord(value, descriptor, expected, native, registered);
  if (native && !status.native) throw new Error('Web check custody: reconciliation lacks the original native terminal');
  return { status, cleanedPreparation: false };
}

class FinalWireReceiver {
  #buffer = Buffer.alloc(0);
  #totalBytes = 0;
  #processedBytes = 0;
  #chunks = 0;
  #native: NativeTerminal | null = null;
  #final: FinalSettlement | null = null;
  #finalRaw: Buffer | null = null;
  #invalid = false;

  constructor(
    private readonly descriptor: PreparedCheckRunDescriptor,
    private readonly expected: ExpectedInvocation,
    private readonly record: WebCustodyRecord,
    private readonly files: WebCheckPrivateFiles,
  ) {}

  accept(chunk: Uint8Array): void {
    this.#chunks += 1;
    this.#totalBytes += chunk.byteLength;
    if (this.#chunks > MAX_RECEIPT_CHUNKS || this.#totalBytes > MAX_NATIVE_BYTES + MAX_FINAL_BYTES) {
      this.#invalid = true;
      this.record.rejectedEvidence = true;
      this.record.ingress.complete = false;
      return;
    }
    const bytes = Buffer.from(chunk);
    try {
      appendPrivate(this.files.evidenceFile, bytes);
      this.#buffer = Buffer.concat([this.#buffer, bytes]);
      const durable = readFileSync(this.files.evidenceFile);
      this.record.ingress.streamBytes = durable.length;
      this.record.ingress.streamSha256 = sha256(durable);
      persistRecord(this.files, this.record);
    } catch {
      this.#invalid = true;
      this.record.rejectedEvidence = true;
      this.record.ingress.complete = false;
      return;
    }
    while (true) {
      const newline = this.#buffer.indexOf(0x0a);
      if (newline < 0) break;
      const raw = this.#buffer.subarray(0, newline + 1);
      this.#buffer = this.#buffer.subarray(newline + 1);
      const start = this.#processedBytes;
      this.#processedBytes += raw.length;
      this.#acceptLine(raw, start);
    }
  }

  #acceptLine(raw: Buffer, start: number): void {
    if (this.#invalid) return;
    try {
      const decoded = decodeCheckRunMessage(new TextDecoder('utf-8', { fatal: true }).decode(raw), {
        invocationId: this.descriptor.invocationId,
        nonce: this.descriptor.nonce,
        binding: this.descriptor.binding,
        nativeTerminalSeen: this.#native !== null,
        ...(this.#native ? { nativeTerminal: nativeDisposition(this.#native) } : {}),
      });
      if (decoded.type === 'native-terminal') {
        if (raw.length > MAX_NATIVE_BYTES || this.#native || this.#final)
          throw new Error('Web check custody: duplicate, oversized or out-of-order native terminal');
        this.#native = validateNativeTerminal(decoded, this.descriptor);
        this.record.native = this.#native;
        this.record.ingress.native = {
          state: 'received',
          start,
          end: start + raw.length,
          rawSha256: sha256(raw),
          bodySha256: sha256(raw.subarray(0, -1)),
          originalSha256: jsonSha256(this.#native),
        };
        persistRecord(this.files, this.record);
        return;
      }
      if (decoded.type === 'final-settlement') {
        if (raw.length > MAX_FINAL_BYTES) throw new Error('Web check custody: oversized final settlement');
        if (!this.#native || this.#final) throw new Error('missing native terminal or duplicate final settlement');
        this.#final = validateFinalSettlement(decoded, this.descriptor, this.#native, this.expected);
        this.#finalRaw = Buffer.from(raw);
        this.record.final = this.#final;
        this.record.ingress.final = {
          state: 'received',
          start,
          end: start + raw.length,
          rawSha256: sha256(raw),
          bodySha256: sha256(raw.subarray(0, -1)),
          originalSha256: jsonSha256(this.#final),
        };
        this.record.validation.source = this.#final.preparedInputs.status === 'verified' ? 'verified' : 'rejected';
        this.record.validation.returns =
          ['empty', 'restored'].includes(this.#final.returns.status) &&
          this.#final.returns.missing.length === 0 &&
          this.#final.returns.failures.length === 0
            ? 'verified'
            : 'rejected';
        persistRecord(this.files, this.record);
        return;
      }
      throw new Error('Web check custody: unsupported FD 3 message type');
    } catch {
      this.#invalid = true;
      this.record.rejectedEvidence = true;
      const rejected = {
        state: 'rejected' as const,
        start,
        end: start + raw.length,
        rawSha256: sha256(raw),
        bodySha256: raw.length ? sha256(raw.subarray(0, -1)) : sha256(''),
        originalSha256: null,
      };
      if (!this.record.native) this.record.ingress.native = rejected;
      else this.record.ingress.final = rejected;
      try {
        persistRecord(this.files, this.record);
      } catch {
        // The retained descriptor and append-only wire evidence still prevent automatic cleanup.
      }
    }
  }

  finish(): {
    native: NativeTerminal | null;
    final: FinalSettlement | null;
    finalRaw: Buffer | null;
    invalid: boolean;
  } {
    this.record.ingress.complete = this.record.ingress.complete && this.#buffer.length === 0;
    if (this.#buffer.length !== 0) this.record.ingress.streamBytes = this.#totalBytes;
    if (this.#invalid) {
      this.record.rejectedEvidence = true;
      try {
        persistRecord(this.files, this.record);
      } catch {
        // Preserve the private directory even when its journal cannot be refreshed.
      }
    }
    try {
      const durable = readFileSync(this.files.evidenceFile);
      this.record.ingress.streamBytes = durable.length;
      this.record.ingress.streamSha256 = sha256(durable);
      persistRecord(this.files, this.record);
    } catch {
      this.record.rejectedEvidence = true;
    }
    return { native: this.#native, final: this.#final, finalRaw: this.#finalRaw, invalid: this.#invalid };
  }
}

function replayRetainedEvidence(
  files: WebCheckPrivateFiles,
  record: WebCustodyRecord,
): { invalid: boolean; native: NativeTerminal | null; final: FinalSettlement | null; finalRaw: Buffer | null } {
  const raw = readFileSync(files.evidenceFile);
  if (raw.length > MAX_NATIVE_BYTES + MAX_FINAL_BYTES)
    return { invalid: true, native: null, final: null, finalRaw: null };
  const descriptor = record.descriptor ?? descriptorFromRetainedFile(files.descriptorFile, record.expected);
  if (!descriptor) return { invalid: raw.length > 0, native: null, final: null, finalRaw: null };
  let offset = 0;
  let native: NativeTerminal | null = null;
  let final: FinalSettlement | null = null;
  let finalRaw: Buffer | null = null;
  let invalid = false;
  while (offset < raw.length) {
    const newline = raw.indexOf(0x0a, offset);
    if (newline < 0) break;
    const line = raw.subarray(offset, newline + 1);
    const start = offset;
    offset = newline + 1;
    try {
      const decoded = decodeCheckRunMessage(new TextDecoder('utf-8', { fatal: true }).decode(line), {
        invocationId: descriptor.invocationId,
        nonce: descriptor.nonce,
        binding: descriptor.binding,
        nativeTerminalSeen: native !== null,
        ...(native ? { nativeTerminal: nativeDisposition(native) } : {}),
      });
      if (decoded.type === 'native-terminal') {
        if (line.length > MAX_NATIVE_BYTES || native || final) throw new Error('duplicate native evidence');
        native = validateNativeTerminal(decoded, descriptor);
        record.ingress.native = {
          state: 'received',
          start,
          end: offset,
          rawSha256: sha256(line),
          bodySha256: sha256(line.subarray(0, -1)),
          originalSha256: jsonSha256(native),
        };
      } else {
        if (line.length > MAX_FINAL_BYTES || !native || final) throw new Error('duplicate final evidence');
        final = validateFinalSettlement(decoded, descriptor, native, record.expected);
        finalRaw = Buffer.from(line);
        record.ingress.final = {
          state: 'received',
          start,
          end: offset,
          rawSha256: sha256(line),
          bodySha256: sha256(line.subarray(0, -1)),
          originalSha256: jsonSha256(final),
        };
      }
    } catch {
      invalid = true;
      break;
    }
  }
  record.ingress.complete = record.ingress.complete && offset === raw.length;
  record.ingress.streamBytes = raw.length;
  record.ingress.streamSha256 = sha256(raw);
  if (invalid || (record.native && (!native || jsonSha256(native) !== jsonSha256(record.native)))) {
    record.rejectedEvidence = true;
    return { invalid: true, native, final, finalRaw };
  }
  if (
    record.final &&
    record.ingress.final.state !== 'reconciled' &&
    (!final || jsonSha256(final) !== jsonSha256(record.final))
  ) {
    record.rejectedEvidence = true;
    return { invalid: true, native, final, finalRaw };
  }
  if (native) record.native = native;
  if (final) record.final = final;
  return { invalid: false, native, final, finalRaw };
}

function descriptorFromFile(
  files: WebCheckPrivateFiles,
  expected: ExpectedInvocation,
): PreparedCheckRunDescriptor | null {
  try {
    return validatePreparedFile(files, expected);
  } catch {
    return null;
  }
}

function recoveryHelperClosed(helper: RecoveryHelper): boolean {
  return (
    helper.state === 'closed' &&
    helper.parentClosed === true &&
    helper.outputClosed === true &&
    helper.groupClosed === true
  );
}

function recordRecoveryLifetime(
  files: WebCheckPrivateFiles,
  record: WebCustodyRecord,
  helper: RecoveryHelper,
  lifetime: WebCheckHelperLifetime,
): boolean {
  if (lifetime.parentClosed !== undefined) helper.parentClosed = lifetime.parentClosed;
  if (lifetime.outputClosed !== undefined) helper.outputClosed = lifetime.outputClosed;
  if (lifetime.groupClosed !== undefined) helper.groupClosed = lifetime.groupClosed;
  if (lifetime.timedOut) helper.timedOut = true;
  if (lifetime.cancelled) helper.cancelled = true;
  if (lifetime.outputOverflow !== undefined) helper.outputOverflow = lifetime.outputOverflow;
  if (
    helper.finishedAt !== null &&
    helper.parentClosed === true &&
    helper.outputClosed === true &&
    helper.groupClosed === true
  )
    helper.state = 'closed';
  else if (helper.finishedAt !== null) helper.state = 'unknown';
  try {
    persistRecord(files, record);
    return true;
  } catch {
    // The descriptor remains occupied even when the helper-lifetime journal cannot be refreshed.
    return false;
  }
}

async function invokeRecoveryRuntime(
  runtime: WebCheckCustodyRuntime,
  invocation: WebCheckDriverInvocation & { phase: 'status' | 'reconcile' },
  files: WebCheckPrivateFiles,
  record: WebCustodyRecord,
): Promise<WebCheckDriverProcess | null> {
  if (record.recovery.length >= MAX_RECOVERY_HELPERS || record.recovery.some((helper) => !recoveryHelperClosed(helper)))
    return null;
  const helper: RecoveryHelper = {
    id: randomUUID(),
    operation: invocation.phase,
    pid: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    state: 'dispatching',
    parentClosed: null,
    outputClosed: null,
    groupClosed: null,
    timedOut: false,
    cancelled: false,
    outputOverflow: null,
  };
  record.recovery.push(helper);
  try {
    persistRecord(files, record);
  } catch {
    record.recovery.pop();
    return null;
  }
  const onLifetime = (lifetime: WebCheckHelperLifetime) => {
    recordRecoveryLifetime(files, record, helper, lifetime);
  };
  let result: WebCheckDriverProcess;
  try {
    result = await runtime.invoke({
      ...invocation,
      limits: WEB_CHECK_RECOVERY_LIMITS,
      onStart(identity) {
        helper.pid = identity.pid;
        helper.startedAt = identity.startedAt;
        persistRecord(files, record);
      },
      onLifetime,
    });
  } catch {
    helper.finishedAt = new Date().toISOString();
    recordRecoveryLifetime(files, record, helper, {});
    return null;
  }
  const parentClosed = result.parentClosed === undefined ? result.closed : result.parentClosed;
  const outputClosed = result.outputClosed === undefined ? result.closed : result.outputClosed;
  const groupClosed = result.groupClosed === undefined ? result.closed : result.groupClosed;
  helper.finishedAt = new Date().toISOString();
  const durableLifetime = recordRecoveryLifetime(files, record, helper, {
    parentClosed,
    outputClosed,
    groupClosed,
    timedOut: result.timedOut ?? false,
    cancelled: result.cancelled ?? false,
    outputOverflow: result.outputOverflow,
  });
  if (!durableLifetime) helper.state = 'unknown';
  const closed = durableLifetime && result.closed && parentClosed && outputClosed && groupClosed === true;
  return { ...result, parentClosed, outputClosed, groupClosed, closed };
}

async function statusFromRuntime(
  runtime: WebCheckCustodyRuntime,
  files: WebCheckPrivateFiles,
  record: WebCustodyRecord,
  driverRoot: string,
  workspace: string,
  descriptor: PreparedCheckRunDescriptor,
  expected: ExpectedInvocation,
  native: NativeTerminal | null,
  env: NodeJS.ProcessEnv,
  registered: RegisteredInvocation | null = null,
  onRejected?: () => void,
  signal?: AbortSignal,
): Promise<StatusRecord | null> {
  const result = await invokeRecoveryRuntime(
    runtime,
    {
      phase: 'status',
      command: commandForStatus(driverRoot, descriptor.invocationId),
      cwd: workspace,
      env: baseEnvironment(env),
      ...(signal ? { signal } : {}),
    },
    files,
    record,
  );
  if (!result) return null;
  if (!result.closed || result.code !== 0 || result.timedOut || result.cancelled) return null;
  if (result.outputOverflow) {
    onRejected?.();
    return null;
  }
  try {
    return validateStatusRecord(parseSingleOutput(result.output, 'status'), descriptor, expected, native, registered);
  } catch {
    onRejected?.();
    return null;
  }
}

async function reconcileWithRuntime(
  runtime: WebCheckCustodyRuntime,
  files: WebCheckPrivateFiles,
  record: WebCustodyRecord,
  driverRoot: string,
  hostsFile: string,
  workspace: string,
  descriptorFile: string,
  descriptor: PreparedCheckRunDescriptor | null,
  expected: ExpectedInvocation,
  native: NativeTerminal | null,
  env: NodeJS.ProcessEnv,
  registered: RegisteredInvocation | null = null,
  onRejected?: () => void,
): Promise<{ status: StatusRecord | null; cleanedPreparation: boolean }> {
  const result = await invokeRecoveryRuntime(
    runtime,
    {
      phase: 'reconcile',
      command: commandForReconcile(driverRoot, descriptorFile, hostsFile),
      cwd: workspace,
      env: baseEnvironment(env),
    },
    files,
    record,
  );
  if (!result) return { status: null, cleanedPreparation: false };
  if (!result.closed || result.code !== 0 || result.timedOut || result.cancelled)
    return { status: null, cleanedPreparation: false };
  if (result.outputOverflow) {
    onRejected?.();
    return { status: null, cleanedPreparation: false };
  }
  try {
    const recovered = validateRecovery(
      parseSingleOutput(result.output, 'original descriptor reconciliation'),
      descriptor,
      expected,
      native,
      registered,
    );
    return recovered;
  } catch {
    onRejected?.();
    return { status: null, cleanedPreparation: false };
  }
}

function outputCode(result: WebCheckDriverProcess): number {
  if (result.code !== null) return result.code;
  if (result.signal)
    return (
      128 + (result.signal === 'SIGINT' ? 2 : result.signal === 'SIGTERM' ? 15 : result.signal === 'SIGHUP' ? 1 : 0)
    );
  return 75;
}

function outcome(
  code: number,
  files: WebCheckPrivateFiles,
  descriptor: PreparedCheckRunDescriptor | null,
  native: NativeTerminal | null,
  final: FinalSettlement | null,
  custody: 'settled' | 'occupied',
  privateCleanup: WebCheckCustodyOutcome['privateCleanup'],
  cancellation: WebCheckCustodyOutcome['cancellation'],
  finalCustody: WebCheckCustodyOutcome['finalCustody'] = 'unknown',
): WebCheckCustodyOutcome {
  return {
    code,
    custody,
    invocationId: descriptor?.invocationId ?? null,
    nativeExitCode: native?.receipt.exitCode ?? null,
    source:
      final?.preparedInputs.status === 'verified' &&
      final.preparedInputs.sourceSha256 === descriptor?.binding.sourceSha256
        ? 'verified'
        : 'unknown',
    returns:
      final &&
      ['empty', 'restored'].includes(final.returns.status) &&
      !final.returns.missing.length &&
      !final.returns.failures.length
        ? 'verified'
        : 'unknown',
    finalCustody,
    privateCleanup,
    cancellation,
    descriptorFile: files.descriptorFile,
  };
}

function isCancellationSettled(status: StatusRecord | null): boolean {
  return Boolean(
    status &&
    status.phase === 'cancelled' &&
    status.cancellation.requested &&
    status.snapshotCustody === 'removed' &&
    !status.physical &&
    !status.final,
  );
}

async function finishPrivate(
  runtime: WebCheckCustodyRuntime,
  files: WebCheckPrivateFiles,
  code: number,
  descriptor: PreparedCheckRunDescriptor | null,
  native: NativeTerminal | null,
  final: FinalSettlement | null,
  cancellation: WebCheckCustodyOutcome['cancellation'],
  record?: WebCustodyRecord,
  finalCustody: WebCheckCustodyOutcome['finalCustody'] = 'unknown',
): Promise<WebCheckCustodyOutcome> {
  if (record) {
    record.cleanup = { ...record.cleanup, state: 'dispatching', detail: null };
    try {
      persistRecord(files, record);
    } catch {
      /* Keep descriptor custody if the journal cannot be refreshed. */
    }
  }
  try {
    await runtime.cleanup(files);
    if (directoryExists(files.directory)) throw new Error('private receiver directory remains after cleanup');
    return outcome(code, files, descriptor, native, final, 'settled', 'settled', cancellation, finalCustody);
  } catch {
    // Keep the native result and private cleanup as separate evidence.
    if (record) {
      record.cleanup = { ...record.cleanup, state: 'unknown', detail: 'private receiver cleanup did not complete' };
      try {
        persistRecord(files, record);
      } catch {
        /* Retained descriptor and wire bytes remain the recovery authority. */
      }
    }
    return outcome(
      code === 0 ? 75 : code,
      files,
      descriptor,
      native,
      final,
      'occupied',
      'unknown',
      cancellation,
      finalCustody,
    );
  }
}

function directoryExists(directory: string): boolean {
  try {
    const stat = lstatSync(directory);
    return stat.isDirectory() || stat.isSymbolicLink();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    return true;
  }
}

/** Prepare once, receive one original FD 3 stream, and retain every unresolved descriptor for reconciliation. */
export async function runPreparedWebCheck(
  input: {
    driverRoot: string;
    hostsFile: string;
    workspace: string;
    cwd: string;
    sourceRevision: string;
    command: readonly string[];
    environment: Record<string, string>;
    priority: string | null;
    returns: readonly string[];
    env: NodeJS.ProcessEnv;
    files: WebCheckPrivateFiles;
  },
  runtime: WebCheckCustodyRuntime = webCheckCustodyRuntime,
  signal?: AbortSignal,
): Promise<WebCheckCustodyOutcome> {
  assertPrivateFiles(input.files, input.workspace);
  if (signal?.aborted) return finishPrivate(runtime, input.files, signalCode(signal), null, null, null, 'settled');
  const expected = expectedInvocation(input);
  const record: WebCustodyRecord = {
    schema: 1,
    type: 'web-check-custody',
    descriptorFile: input.files.descriptorFile,
    environmentFile: input.files.environmentFile,
    expected,
    descriptor: null,
    registered: null,
    caller: { prepare: emptyProcessLifetime(), run: emptyProcessLifetime() },
    recovery: [],
    ingress: emptyReceiptIngress(),
    validation: { source: 'unknown', returns: 'unknown' },
    cleanup: { state: 'not-attempted', detail: null, environmentInput: 'present' },
    cancellation: { requested: false, signal: null },
    native: null,
    final: null,
    rejectedEvidence: false,
    failure: null,
  };
  const command = commandForPrepare({
    ...input,
    environmentFile: input.files.environmentFile,
    descriptorFile: input.files.descriptorFile,
  });
  try {
    persistRecord(input.files, record);
    record.caller.prepare = { ...emptyProcessLifetime(), state: 'dispatching' };
    persistRecord(input.files, record);
  } catch (error) {
    try {
      disposeWebCheckEnvironmentInput(input.files);
    } catch {
      /* Preserve the journal error. */
    }
    try {
      await runtime.cleanup(input.files);
    } catch {
      /* No producer process was dispatched. */
    }
    throw error;
  }
  let prepare: WebCheckDriverProcess;
  try {
    prepare = await runtime.invoke({
      phase: 'prepare',
      command,
      cwd: input.workspace,
      env: baseEnvironment(input.env),
      ...(signal ? { signal } : {}),
    });
    record.caller.prepare = processLifetime(prepare);
  } catch (error) {
    record.failure = error instanceof Error ? error.message.slice(0, 512) : String(error).slice(0, 512);
    record.caller.prepare = { ...emptyProcessLifetime(), state: 'unknown' };
    prepare = { code: null, signal: null, closed: false, output: '', outputOverflow: false };
  }
  record.cancellation = { requested: Boolean(signal?.aborted), signal: signal?.aborted ? signalNumber(signal) : null };
  persistRecord(input.files, record);
  let descriptor: PreparedCheckRunDescriptor | null = null;
  let descriptorRaw: Buffer | null = null;
  let prepareRejected = false;
  if (prepare.closed && prepare.code === 0 && !prepare.outputOverflow) {
    try {
      const parsed = parsePreparedOutput(prepare.output, input.files, expected);
      descriptor = parsed.descriptor;
      descriptorRaw = parsed.raw;
      record.descriptor = descriptor;
      persistRecord(input.files, record);
    } catch {
      prepareRejected = true;
      record.rejectedEvidence = true;
    }
  }
  if (!descriptor && !prepareRejected) descriptor = descriptorFromFile(input.files, expected);

  let registrationReady = false;
  if (
    descriptor &&
    descriptorRaw &&
    prepare.closed &&
    prepare.code === 0 &&
    !prepare.outputOverflow &&
    !prepareRejected
  ) {
    const preparedStatus = await statusFromRuntime(
      runtime,
      input.files,
      record,
      input.driverRoot,
      input.workspace,
      descriptor,
      expected,
      null,
      input.env,
      null,
      () => {
        record.rejectedEvidence = true;
      },
      signal?.aborted ? undefined : signal,
    );
    if (preparedStatus) {
      try {
        record.registered = registerPreparedInvocation(preparedStatus, descriptor, input.files, expected);
        registrationReady = true;
      } catch {
        record.rejectedEvidence = true;
        prepareRejected = true;
      }
    }
    if (!registrationReady && !record.rejectedEvidence)
      record.failure = 'prepared descriptor has no authenticated pre-launch registration status';
    persistRecord(input.files, record);
  }

  const abortAfterPrepare = Boolean(signal?.aborted);
  if (
    !descriptor ||
    !registrationReady ||
    prepare.code !== 0 ||
    !prepare.closed ||
    prepare.outputOverflow ||
    abortAfterPrepare ||
    prepareRejected
  ) {
    if (prepare.closed) removeEnvironmentInput(input.files, record);
    const recovered = await reconcileWithRuntime(
      runtime,
      input.files,
      record,
      input.driverRoot,
      input.hostsFile,
      input.workspace,
      input.files.descriptorFile,
      descriptor,
      expected,
      null,
      input.env,
      record.registered,
      () => {
        record.rejectedEvidence = true;
      },
    );
    const canceled = isCancellationSettled(recovered.status) || recovered.cleanedPreparation;
    const callerPreparationClosed = record.caller.prepare.state === 'closed';
    if (canceled && callerPreparationClosed && !prepareRejected && !record.rejectedEvidence) {
      return finishPrivate(
        runtime,
        input.files,
        abortAfterPrepare ? signalCode(signal) : outputCode(prepare) === 0 ? 75 : outputCode(prepare),
        descriptor,
        null,
        null,
        abortAfterPrepare ? 'settled' : 'none',
        record,
      );
    }
    persistRecord(input.files, record);
    return outcome(
      abortAfterPrepare ? signalCode(signal) : prepare.code === 0 ? 75 : outputCode(prepare),
      input.files,
      descriptor,
      null,
      null,
      'occupied',
      'retained',
      abortAfterPrepare ? 'unknown' : 'none',
    );
  }

  const registered = record.registered;
  if (!registered) {
    record.rejectedEvidence = true;
    persistRecord(input.files, record);
    return outcome(75, input.files, descriptor, null, null, 'occupied', 'retained', 'unknown');
  }
  const receiver = new FinalWireReceiver(descriptor, expected, record, input.files);
  if (signal?.aborted) {
    removeEnvironmentInput(input.files, record);
    record.cancellation = { requested: true, signal: signalNumber(signal) };
    const recovered = await reconcileWithRuntime(
      runtime,
      input.files,
      record,
      input.driverRoot,
      input.hostsFile,
      input.workspace,
      input.files.descriptorFile,
      descriptor,
      expected,
      null,
      input.env,
      registered,
      () => {
        record.rejectedEvidence = true;
      },
    );
    if (isCancellationSettled(recovered.status) && !record.rejectedEvidence)
      return finishPrivate(runtime, input.files, signalCode(signal), descriptor, null, null, 'settled', record);
    persistRecord(input.files, record);
    return outcome(signalCode(signal), input.files, descriptor, null, null, 'occupied', 'retained', 'unknown');
  }
  record.caller.run = { ...emptyProcessLifetime(), state: 'dispatching' };
  persistRecord(input.files, record);
  let run: WebCheckDriverProcess;
  try {
    run = await runtime.invoke({
      phase: 'run-prepared',
      command: commandForRunPrepared(input.driverRoot, input.files.descriptorFile),
      cwd: input.workspace,
      env: processEnvironmentForPrepared(input.env, descriptor),
      ...(signal ? { signal } : {}),
      onReceipt: (chunk) => receiver.accept(chunk),
    });
    record.caller.run = processLifetime(run);
  } catch (error) {
    record.failure = error instanceof Error ? error.message.slice(0, 512) : String(error).slice(0, 512);
    record.caller.run = { ...emptyProcessLifetime(), state: 'unknown' };
    run = { code: null, signal: null, closed: false, output: '', outputOverflow: false };
  }
  // The producer revalidates the original environment against its binding during run-prepared admission.
  if (run.closed) removeEnvironmentInput(input.files, record);
  const wire = receiver.finish();
  const cancellationRequested = Boolean(signal?.aborted);
  record.cancellation = {
    requested: cancellationRequested,
    signal: cancellationRequested ? signalNumber(signal) : null,
  };
  persistRecord(input.files, record);
  if (wire.invalid) {
    return outcome(
      cancellationRequested ? signalCode(signal) : outputCode(run) === 0 ? 75 : outputCode(run),
      input.files,
      descriptor,
      wire.native,
      wire.final,
      'occupied',
      'retained',
      cancellationRequested ? 'unknown' : 'none',
      'unknown',
    );
  }

  if (!run.closed) {
    await reconcileWithRuntime(
      runtime,
      input.files,
      record,
      input.driverRoot,
      input.hostsFile,
      input.workspace,
      input.files.descriptorFile,
      descriptor,
      expected,
      wire.native,
      input.env,
      record.registered,
      () => {
        record.rejectedEvidence = true;
      },
    );
    persistRecord(input.files, record);
    return outcome(
      cancellationRequested ? signalCode(signal) : 75,
      input.files,
      descriptor,
      wire.native,
      wire.final,
      'occupied',
      'retained',
      cancellationRequested ? 'unknown' : 'none',
    );
  }

  let status = await statusFromRuntime(
    runtime,
    input.files,
    record,
    input.driverRoot,
    input.workspace,
    descriptor,
    expected,
    wire.native,
    input.env,
    registered,
    () => {
      record.rejectedEvidence = true;
    },
  );
  let final = wire.final;
  let finalCustodyOkay = false;
  if (status) {
    try {
      const statusFinal = validateStatusAgainstOriginal(status, descriptor, expected, wire.native, registered);
      if (statusFinal && final && jsonSha256(statusFinal) !== jsonSha256(final))
        throw new Error('status final differs from the original FD 3 final');
      if (final) finalCustodyOkay = finalCustodySettled(status, final, wire.finalRaw, registered);
    } catch {
      record.rejectedEvidence = true;
    }
  }
  if (!status && !record.rejectedEvidence) record.failure = 'post-run producer status is unavailable';
  persistRecord(input.files, record);

  let cancellation: WebCheckCustodyOutcome['cancellation'] = cancellationRequested ? 'requested' : 'none';
  const needsReconciliation =
    !status || !wire.native || (wire.native !== null && (!finalCustodyOkay || !final)) || cancellationRequested;
  if (needsReconciliation && !record.rejectedEvidence) {
    const recovered = await reconcileWithRuntime(
      runtime,
      input.files,
      record,
      input.driverRoot,
      input.hostsFile,
      input.workspace,
      input.files.descriptorFile,
      descriptor,
      expected,
      wire.native,
      input.env,
      registered,
      () => {
        record.rejectedEvidence = true;
      },
    );
    if (recovered.status) {
      status = recovered.status;
      try {
        const reconciledFinal = validateStatusAgainstOriginal(status, descriptor, expected, wire.native, registered);
        if (!wire.native && isCancellationSettled(status)) {
          return finishPrivate(
            runtime,
            input.files,
            cancellationRequested ? signalCode(signal) : outputCode(run),
            descriptor,
            null,
            null,
            cancellationRequested ? 'settled' : 'none',
            record,
          );
        }
        if (reconciledFinal && (!final || jsonSha256(reconciledFinal) === jsonSha256(final))) {
          final = reconciledFinal;
          if (!wire.final) {
            record.final = final;
            record.ingress.final = {
              state: 'reconciled',
              start: null,
              end: null,
              rawSha256: null,
              bodySha256: null,
              originalSha256: jsonSha256(final),
            };
          }
          finalCustodyOkay = finalCustodySettled(status, final, wire.finalRaw, registered);
          record.validation.source = final.preparedInputs.status === 'verified' ? 'verified' : 'rejected';
          record.validation.returns =
            ['empty', 'restored'].includes(final.returns.status) &&
            final.returns.missing.length === 0 &&
            final.returns.failures.length === 0
              ? 'verified'
              : 'rejected';
          if (cancellationRequested && finalCustodyOkay) cancellation = 'settled';
        }
      } catch {
        record.rejectedEvidence = true;
      }
    } else if (recovered.cleanedPreparation) {
      // A physical invocation with a native receipt cannot be replaced by a preparation-only acknowledgement.
      finalCustodyOkay = false;
    }
  }

  if (record.rejectedEvidence || !wire.native || !final || !status || !finalCustodyOkay) {
    const nativeCode = wire.native && wire.native.receipt.exitCode !== 0 ? wire.native.receipt.exitCode : null;
    const code =
      nativeCode ?? (cancellationRequested ? signalCode(signal) : outputCode(run) === 0 ? 75 : outputCode(run));
    persistRecord(input.files, record);
    return outcome(
      code,
      input.files,
      descriptor,
      wire.native,
      final,
      'occupied',
      'retained',
      cancellation ? cancellation : 'unknown',
      status?.finalCustody?.aggregate ?? 'unknown',
    );
  }

  const nativeCode = wire.native.receipt.exitCode;
  if (!record.ingress.complete) {
    persistRecord(input.files, record);
    return outcome(
      nativeCode !== 0 ? nativeCode : 75,
      input.files,
      descriptor,
      wire.native,
      final,
      'occupied',
      'retained',
      cancellation,
      status.finalCustody?.aggregate ?? 'unknown',
    );
  }
  if (!cancellationRequested && outputCode(run) !== nativeCode) {
    record.rejectedEvidence = true;
    record.failure = 'run-prepared exit differs from the original native terminal';
    persistRecord(input.files, record);
    return outcome(
      nativeCode !== 0 ? nativeCode : 75,
      input.files,
      descriptor,
      wire.native,
      final,
      'occupied',
      'retained',
      'unknown',
      status.finalCustody?.aggregate ?? 'unknown',
    );
  }
  return finishPrivate(
    runtime,
    input.files,
    nativeCode !== 0 ? nativeCode : cancellationRequested ? signalCode(signal) : nativeCode,
    descriptor,
    wire.native,
    final,
    cancellation,
    record,
    status.finalCustody?.aggregate ?? 'unknown',
  );
}

function signalNumber(signal?: AbortSignal): 1 | 2 | 15 | null {
  const reason = signal?.reason;
  if (reason === 129 || reason === 'SIGHUP') return 1;
  if (reason === 130 || reason === 'SIGINT') return 2;
  if (reason === 143 || reason === 'SIGTERM' || reason === undefined) return 15;
  return null;
}

function signalCode(signal?: AbortSignal): number {
  const reason = signal?.reason;
  return reason === 129 || reason === 130 || reason === 143 ? reason : 143;
}

function validateProcessLifetime(value: unknown, label: string): ProcessLifetime {
  const item = closed(value, ['state', 'code', 'signal', 'outputSha256', 'outputOverflow'], `${label} caller lifetime`);
  if (!['not-started', 'dispatching', 'closed', 'unknown'].includes(String(item.state)))
    throw new Error(`Web check custody: invalid ${label} caller state`);
  if (item.code !== null) count(item.code, `${label} caller exit`, 255);
  const signal = item.signal === null ? null : text(item.signal, `${label} caller signal`, 32);
  if (typeof item.outputOverflow !== 'boolean') throw new Error(`Web check custody: invalid ${label} output overflow`);
  const outputSha256 = item.outputSha256 === null ? null : hash(item.outputSha256, `${label} output digest`);
  if (item.state === 'closed' && outputSha256 === null)
    throw new Error(`Web check custody: closed ${label} caller lacks its output receipt`);
  if (item.state === 'dispatching' && (item.code !== null || signal !== null || outputSha256 !== null))
    throw new Error(`Web check custody: dispatching ${label} caller already has terminal evidence`);
  return {
    state: item.state as ProcessLifetime['state'],
    code: item.code as number | null,
    signal,
    outputSha256,
    outputOverflow: item.outputOverflow,
  };
}

function validateIngressMessage(value: unknown, label: string): IngressMessage {
  const item = closed(
    value,
    ['state', 'start', 'end', 'rawSha256', 'bodySha256', 'originalSha256'],
    `${label} ingress receipt`,
  );
  if (!['absent', 'received', 'reconciled', 'rejected'].includes(String(item.state)))
    throw new Error(`Web check custody: invalid ${label} ingress state`);
  const state = item.state as IngressMessage['state'];
  const start =
    item.start === null ? null : count(item.start, `${label} ingress start`, MAX_NATIVE_BYTES + MAX_FINAL_BYTES);
  const end = item.end === null ? null : count(item.end, `${label} ingress end`, MAX_NATIVE_BYTES + MAX_FINAL_BYTES);
  const rawSha256 = item.rawSha256 === null ? null : hash(item.rawSha256, `${label} raw ingress digest`);
  const bodySha256 = item.bodySha256 === null ? null : hash(item.bodySha256, `${label} body ingress digest`);
  const originalSha256 =
    item.originalSha256 === null ? null : hash(item.originalSha256, `${label} original ingress digest`);
  if (
    state === 'absent' &&
    (start !== null || end !== null || rawSha256 !== null || bodySha256 !== null || originalSha256 !== null)
  )
    throw new Error(`Web check custody: absent ${label} ingress has evidence fields`);
  if (
    state === 'received' &&
    (start === null ||
      end === null ||
      end <= start ||
      rawSha256 === null ||
      bodySha256 === null ||
      originalSha256 === null)
  )
    throw new Error(`Web check custody: received ${label} ingress is incomplete`);
  if (
    state === 'reconciled' &&
    (start !== null || end !== null || rawSha256 !== null || bodySha256 !== null || originalSha256 === null)
  )
    throw new Error(`Web check custody: reconciled ${label} ingress is not tied to the immutable final`);
  return { state, start, end, rawSha256, bodySha256, originalSha256 };
}

function validateReceiptIngress(value: unknown): ReceiptIngress {
  const item = closed(value, ['streamBytes', 'streamSha256', 'complete', 'native', 'final'], 'FD 3 ingress journal');
  if (typeof item.complete !== 'boolean') throw new Error('Web check custody: invalid FD 3 completion marker');
  const streamBytes = count(item.streamBytes, 'FD 3 ingress byte count', MAX_NATIVE_BYTES + MAX_FINAL_BYTES);
  return {
    streamBytes,
    streamSha256: hash(item.streamSha256, 'FD 3 ingress stream hash'),
    complete: item.complete,
    native: validateIngressMessage(item.native, 'native'),
    final: validateIngressMessage(item.final, 'final'),
  };
}

function validateRegisteredInvocation(
  value: unknown,
  descriptor: PreparedCheckRunDescriptor,
  expected: ExpectedInvocation,
  files: WebCheckPrivateFiles,
): RegisteredInvocation {
  const item = closed(
    value,
    ['binding', 'candidateWorkspace', 'snapshot', 'returns', 'preparedExecution', 'descriptor', 'preparationIntent'],
    'prepared registration journal',
  );
  const binding = validateBinding(item.binding);
  const candidateWorkspace = text(item.candidateWorkspace, 'registered candidate workspace', 4096);
  const snapshot = validateSnapshot(item.snapshot, binding);
  const returns = validateStringList(item.returns, 'registered return declaration');
  const preparedExecution = validatePrivateReference(item.preparedExecution, 'prepared execution');
  const descriptorReference = validatePrivateReference(item.descriptor, 'prepared descriptor');
  const preparationIntent = validatePrivateReference(item.preparationIntent, 'preparation intent');
  if (
    !snapshot ||
    !preparedExecution ||
    !descriptorReference ||
    JSON.stringify(binding) !== JSON.stringify(descriptor.binding) ||
    candidateWorkspace !== expected.workspace ||
    snapshot.sourceSha256 !== descriptor.binding.sourceSha256 ||
    JSON.stringify(returns) !== JSON.stringify(expected.returns) ||
    descriptorReference.file !== files.descriptorFile ||
    descriptorReference.sha256 !== sha256(readPreparedFile(files, expected).raw)
  )
    throw new Error('Web check custody: retained registration differs from the original prepared request');
  return {
    binding,
    candidateWorkspace,
    snapshot,
    returns,
    preparedExecution,
    descriptor: descriptorReference,
    preparationIntent,
  };
}

function validateCallerLifetime(value: unknown): CallerLifetime {
  const item = closed(value, ['prepare', 'run'], 'caller process lifetime');
  return {
    prepare: validateProcessLifetime(item.prepare, 'prepare'),
    run: validateProcessLifetime(item.run, 'run-prepared'),
  };
}

function validateRecoveryHelpers(value: unknown): RecoveryHelper[] {
  if (!Array.isArray(value) || value.length > MAX_RECOVERY_HELPERS)
    throw new Error('Web check custody: invalid bounded recovery helper journal');
  return value.map((raw) => {
    const item = closed(
      raw,
      [
        'id',
        'operation',
        'pid',
        'startedAt',
        'finishedAt',
        'state',
        'parentClosed',
        'outputClosed',
        'groupClosed',
        'timedOut',
        'cancelled',
        'outputOverflow',
      ],
      'recovery helper lifetime',
    );
    const id = text(item.id, 'recovery helper id', 64);
    if (!UUID.test(id) || (item.operation !== 'status' && item.operation !== 'reconcile'))
      throw new Error('Web check custody: invalid recovery helper identity');
    const pid = item.pid === null ? null : count(item.pid, 'recovery helper pid', 2 ** 31 - 1);
    if (pid !== null && pid < 2) throw new Error('Web check custody: invalid recovery helper pid');
    const startedAt = validTimestamp(item.startedAt, 'recovery helper start time');
    const finishedAt = item.finishedAt === null ? null : validTimestamp(item.finishedAt, 'recovery helper finish time');
    if (!['dispatching', 'closed', 'unknown'].includes(String(item.state)))
      throw new Error('Web check custody: invalid recovery helper state');
    const closure = (entry: unknown, label: string): boolean | null => {
      if (entry !== null && typeof entry !== 'boolean') throw new Error(`Web check custody: invalid ${label} closure`);
      return entry as boolean | null;
    };
    if (typeof item.timedOut !== 'boolean' || typeof item.cancelled !== 'boolean')
      throw new Error('Web check custody: invalid recovery helper terminal flags');
    if (item.outputOverflow !== null && typeof item.outputOverflow !== 'boolean')
      throw new Error('Web check custody: invalid recovery helper output state');
    const helper: RecoveryHelper = {
      id,
      operation: item.operation,
      pid,
      startedAt,
      finishedAt,
      state: item.state as RecoveryHelper['state'],
      parentClosed: closure(item.parentClosed, 'helper parent'),
      outputClosed: closure(item.outputClosed, 'helper output'),
      groupClosed: closure(item.groupClosed, 'helper group'),
      timedOut: item.timedOut,
      cancelled: item.cancelled,
      outputOverflow: item.outputOverflow as boolean | null,
    };
    if (
      (helper.state === 'dispatching' && helper.finishedAt !== null) ||
      (helper.state !== 'dispatching' && helper.finishedAt === null) ||
      (helper.state === 'closed' && !recoveryHelperClosed(helper))
    )
      throw new Error('Web check custody: inconsistent recovery helper closure evidence');
    return helper;
  });
}

function validateRecordFile(files: WebCheckPrivateFiles): WebCustodyRecord {
  const stat = lstatSync(files.recordFile);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.size > MAX_RECORD_BYTES ||
    (stat.mode & 0o077) !== 0 ||
    (typeof process.getuid === 'function' && stat.uid !== process.getuid())
  )
    throw new Error('Web check custody: retained Web custody record is not private and bounded');
  const rawValue = parseUniqueJson(readFileSync(files.recordFile, 'utf8'));
  const oldKeys = [
    'schema',
    'type',
    'descriptorFile',
    'environmentFile',
    'expected',
    'descriptor',
    'native',
    'final',
    'rejectedEvidence',
    'failure',
  ];
  const previousCurrentKeys = [
    ...oldKeys.slice(0, 6),
    'registered',
    'caller',
    'ingress',
    'validation',
    'cleanup',
    'cancellation',
    ...oldKeys.slice(6),
  ];
  const currentKeys = [...previousCurrentKeys, 'recovery'];
  if (!isObject(rawValue)) throw new Error('Web check custody: retained Web custody record is invalid');
  const legacy =
    Reflect.ownKeys(rawValue).length === oldKeys.length && oldKeys.every((key) => Object.hasOwn(rawValue, key));
  const previousCurrent =
    Reflect.ownKeys(rawValue).length === previousCurrentKeys.length &&
    previousCurrentKeys.every((key) => Object.hasOwn(rawValue, key));
  const value = closed(
    rawValue,
    legacy ? oldKeys : previousCurrent ? previousCurrentKeys : currentKeys,
    'retained Web custody record',
  );
  if (value.schema !== 1 || value.type !== 'web-check-custody')
    throw new Error('Web check custody: retained Web custody record is invalid');
  if (value.descriptorFile !== files.descriptorFile || value.environmentFile !== files.environmentFile)
    throw new Error('Web check custody: retained private paths differ from the original Web invocation');
  const rawExpected = closed(
    value.expected,
    [
      'driverRoot',
      'hostsFile',
      'workspace',
      'cwd',
      'sourceRevision',
      'commandSha256',
      'semanticEnvironmentSha256',
      'relocatedEnvironmentSha256',
      'returns',
      'returnsSha256',
    ],
    'retained Web request',
  );
  const absolute = (entry: unknown, label: string) => {
    const path = text(entry, label, 4096);
    if (!isAbsolute(path) || resolve(path) !== path) throw new Error(`Web check custody: invalid retained ${label}`);
    return path;
  };
  const workspace = absolute(rawExpected.workspace, 'candidate workspace');
  const cwd = text(rawExpected.cwd, 'workspace-relative cwd', 4096);
  if (
    !cwd ||
    (cwd !== '.' &&
      (cwd.startsWith('/') || /[\\\0\r\n]/.test(cwd) || cwd.split('/').some((part) => ['', '.', '..'].includes(part))))
  )
    throw new Error('Web check custody: invalid retained working directory');
  if (typeof rawExpected.sourceRevision !== 'string' || !/^[a-f0-9]{40}$/.test(rawExpected.sourceRevision))
    throw new Error('Web check custody: invalid retained source revision');
  if (!Array.isArray(rawExpected.returns) || rawExpected.returns.length > 64)
    throw new Error('Web check custody: invalid retained return declarations');
  const returns = rawExpected.returns.map((path) => validatePath(path, 'retained return declaration'));
  if (new Set(returns).size !== returns.length)
    throw new Error('Web check custody: duplicate retained return declaration');
  const expected: ExpectedInvocation = {
    driverRoot: absolute(rawExpected.driverRoot, 'driver root'),
    hostsFile: absolute(rawExpected.hostsFile, 'hosts file'),
    workspace,
    cwd,
    sourceRevision: rawExpected.sourceRevision,
    commandSha256: hash(rawExpected.commandSha256, 'retained argv hash'),
    semanticEnvironmentSha256: hash(rawExpected.semanticEnvironmentSha256, 'retained semantic environment hash'),
    relocatedEnvironmentSha256: hash(rawExpected.relocatedEnvironmentSha256, 'retained relocated environment hash'),
    returns,
    returnsSha256: hash(rawExpected.returnsSha256, 'retained return declaration hash'),
  };
  if (expected.returnsSha256 !== jsonSha256(returns))
    throw new Error('Web check custody: retained returns hash is inconsistent');
  const descriptor = value.descriptor === null ? null : validateDescriptor(value.descriptor);
  if (descriptor) validatePreparedBinding(descriptor, expected);
  const native = value.native === null ? null : validateNativeTerminal(value.native, requireDescriptor(descriptor));
  const final =
    value.final === null
      ? null
      : validateFinalSettlement(value.final, requireDescriptor(descriptor), requireNative(native), expected);
  if (native && final && jsonSha256(final.native) !== jsonSha256(nativeDisposition(native)))
    throw new Error('Web check custody: retained final differs from original native evidence');
  if (typeof value.rejectedEvidence !== 'boolean')
    throw new Error('Web check custody: invalid rejected-evidence marker');
  const failure = value.failure === null ? null : text(value.failure, 'retained invocation failure', 512);
  const registered =
    legacy || value.registered === null
      ? null
      : validateRegisteredInvocation(value.registered, requireDescriptor(descriptor), expected, files);
  const caller = legacy
    ? {
        prepare: { ...emptyProcessLifetime(), state: descriptor ? ('unknown' as const) : ('not-started' as const) },
        run: { ...emptyProcessLifetime(), state: native ? ('unknown' as const) : ('not-started' as const) },
      }
    : validateCallerLifetime(value.caller);
  const recovery = legacy || previousCurrent ? [] : validateRecoveryHelpers(value.recovery);
  const ingress = legacy ? emptyReceiptIngress() : validateReceiptIngress(value.ingress);
  let validation: WebCustodyRecord['validation'];
  if (legacy) validation = { source: 'unknown', returns: 'unknown' };
  else {
    const rawValidation = closed(value.validation, ['source', 'returns'], 'source and returns validation record');
    if (
      !['unknown', 'verified', 'rejected'].includes(String(rawValidation.source)) ||
      !['unknown', 'verified', 'rejected'].includes(String(rawValidation.returns))
    )
      throw new Error('Web check custody: invalid source or returns validation state');
    validation = { source: rawValidation.source as EvidenceState, returns: rawValidation.returns as EvidenceState };
  }
  let cleanup: WebCustodyRecord['cleanup'];
  if (legacy)
    cleanup = {
      state: 'unknown',
      detail: 'legacy journal has no durable cleanup receipt',
      environmentInput: 'unknown',
    };
  else {
    const rawCleanup = closed(value.cleanup, ['state', 'detail', 'environmentInput'], 'private cleanup receipt');
    if (
      !['not-attempted', 'dispatching', 'settled', 'unknown'].includes(String(rawCleanup.state)) ||
      !['present', 'removed', 'unknown'].includes(String(rawCleanup.environmentInput))
    )
      throw new Error('Web check custody: invalid private cleanup state');
    cleanup = {
      state: rawCleanup.state as WebCustodyRecord['cleanup']['state'],
      detail: rawCleanup.detail === null ? null : text(rawCleanup.detail, 'private cleanup detail', 512),
      environmentInput: rawCleanup.environmentInput as WebCustodyRecord['cleanup']['environmentInput'],
    };
  }
  let cancellation: WebCustodyRecord['cancellation'];
  if (legacy) cancellation = { requested: false, signal: null };
  else {
    const rawCancellation = closed(value.cancellation, ['requested', 'signal'], 'Web cancellation receipt');
    if (
      typeof rawCancellation.requested !== 'boolean' ||
      (rawCancellation.signal !== null && ![1, 2, 15].includes(Number(rawCancellation.signal)))
    )
      throw new Error('Web check custody: invalid Web cancellation receipt');
    cancellation = { requested: rawCancellation.requested, signal: rawCancellation.signal as 1 | 2 | 15 | null };
  }
  if (resolve(files.directory) === workspace || relative(workspace, resolve(files.directory)).split(sep)[0] !== '..')
    throw new Error('Web check custody: retained private files are inside candidate source');
  const driverInside = relative(workspace, expected.driverRoot);
  if (
    driverInside === '' ||
    (!driverInside.startsWith(`..${sep}`) && driverInside !== '..' && !isAbsolute(driverInside))
  )
    throw new Error('Web check custody: retained driver is inside candidate source');
  const hostsStats = lstatSync(expected.hostsFile);
  if (!hostsStats.isFile() || hostsStats.isSymbolicLink())
    throw new Error('Web check custody: retained hosts file is unavailable');
  const hostInside = relative(workspace, expected.hostsFile);
  if (hostInside === '' || (!hostInside.startsWith(`..${sep}`) && hostInside !== '..' && !isAbsolute(hostInside)))
    throw new Error('Web check custody: retained hosts file is inside candidate source');
  assertPrivateFiles(files, workspace);
  return {
    schema: 1,
    type: 'web-check-custody',
    descriptorFile: files.descriptorFile,
    environmentFile: files.environmentFile,
    expected,
    descriptor,
    registered,
    caller,
    recovery,
    ingress,
    validation,
    cleanup,
    cancellation,
    native,
    final,
    rejectedEvidence: value.rejectedEvidence,
    failure,
  };
}

function requireDescriptor(descriptor: PreparedCheckRunDescriptor | null): PreparedCheckRunDescriptor {
  if (!descriptor) throw new Error('Web check custody: retained evidence has no original descriptor');
  return descriptor;
}

/** Reconcile only the original private descriptor; this function never prepares or launches another check. */
export async function reconcileWebCheckCustody(
  descriptorFile: string,
  runtime: WebCheckCustodyRuntime = webCheckCustodyRuntime,
): Promise<WebCheckCustodyOutcome> {
  if (!isAbsolute(descriptorFile)) throw new Error('Web check custody: --descriptor must be absolute');
  const absoluteDescriptor = resolve(descriptorFile);
  const directory = dirname(absoluteDescriptor);
  const files: WebCheckPrivateFiles = {
    directory,
    environmentFile: join(directory, 'environment.json'),
    descriptorFile: absoluteDescriptor,
    recordFile: join(directory, 'web-custody.json'),
    evidenceFile: join(directory, 'receipts.ndjson'),
    close: () => rmSync(directory, { recursive: true }),
  };
  const record = validateRecordFile(files);
  const replayed = replayRetainedEvidence(files, record);
  if (replayed.invalid) record.rejectedEvidence = true;
  persistRecord(files, record);
  const descriptor = descriptorFromRetainedFile(absoluteDescriptor, record.expected);
  if (record.descriptor && (!descriptor || jsonSha256(record.descriptor) !== jsonSha256(descriptor)))
    throw new Error('Web check custody: retained descriptor file differs from the original prepared identity');
  const reconciled = await reconcileWithRuntime(
    runtime,
    files,
    record,
    record.expected.driverRoot,
    record.expected.hostsFile,
    record.expected.workspace,
    absoluteDescriptor,
    descriptor,
    record.expected,
    record.native,
    process.env,
    record.registered,
    () => {
      record.rejectedEvidence = true;
    },
  );
  if (
    reconciled.cleanedPreparation &&
    !record.rejectedEvidence &&
    record.caller.prepare.state === 'closed' &&
    record.caller.run.state === 'not-started' &&
    !record.native &&
    !replayed.invalid
  ) {
    return finishPrivate(
      runtime,
      files,
      75,
      descriptor,
      null,
      null,
      record.cancellation.requested ? 'settled' : 'none',
      record,
    );
  }
  const status = reconciled.status;
  let final: FinalSettlement | null = record.final;
  let settled = false;
  if (
    status &&
    descriptor &&
    record.native &&
    record.registered &&
    record.caller.prepare.state === 'closed' &&
    record.caller.run.state === 'closed'
  ) {
    try {
      const statusFinal = validateStatusAgainstOriginal(
        status,
        descriptor,
        record.expected,
        record.native,
        record.registered,
      );
      if (statusFinal && (!record.final || jsonSha256(record.final) === jsonSha256(statusFinal))) {
        final = statusFinal;
        if (record.ingress.final.state !== 'received') {
          record.final = statusFinal;
          record.ingress.final = {
            state: 'reconciled',
            start: null,
            end: null,
            rawSha256: null,
            bodySha256: null,
            originalSha256: jsonSha256(statusFinal),
          };
        }
        record.validation.source = statusFinal.preparedInputs.status === 'verified' ? 'verified' : 'rejected';
        record.validation.returns =
          ['empty', 'restored'].includes(statusFinal.returns.status) &&
          statusFinal.returns.missing.length === 0 &&
          statusFinal.returns.failures.length === 0
            ? 'verified'
            : 'rejected';
        const finalWire = record.ingress.final.state === 'received' ? replayed.finalRaw : null;
        settled =
          !replayed.invalid &&
          !record.rejectedEvidence &&
          !status.rejectedObservation &&
          record.ingress.complete &&
          record.ingress.native.state === 'received' &&
          record.validation.source === 'verified' &&
          record.validation.returns === 'verified' &&
          finalCustodySettled(status, statusFinal, finalWire, record.registered);
      }
    } catch {
      record.rejectedEvidence = true;
    }
  }
  persistRecord(files, record);
  if (!settled) {
    if (
      status &&
      !record.rejectedEvidence &&
      !replayed.invalid &&
      record.caller.prepare.state === 'closed' &&
      record.caller.run.state === 'not-started' &&
      !record.native &&
      isCancellationSettled(status)
    ) {
      const code = status.cancellation.signal === null ? 143 : 128 + status.cancellation.signal;
      return finishPrivate(runtime, files, code, descriptor, null, null, 'settled', record);
    }
    return outcome(
      record.native?.receipt.exitCode && record.native.receipt.exitCode !== 0 ? record.native.receipt.exitCode : 75,
      files,
      descriptor,
      record.native,
      final,
      'occupied',
      'retained',
      record.cancellation.requested || status?.phase === 'cancel-requested' ? 'requested' : 'unknown',
      status?.finalCustody?.aggregate ?? 'unknown',
    );
  }
  return finishPrivate(
    runtime,
    files,
    record.native!.receipt.exitCode,
    descriptor,
    record.native,
    final,
    record.cancellation.requested ? 'settled' : 'none',
    record,
    status?.finalCustody?.aggregate ?? 'unknown',
  );
}

function descriptorFromRetainedFile(
  descriptorFile: string,
  expected: ExpectedInvocation,
): PreparedCheckRunDescriptor | null {
  try {
    const stat = lstatSync(descriptorFile);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_DESCRIPTOR_BYTES || (stat.mode & 0o077) !== 0)
      return null;
    const raw = readFileSync(descriptorFile, 'utf8');
    if (!raw.endsWith('\n') || raw.includes('\r') || raw.split('\n').length !== 2) return null;
    const descriptor = validateDescriptor(parseUniqueJson(raw.slice(0, -1)));
    validatePreparedBinding(descriptor, expected);
    return descriptor;
  } catch {
    return null;
  }
}

export type WebCheckDriverProcessRuntime = {
  spawn: (command: string, args: string[], options: SpawnOptions) => ReturnType<typeof spawn>;
  setTimer: (callback: () => void, delayMs: number) => unknown;
  clearTimer: (timer: unknown) => void;
  probeGroup: (pid: number) => boolean | null;
  signalGroup: (pid: number, signal: NodeJS.Signals) => boolean | null;
  now: () => string;
};

const processRuntime: WebCheckDriverProcessRuntime = {
  spawn: (command, args, options) => spawn(command, args, options),
  setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
  probeGroup(pid) {
    if (process.platform === 'win32') return null;
    try {
      process.kill(-pid, 0);
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ESRCH') return false;
      if (code === 'EPERM') return true;
      return null;
    }
  },
  signalGroup(pid, signal) {
    if (process.platform === 'win32') return null;
    try {
      process.kill(-pid, signal);
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ESRCH') return false;
      return code === 'EPERM' ? null : null;
    }
  },
  now: () => new Date().toISOString(),
};

function recoveryPhase(phase: WebCheckDriverInvocation['phase']): phase is 'status' | 'reconcile' {
  return phase === 'status' || phase === 'reconcile';
}

/** Production process lifetime boundary; tests inject process events and timers through the same seam. */
export function runWebCheckDriverProcess(
  input: WebCheckDriverInvocation,
  processAdapter: WebCheckDriverProcessRuntime = processRuntime,
): Promise<WebCheckDriverProcess> {
  return new Promise((resolvePromise) => {
    const isReceipt = input.phase === 'run-prepared';
    const isRecovery = recoveryPhase(input.phase);
    const limits = isRecovery ? (input.limits ?? WEB_CHECK_RECOVERY_LIMITS) : undefined;
    const stdio: ('inherit' | 'ignore' | 'pipe')[] = isReceipt
      ? ['ignore', 'inherit', 'inherit', 'pipe']
      : ['ignore', 'pipe', 'inherit'];
    const options: SpawnOptions = {
      cwd: input.cwd,
      env: input.env,
      stdio,
      ...(isRecovery ? { detached: true } : {}),
    };
    const child = processAdapter.spawn(input.command[0]!, input.command.slice(1), options);
    const pid = child.pid ?? null;
    const startedAt = processAdapter.now();
    const outputChunks: Buffer[] = [];
    let outputBytes = 0;
    let outputOverflow = false;
    let parentClosed = false;
    let outputClosed = !(isReceipt ? child.stdio[3] : child.stdout);
    let groupClosed: boolean | null = isRecovery ? null : true;
    let code: number | null = null;
    let signal: NodeJS.Signals | null = null;
    let received: NodeJS.Signals | null = null;
    let timedOut = false;
    let cancelled = false;
    let terminationStarted = false;
    let resolved = false;
    let finalSettlementDeadlineStarted = false;
    let signalHandler: (() => void) | undefined;
    const timers = new Set<unknown>();
    const schedule = (callback: () => void, delay: number) => {
      if (resolved) return undefined;
      const timer = processAdapter.setTimer(() => {
        timers.delete(timer);
        callback();
      }, delay);
      timers.add(timer);
      return timer;
    };
    const clearTimers = () => {
      for (const timer of timers) processAdapter.clearTimer(timer);
      timers.clear();
    };
    const facts = (): WebCheckHelperLifetime => ({
      parentClosed,
      outputClosed,
      groupClosed,
      timedOut,
      cancelled,
      outputOverflow,
    });
    const notify = () => {
      try {
        input.onLifetime?.(facts());
      } catch {
        /* The durable receiver keeps custody unknown on journal failure. */
      }
    };
    const finish = (closed: boolean) => {
      if (resolved) return;
      resolved = true;
      clearTimers();
      if (input.signal && signalHandler) input.signal.removeEventListener('abort', signalHandler);
      else if (signalHandler) {
        process.off('SIGINT', signalHandler);
        process.off('SIGTERM', signalHandler);
        process.off('SIGHUP', signalHandler);
      }
      notify();
      resolvePromise({
        code,
        signal: signal ?? received,
        closed,
        output: Buffer.concat(outputChunks, outputBytes).toString('utf8'),
        outputOverflow,
        parentClosed,
        outputClosed,
        groupClosed,
        timedOut,
        cancelled,
      });
      if (parentClosed && outputClosed && groupClosed === true) detachLifecycleListeners();
    };
    const allClosed = () => parentClosed && outputClosed && (!isRecovery || groupClosed === true);
    const maybeFinish = () => {
      notify();
      if (allClosed()) {
        if (resolved) detachLifecycleListeners();
        else finish(true);
      }
    };
    const probeGroup = () => {
      if (!isRecovery) {
        groupClosed = true;
        return;
      }
      const present = pid === null ? null : processAdapter.probeGroup(pid);
      groupClosed = present === null ? null : !present;
    };
    const signalProcess = (next: NodeJS.Signals) => {
      if (isRecovery && pid !== null) {
        const sent = processAdapter.signalGroup(pid, next);
        if (sent === false) groupClosed = true;
        else if (sent === null) groupClosed = null;
      } else {
        try {
          child.kill(next);
        } catch {
          /* Closure remains unknown until an event proves it. */
        }
      }
    };
    const beginTermination = (reason: 'timeout' | 'cancel' | 'cleanup', next: NodeJS.Signals = 'SIGTERM') => {
      if (terminationStarted || (parentClosed && outputClosed && groupClosed === true)) return;
      terminationStarted = true;
      if (reason === 'timeout') timedOut = true;
      if (reason === 'cancel') cancelled = true;
      if (reason !== 'cleanup') received = next;
      signalProcess('SIGTERM');
      notify();
      const grace = limits?.terminationGraceMs ?? 15_000;
      const settle = limits?.terminationSettleMs ?? 5_000;
      schedule(() => {
        if (allClosed()) return finish(true);
        signalProcess('SIGKILL');
        schedule(() => {
          if (isRecovery) probeGroup();
          if (allClosed()) finish(true);
          else if (isRecovery) startFinalSettlementDeadline();
          else finish(false);
        }, settle);
      }, grace);
    };
    const startFinalSettlementDeadline = () => {
      if (!limits || finalSettlementDeadlineStarted) return;
      finalSettlementDeadlineStarted = true;
      // Bound unresolved parent, output, or group custody independently of which stream closed first.
      schedule(() => {
        if (allClosed()) maybeFinish();
        else finish(false);
      }, limits.outputSettleMs);
    };
    const afterParentClose = () => {
      if (isRecovery) {
        probeGroup();
        if (groupClosed === false && !terminationStarted) beginTermination('cleanup');
        else if (groupClosed === null && !terminationStarted)
          schedule(() => finish(false), limits?.outputSettleMs ?? 5_000);
        else if (groupClosed === true) startFinalSettlementDeadline();
      } else startFinalSettlementDeadline();
      maybeFinish();
    };
    const onParentExit = (exitCode: number | null, exitSignal: NodeJS.Signals | null) => {
      parentClosed = true;
      code = exitCode;
      signal = exitSignal;
      afterParentClose();
    };
    const onOutputClose = () => {
      outputClosed = true;
      if (isRecovery && parentClosed) {
        probeGroup();
        if (groupClosed === false && !terminationStarted) beginTermination('cleanup');
      }
      maybeFinish();
    };
    const onChildClose = (exitCode: number | null, exitSignal: NodeJS.Signals | null) => {
      if (!parentClosed) onParentExit(exitCode, exitSignal);
      outputClosed = true;
      if (isRecovery) {
        probeGroup();
        if (groupClosed === false && !terminationStarted) beginTermination('cleanup');
      }
      maybeFinish();
    };
    const detachLifecycleListeners = () => {
      child.off('exit', onParentExit);
      child.off('close', onChildClose);
      outputStream?.off('close', onOutputClose);
      receiptStream?.off('close', onOutputClose);
    };
    const outputStream = isReceipt ? null : child.stdout;
    const receiptStream = isReceipt ? child.stdio[3] : null;
    const cap = isRecovery ? MAX_STATUS_BYTES : MAX_DESCRIPTOR_BYTES;
    outputStream?.on('data', (chunk: Buffer) => {
      if (outputOverflow || outputBytes + chunk.length > cap) {
        outputOverflow = true;
        notify();
        return;
      }
      outputChunks.push(Buffer.from(chunk));
      outputBytes += chunk.length;
    });
    receiptStream?.on('data', (chunk: Buffer) => input.onReceipt?.(chunk));
    outputStream?.once('close', onOutputClose);
    receiptStream?.once('close', onOutputClose);
    child.once('exit', onParentExit);
    child.once('close', onChildClose);
    child.once('error', () => {
      // A spawn error has no terminal authority; wait for close or the bounded recovery lifetime.
    });
    if (isRecovery) {
      try {
        input.onStart?.({ pid, startedAt });
      } catch {
        beginTermination('cleanup');
      }
    }
    if (input.signal) {
      signalHandler = () => beginTermination('cancel');
      input.signal.addEventListener('abort', signalHandler, { once: true });
      if (input.signal.aborted) signalHandler();
    } else {
      signalHandler = () => beginTermination('cancel');
      process.on('SIGINT', signalHandler);
      process.on('SIGTERM', signalHandler);
      process.on('SIGHUP', signalHandler);
    }
    if (limits) schedule(() => beginTermination('timeout'), limits.observationMs);
  });
}

export function createWebCheckPrivateFiles(values: Record<string, string>): WebCheckPrivateFiles {
  const directory = mkdtempSync(join(tmpdir(), 'rezics-web-check-'));
  chmodSync(directory, PRIVATE_DIRECTORY_MODE);
  const environmentFile = join(directory, 'environment.json');
  const descriptorFile = join(directory, 'prepared-descriptor.json');
  const recordFile = join(directory, 'web-custody.json');
  const evidenceFile = join(directory, 'receipts.ndjson');
  const environmentHandle = openSync(environmentFile, 'wx', PRIVATE_FILE_MODE);
  try {
    writeSync(environmentHandle, JSON.stringify(values));
    fsyncSync(environmentHandle);
  } finally {
    closeSync(environmentHandle);
  }
  const evidenceHandle = openSync(evidenceFile, 'wx', PRIVATE_FILE_MODE);
  try {
    fsyncSync(evidenceHandle);
  } finally {
    closeSync(evidenceHandle);
  }
  return {
    directory,
    environmentFile,
    descriptorFile,
    recordFile,
    evidenceFile,
    close: () => rmSync(directory, { recursive: true }),
  };
}

export const webCheckCustodyRuntime: WebCheckCustodyRuntime = {
  invoke: runWebCheckDriverProcess,
  cleanup: (files) => files.close(),
};

if (import.meta.main) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 3 || args[0] !== 'reconcile' || args[1] !== '--descriptor' || !isAbsolute(args[2]!))
      throw new Error(
        'Usage: bun apps/web/scripts/check-placement-custody.ts reconcile --descriptor <absolute-private-json>',
      );
    const result = await reconcileWebCheckCustody(args[2]!);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exitCode = result.code;
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 75;
  }
}
