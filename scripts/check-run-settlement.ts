import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { withCheckFence } from './check-custody.ts';
import {
  executionCancellation,
  parseRemotePhysicalRunReceipt,
  requestExecutionCancellation,
  type RemotePhysicalRunReceipt,
} from './remote-check.ts';

export const CHECK_RUN_SETTLEMENT_SCHEMA = 1 as const;
export const CHECK_RUN_SETTLEMENT_MAX_BYTES = 64 * 1024;
export const CHECK_RUN_INVOCATION_RECORD_MAX_BYTES = 8 * 1024 * 1024;
export const CHECK_RUN_SETTLEMENT_MAX_ITEMS = 64;
export const CHECK_RUN_SETTLEMENT_MAX_TEXT = 2048;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH = /^[0-9a-f]{64}$/;
const REVISION = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const PHYSICAL_RUN = /^[a-zA-Z0-9-]{1,96}$/;

export type CheckRunInvocationBinding = {
  sourceRevision: string;
  indexTree: string;
  sourceSha256: string;
  argvSha256: string;
  cwd: string;
  semanticEnvironmentSha256: string;
  relocatedEnvironmentSha256: string;
  producerClosureSha256: string;
  hostsSha256: string;
  preparationCommandsSha256: string;
  returnsSha256: string;
};

export type CheckRunPhysicalIdentity = { host: 'a' | 'b'; run: string };
export type CheckRunTransportChildIdentity = { pid: number; bootId: string; start: string };

export type CheckRunNativeDisposition = {
  exitCode: number;
  lifetimeFailure: boolean;
  receiptSha256: string;
};

export type CheckRunPreparedInputs = {
  status: 'verified' | 'unavailable';
  sourceSha256: string | null;
  manifestSha256: string | null;
  fileCount: number;
  totalBytes: number;
};

export type CheckRunReturnedArtifact = { path: string; size: number; sha256: string };

export type CheckRunReturnDisposition = {
  status: 'empty' | 'restored' | 'missing' | 'failed' | 'unknown';
  declarationsSha256: string;
  entries: CheckRunReturnedArtifact[];
  missing: string[];
  failures: string[];
};

export type CheckRunCleanupDisposition = {
  disposition: 'settled' | 'unknown';
  remote: 'verified' | 'failed' | 'unknown';
  transportChild: 'reaped' | 'unknown';
  source: 'verified' | 'changed' | 'unknown';
  localWorktree: 'removed' | 'retained' | 'unknown';
  failures: string[];
};

export type CheckRunFinalSettlement = {
  schema: 1;
  type: 'final-settlement';
  invocationId: string;
  nonce: string;
  binding: CheckRunInvocationBinding;
  physical: CheckRunPhysicalIdentity;
  native: CheckRunNativeDisposition | null;
  preparedInputs: CheckRunPreparedInputs;
  returns: CheckRunReturnDisposition;
  cleanup: CheckRunCleanupDisposition;
  failures: { primary: string[]; cleanup: string[] };
};

export type CheckRunNativeTerminalMessage = {
  schema: 1;
  type: 'native-terminal';
  invocationId: string;
  nonce: string;
  binding: CheckRunInvocationBinding;
  physical: CheckRunPhysicalIdentity;
  receipt: RemotePhysicalRunReceipt;
};

export type CheckRunMessage = CheckRunNativeTerminalMessage | CheckRunFinalSettlement;

export type CheckRunInvocationPhase =
  | 'registered'
  | 'queued'
  | 'uploading'
  | 'running'
  | 'native-terminal'
  | 'settled'
  | 'unknown'
  | 'cancel-requested'
  | 'cancelled';

export type CheckRunInvocationRecord = {
  schema: 1;
  invocationId: string;
  nonce: string;
  createdAt: string;
  updatedAt: string;
  phase: CheckRunInvocationPhase;
  binding: CheckRunInvocationBinding;
  physical: CheckRunPhysicalIdentity | null;
  transportChild: CheckRunTransportChildIdentity | null;
  native: CheckRunNativeDisposition | null;
  snapshot: { workspace: string; scratch: string; sourceSha256: string; inputFiles: string[] } | null;
  candidateWorkspace: string | null;
  returns: string[];
  cancellation: { requested: boolean; signal: 1 | 2 | 15 | null };
  final: CheckRunFinalSettlement | null;
  failure: string | null;
};

export type CheckRunRegistration = {
  invocationId: string;
  nonce: string;
  binding: CheckRunInvocationBinding;
  cancellation: { file: string; id: string };
};

export type CheckRunStateOptions = { stateDirectory?: string };

export type CheckRunMessageExpectation = {
  invocationId: string;
  nonce: string;
  binding: CheckRunInvocationBinding;
  physical?: CheckRunPhysicalIdentity;
  nativeTerminalSeen: boolean;
};

export type CheckRunReconciliation =
  | { disposition: 'settled'; final: CheckRunFinalSettlement }
  | { disposition: 'unknown'; reason: string };

export type CheckRunReconcileOptions = CheckRunStateOptions & {
  force?: boolean;
  reconcilePhysical?: (
    physical: CheckRunPhysicalIdentity,
    record: CheckRunInvocationRecord,
  ) => Promise<CheckRunReconciliation>;
};

function closedObject(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
    Reflect.ownKeys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  ) {
    throw new Error(`check-run-settlement: invalid ${label}`);
  }
  return value as Record<string, unknown>;
}

function boundedText(value: unknown, label: string, max = CHECK_RUN_SETTLEMENT_MAX_TEXT): string {
  if (typeof value !== 'string' || value.length > max || /[\0\r]/.test(value)) {
    throw new Error(`check-run-settlement: invalid ${label}`);
  }
  return value;
}

function boundedHash(value: unknown, label: string): string {
  if (typeof value !== 'string' || !HASH.test(value)) throw new Error(`check-run-settlement: invalid ${label}`);
  return value;
}

function boundedCount(value: unknown, label: string, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) {
    throw new Error(`check-run-settlement: invalid ${label}`);
  }
  return value as number;
}

export function validateCheckRunInvocationBinding(value: unknown): CheckRunInvocationBinding {
  const item = closedObject(
    value,
    [
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
    ],
    'invocation binding',
  );
  if (typeof item.sourceRevision !== 'string' || !REVISION.test(item.sourceRevision))
    throw new Error('check-run-settlement: invalid candidate revision');
  if (typeof item.indexTree !== 'string' || !REVISION.test(item.indexTree))
    throw new Error('check-run-settlement: invalid candidate index tree');
  if (item.sourceRevision.length !== item.indexTree.length)
    throw new Error('check-run-settlement: candidate revision and index object formats differ');
  const cwd = boundedText(item.cwd, 'workspace-relative cwd', 4096);
  if (
    !cwd ||
    (cwd !== '.' &&
      (cwd.startsWith('/') ||
        /^[A-Za-z]:/.test(cwd) ||
        /[\\\0\r\n]/.test(cwd) ||
        cwd.split('/').some((part) => ['.', '..', ''].includes(part))))
  )
    throw new Error('check-run-settlement: cwd must be workspace-relative');
  return {
    sourceRevision: item.sourceRevision,
    indexTree: item.indexTree,
    sourceSha256: boundedHash(item.sourceSha256, 'candidate source hash'),
    argvSha256: boundedHash(item.argvSha256, 'argv hash'),
    cwd,
    semanticEnvironmentSha256: boundedHash(item.semanticEnvironmentSha256, 'semantic environment hash'),
    relocatedEnvironmentSha256: boundedHash(item.relocatedEnvironmentSha256, 'relocated environment hash'),
    producerClosureSha256: boundedHash(item.producerClosureSha256, 'trusted producer closure hash'),
    hostsSha256: boundedHash(item.hostsSha256, 'host configuration hash'),
    preparationCommandsSha256: boundedHash(item.preparationCommandsSha256, 'preparation command hash'),
    returnsSha256: boundedHash(item.returnsSha256, 'declared returns hash'),
  };
}

function validatePhysical(value: unknown): CheckRunPhysicalIdentity {
  const item = closedObject(value, ['host', 'run'], 'physical identity');
  if (item.host !== 'a' && item.host !== 'b') throw new Error('check-run-settlement: invalid physical host');
  const run = boundedText(item.run, 'physical run id', 96);
  if (!PHYSICAL_RUN.test(run)) throw new Error('check-run-settlement: invalid physical run id');
  return { host: item.host, run };
}

function validateTransportChild(value: unknown): CheckRunTransportChildIdentity {
  const item = closedObject(value, ['pid', 'bootId', 'start'], 'local transport child identity');
  const pid = boundedCount(item.pid, 'local transport child pid', 2 ** 31 - 1);
  const bootId = boundedText(item.bootId, 'local transport child boot id', 64);
  const start = boundedText(item.start, 'local transport child start time', 32);
  if (pid < 1 || !/^[0-9a-f-]{36}$/i.test(bootId) || !/^\d+$/.test(start))
    throw new Error('check-run-settlement: invalid local transport child identity');
  return { pid, bootId, start };
}

function validateNative(value: unknown): CheckRunNativeDisposition | null {
  if (value === null) return null;
  const item = closedObject(value, ['exitCode', 'lifetimeFailure', 'receiptSha256'], 'native result');
  if (!Number.isInteger(item.exitCode) || (item.exitCode as number) < 0 || (item.exitCode as number) > 255)
    throw new Error('check-run-settlement: invalid native exit code');
  if (typeof item.lifetimeFailure !== 'boolean') throw new Error('check-run-settlement: invalid native lifetime status');
  return {
    exitCode: item.exitCode as number,
    lifetimeFailure: item.lifetimeFailure,
    receiptSha256: boundedHash(item.receiptSha256, 'native receipt hash'),
  };
}

function validatePreparedInputs(value: unknown): CheckRunPreparedInputs {
  const item = closedObject(value, ['status', 'sourceSha256', 'manifestSha256', 'fileCount', 'totalBytes'], 'prepared inputs');
  if (item.status !== 'verified' && item.status !== 'unavailable')
    throw new Error('check-run-settlement: invalid prepared input status');
  const sourceSha256 = item.sourceSha256 === null ? null : boundedHash(item.sourceSha256, 'prepared source hash');
  const manifestSha256 = item.manifestSha256 === null ? null : boundedHash(item.manifestSha256, 'prepared manifest hash');
  const fileCount = boundedCount(item.fileCount, 'prepared input file count', 50_000);
  const totalBytes = boundedCount(item.totalBytes, 'prepared input byte count', 1024 * 1024 * 1024);
  if (item.status === 'verified' && (!sourceSha256 || !manifestSha256))
    throw new Error('check-run-settlement: verified prepared inputs need source and manifest hashes');
  if (item.status === 'unavailable' && (sourceSha256 || manifestSha256))
    throw new Error('check-run-settlement: unavailable prepared inputs cannot claim hashes');
  return { status: item.status, sourceSha256, manifestSha256, fileCount, totalBytes };
}

function validatePathList(value: unknown, label: string, unique: boolean): string[] {
  if (!Array.isArray(value) || value.length > CHECK_RUN_SETTLEMENT_MAX_ITEMS)
    throw new Error(`check-run-settlement: invalid ${label}`);
  const paths = value.map((path) => {
    const result = boundedText(path, label, 1024);
    if (
      !result ||
      result.startsWith('/') ||
      /^[A-Za-z]:/.test(result) ||
      /[\\\0\r\n]/.test(result) ||
      result.split('/').some((part) => ['.', '..', ''].includes(part))
    )
      throw new Error(`check-run-settlement: invalid ${label}`);
    return result;
  });
  if (unique && new Set(paths).size !== paths.length) throw new Error(`check-run-settlement: duplicate ${label}`);
  return paths;
}

function validateReturns(value: unknown): CheckRunReturnDisposition {
  const item = closedObject(
    value,
    ['status', 'declarationsSha256', 'entries', 'missing', 'failures'],
    'return disposition',
  );
  if (!['empty', 'restored', 'missing', 'failed', 'unknown'].includes(String(item.status)))
    throw new Error('check-run-settlement: invalid return status');
  if (!Array.isArray(item.entries) || item.entries.length > CHECK_RUN_SETTLEMENT_MAX_ITEMS)
    throw new Error('check-run-settlement: invalid returned artifact manifest');
  const entries = item.entries.map((entry) => {
    const artifact = closedObject(entry, ['path', 'size', 'sha256'], 'returned artifact');
    const path = validatePathList([artifact.path], 'returned artifact path', true)[0]!;
    return {
      path,
      size: boundedCount(artifact.size, 'returned artifact size', 256 * 1024 * 1024),
      sha256: boundedHash(artifact.sha256, 'returned artifact hash'),
    };
  });
  if (entries.reduce((total, entry) => total + entry.size, 0) > 256 * 1024 * 1024)
    throw new Error('check-run-settlement: returned artifacts exceed their aggregate byte bound');
  if (new Set(entries.map(({ path }) => path)).size !== entries.length)
    throw new Error('check-run-settlement: duplicate returned artifact path');
  const missing = validatePathList(item.missing, 'missing return path', true);
  const failures = validateStringList(item.failures, 'return failure');
  return {
    status: item.status as CheckRunReturnDisposition['status'],
    declarationsSha256: boundedHash(item.declarationsSha256, 'return declaration hash'),
    entries,
    missing,
    failures,
  };
}

function validateStringList(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length > CHECK_RUN_SETTLEMENT_MAX_ITEMS)
    throw new Error(`check-run-settlement: invalid ${label} list`);
  return value.map((item) => boundedText(item, label));
}

function parseUniqueJson(raw: string): unknown {
  const source = raw;
  let index = 0;
  let nodes = 0;
  const whitespace = () => {
    while (index < source.length && /[\t\n\r ]/.test(source[index]!)) index += 1;
  };
  const stringToken = (): string => {
    if (source[index] !== '"') throw new Error('check-run-settlement: malformed JSON string');
    const start = index++;
    while (index < source.length) {
      const char = source[index++]!;
      if (char === '"') return JSON.parse(source.slice(start, index)) as string;
      if (char === '\\') index += 1;
      else if (char.charCodeAt(0) < 0x20) throw new Error('check-run-settlement: malformed JSON string');
    }
    throw new Error('check-run-settlement: incomplete JSON string');
  };
  const value = (depth: number): void => {
    if (depth > 64 || ++nodes > 20_000) throw new Error('check-run-settlement: JSON structure exceeds its bound');
    whitespace();
    const char = source[index];
    if (char === '{') {
      index += 1;
      whitespace();
      const keys = new Set<string>();
      if (source[index] === '}') {
        index += 1;
        return;
      }
      while (true) {
        whitespace();
        const key = stringToken();
        if (keys.has(key)) throw new Error('check-run-settlement: duplicate JSON object key');
        keys.add(key);
        whitespace();
        if (source[index++] !== ':') throw new Error('check-run-settlement: malformed JSON object');
        value(depth + 1);
        whitespace();
        const separator = source[index++];
        if (separator === '}') return;
        if (separator !== ',') throw new Error('check-run-settlement: malformed JSON object');
      }
    }
    if (char === '[') {
      index += 1;
      whitespace();
      if (source[index] === ']') {
        index += 1;
        return;
      }
      let count = 0;
      while (true) {
        if (++count > 4096) throw new Error('check-run-settlement: JSON array exceeds its bound');
        value(depth + 1);
        whitespace();
        const separator = source[index++];
        if (separator === ']') return;
        if (separator !== ',') throw new Error('check-run-settlement: malformed JSON array');
      }
    }
    if (char === '"') {
      stringToken();
      return;
    }
    const literal = source.slice(index).match(/^(?:true|false|null)(?![A-Za-z0-9_$])/);
    if (literal) {
      index += literal[0].length;
      return;
    }
    const number = source.slice(index).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);
    if (!number) throw new Error('check-run-settlement: malformed JSON value');
    index += number[0].length;
  };
  value(0);
  whitespace();
  if (index !== source.length) throw new Error('check-run-settlement: trailing JSON data');
  return JSON.parse(source);
}

function validateInputFiles(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 50_000)
    throw new Error('check-run-settlement: invalid frozen input file list');
  const paths = value.map((path) => {
    const result = boundedText(path, 'frozen input path', 1024);
    if (
      !result ||
      result.startsWith('/') ||
      /^[A-Za-z]:/.test(result) ||
      result.split('/').some((part) => ['.', '..', ''].includes(part))
    )
      throw new Error('check-run-settlement: invalid frozen input path');
    return result;
  });
  if (new Set(paths).size !== paths.length) throw new Error('check-run-settlement: duplicate frozen input path');
  return paths;
}

function validateCleanup(value: unknown): CheckRunCleanupDisposition {
  const item = closedObject(
    value,
    ['disposition', 'remote', 'transportChild', 'source', 'localWorktree', 'failures'],
    'cleanup disposition',
  );
  if (item.disposition !== 'settled' && item.disposition !== 'unknown')
    throw new Error('check-run-settlement: invalid cleanup disposition');
  if (!['verified', 'failed', 'unknown'].includes(String(item.remote)))
    throw new Error('check-run-settlement: invalid remote cleanup disposition');
  if (item.transportChild !== 'reaped' && item.transportChild !== 'unknown')
    throw new Error('check-run-settlement: invalid transport child disposition');
  if (!['verified', 'changed', 'unknown'].includes(String(item.source)))
    throw new Error('check-run-settlement: invalid source disposition');
  if (!['removed', 'retained', 'unknown'].includes(String(item.localWorktree)))
    throw new Error('check-run-settlement: invalid local worktree disposition');
  return {
    disposition: item.disposition,
    remote: item.remote as CheckRunCleanupDisposition['remote'],
    transportChild: item.transportChild,
    source: item.source as CheckRunCleanupDisposition['source'],
    localWorktree: item.localWorktree as CheckRunCleanupDisposition['localWorktree'],
    failures: validateStringList(item.failures, 'cleanup failure'),
  };
}

export function validateCheckRunFinalSettlement(value: unknown): CheckRunFinalSettlement {
  const item = closedObject(
    value,
    ['schema', 'type', 'invocationId', 'nonce', 'binding', 'physical', 'native', 'preparedInputs', 'returns', 'cleanup', 'failures'],
    'final settlement',
  );
  if (item.schema !== CHECK_RUN_SETTLEMENT_SCHEMA || item.type !== 'final-settlement')
    throw new Error('check-run-settlement: unsupported final settlement schema');
  if (typeof item.invocationId !== 'string' || !UUID.test(item.invocationId))
    throw new Error('check-run-settlement: invalid invocation id');
  const nonce = boundedText(item.nonce, 'invocation nonce', 128);
  if (!/^[a-f0-9]{64}$/.test(nonce)) throw new Error('check-run-settlement: invalid invocation nonce');
  const failures = closedObject(item.failures, ['primary', 'cleanup'], 'failure groups');
  const preparedInputs = validatePreparedInputs(item.preparedInputs);
  const returns = validateReturns(item.returns);
  const cleanup = validateCleanup(item.cleanup);
  const native = validateNative(item.native);
  if (!native) throw new Error('check-run-settlement: final settlement needs a native terminal result');
  if (
    cleanup.disposition === 'settled' &&
    (preparedInputs.status !== 'verified' ||
      returns.status !== 'empty' && returns.status !== 'restored' ||
      cleanup.remote !== 'verified' ||
      cleanup.transportChild !== 'reaped' ||
      cleanup.source !== 'verified' ||
      cleanup.localWorktree !== 'removed' ||
      cleanup.failures.length > 0 ||
      returns.missing.length > 0 ||
      returns.failures.length > 0)
  )
    throw new Error('check-run-settlement: settled final disposition has incomplete evidence or cleanup');
  return {
    schema: 1,
    type: 'final-settlement',
    invocationId: item.invocationId,
    nonce,
    binding: validateCheckRunInvocationBinding(item.binding),
    physical: validatePhysical(item.physical),
    native,
    preparedInputs,
    returns,
    cleanup,
    failures: {
      primary: validateStringList(failures.primary, 'primary failure'),
      cleanup: validateStringList(failures.cleanup, 'cleanup failure'),
    },
  };
}

export function createCheckRunFinalSettlement(
  value: Omit<CheckRunFinalSettlement, 'schema' | 'type'>,
): CheckRunFinalSettlement {
  return validateCheckRunFinalSettlement({ schema: 1, type: 'final-settlement', ...value });
}

export function encodeCheckRunFinalSettlement(value: CheckRunFinalSettlement): string {
  const serialized = JSON.stringify(validateCheckRunFinalSettlement(value));
  if (Buffer.byteLength(serialized) > CHECK_RUN_SETTLEMENT_MAX_BYTES)
    throw new Error('check-run-settlement: final settlement exceeds its byte bound');
  return serialized;
}

export function decodeCheckRunSettlement(raw: string, expected: CheckRunMessageExpectation): CheckRunFinalSettlement {
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > CHECK_RUN_SETTLEMENT_MAX_BYTES)
    throw new Error('check-run-settlement: message exceeds its byte bound');
  const line = raw.endsWith('\n') ? raw.slice(0, -1) : raw;
  if (!line || line.includes('\n') || line.includes('\r'))
    throw new Error('check-run-settlement: expected one complete message');
  let parsed: unknown;
  try {
    parsed = parseUniqueJson(line);
  } catch {
    throw new Error('check-run-settlement: malformed or partial message');
  }
  const message = validateCheckRunFinalSettlement(parsed);
  if (!expected.nativeTerminalSeen) throw new Error('check-run-settlement: final settlement arrived before native terminal');
  if (message.invocationId !== expected.invocationId) throw new Error('check-run-settlement: foreign invocation id');
  if (message.nonce !== expected.nonce) throw new Error('check-run-settlement: wrong invocation nonce');
  if (checkRunBindingHash(message.binding) !== checkRunBindingHash(expected.binding))
    throw new Error('check-run-settlement: candidate, argv, environment, producer, host, preparation or return binding mismatch');
  if (
    expected.physical &&
    (message.physical.host !== expected.physical.host || message.physical.run !== expected.physical.run)
  )
    throw new Error('check-run-settlement: physical invocation mismatch');
  if (message.native && expected.physical?.host !== undefined && message.physical.host !== expected.physical.host)
    throw new Error('check-run-settlement: native result host mismatch');
  return message;
}

export function createCheckRunNativeTerminalMessage(
  value: Omit<CheckRunNativeTerminalMessage, 'schema' | 'type'>,
): CheckRunNativeTerminalMessage {
  const receipt = validateNativeReceipt(value.receipt);
  if (!receipt || receipt.host !== value.physical.host || receipt.run !== value.physical.run)
    throw new Error('check-run-settlement: invalid native terminal receipt');
  const message: CheckRunNativeTerminalMessage = {
    schema: 1,
    type: 'native-terminal',
    invocationId: value.invocationId,
    nonce: value.nonce,
    binding: validateCheckRunInvocationBinding(value.binding),
    physical: validatePhysical(value.physical),
    receipt,
  };
  if (!UUID.test(message.invocationId) || !/^[a-f0-9]{64}$/.test(message.nonce))
    throw new Error('check-run-settlement: invalid native terminal invocation identity');
  if (Buffer.byteLength(JSON.stringify(message)) > CHECK_RUN_SETTLEMENT_MAX_BYTES)
    throw new Error('check-run-settlement: native terminal message exceeds its byte bound');
  return message;
}

function validateNativeReceipt(value: unknown): RemotePhysicalRunReceipt | null {
  try {
    const receipt = closedObject(
      value,
      ['schema', 'host', 'run', 'exitCode', 'lifetimeFailure', 'resources'],
      'native receipt',
    );
    if (receipt.lifetimeFailure !== null) {
      const failure = closedObject(
        receipt.lifetimeFailure,
        ['schema', 'status', 'phase', 'host', 'run', 'limitMs', 'elapsedMs', 'command'],
        'native lifetime failure',
      );
      boundedText(failure.command, 'native lifetime command', 256);
    }
    if (receipt.resources !== null) {
      const resources = closedObject(
        receipt.resources,
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
        'native resources',
      );
      boundedText(resources.boot, 'native resource boot id', 64);
      const supervisor = closedObject(resources.supervisor, ['pid', 'start', 'group'], 'native supervisor');
      boundedText(supervisor.start, 'native supervisor start', 32);
      if (resources.cgroup !== null) {
        const cgroup = closedObject(resources.cgroup, ['path', 'device', 'inode', 'invocation'], 'native cgroup');
        boundedText(cgroup.path, 'native cgroup path', 4096);
        boundedText(cgroup.invocation, 'native systemd invocation', 128);
      }
      if (!Array.isArray(resources.samples) || resources.samples.length > 1444)
        throw new Error('check-run-settlement: native resource samples exceed their bound');
      for (const sample of resources.samples) {
        const item = closedObject(
          sample,
          ['monoMs', 'phase', 'usageUsec', 'memoryPeakBytes', 'intervalMs', 'cores', 'unavailable'],
          'native resource sample',
        );
        if (item.unavailable !== null) boundedText(item.unavailable, 'native unavailable reason', 256);
      }
    }
    return parseRemotePhysicalRunReceipt(value);
  } catch {
    return null;
  }
}

export function decodeCheckRunMessage(raw: string, expected: CheckRunMessageExpectation): CheckRunMessage {
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > CHECK_RUN_SETTLEMENT_MAX_BYTES)
    throw new Error('check-run-settlement: message exceeds its byte bound');
  const line = raw.endsWith('\n') ? raw.slice(0, -1) : raw;
  if (!line || line.includes('\n') || line.includes('\r'))
    throw new Error('check-run-settlement: expected one complete message');
  let parsed: unknown;
  try {
    parsed = parseUniqueJson(line);
  } catch {
    throw new Error('check-run-settlement: malformed or partial message');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error('check-run-settlement: invalid message');
  const item = parsed as Record<string, unknown>;
  if (item.type === 'final-settlement') return decodeCheckRunSettlement(raw, expected);
  if (item.type !== 'native-terminal') throw new Error('check-run-settlement: unknown message type');
  const record = closedObject(
    item,
    ['schema', 'type', 'invocationId', 'nonce', 'binding', 'physical', 'receipt'],
    'native terminal message',
  );
  if (record.schema !== 1) throw new Error('check-run-settlement: unsupported native terminal schema');
  if (expected.nativeTerminalSeen) throw new Error('check-run-settlement: duplicate or out-of-order native terminal');
  const invocationId = boundedText(record.invocationId, 'invocation id', 64);
  const nonce = boundedText(record.nonce, 'invocation nonce', 128);
  const binding = validateCheckRunInvocationBinding(record.binding);
  const physical = validatePhysical(record.physical);
  if (invocationId !== expected.invocationId) throw new Error('check-run-settlement: foreign invocation id');
  if (nonce !== expected.nonce) throw new Error('check-run-settlement: wrong invocation nonce');
  if (checkRunBindingHash(binding) !== checkRunBindingHash(expected.binding))
    throw new Error('check-run-settlement: native candidate binding mismatch');
  if (expected.physical && (physical.host !== expected.physical.host || physical.run !== expected.physical.run))
    throw new Error('check-run-settlement: native physical invocation mismatch');
  const receiptValue = record.receipt;
  if (!receiptValue || typeof receiptValue !== 'object' || Array.isArray(receiptValue))
    throw new Error('check-run-settlement: invalid native receipt');
  const receipt = validateNativeReceipt(receiptValue);
  if (!receipt || receipt.host !== physical.host || receipt.run !== physical.run)
    throw new Error('check-run-settlement: malformed native receipt');
  const message = createCheckRunNativeTerminalMessage({
    invocationId,
    nonce,
    binding,
    physical,
    receipt,
  });
  if (message.receipt.host !== physical.host) throw new Error('check-run-settlement: native host mismatch');
  return message;
}

function defaultStateDirectory(): string {
  const configured = process.env.REZICS_CHECK_RUN_STATE_DIR;
  if (configured !== undefined) {
    if (!isAbsolute(configured)) throw new Error('check-run-settlement: state directory must be absolute');
    return resolve(configured);
  }
  const xdg = process.env.XDG_STATE_HOME;
  return join(xdg && isAbsolute(xdg) ? xdg : join(homedir(), '.local', 'state'), 'rezics', 'check-runs');
}

export function checkRunSettlementStateDirectory(options: CheckRunStateOptions = {}): string {
  const directory = resolve(options.stateDirectory ?? defaultStateDirectory());
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stats = lstatSync(directory);
  if (!stats.isDirectory() || stats.isSymbolicLink() || (stats.mode & 0o077) !== 0)
    throw new Error('check-run-settlement: state directory must be an owner-private real directory');
  if (typeof process.getuid === 'function' && stats.uid !== process.getuid())
    throw new Error('check-run-settlement: state directory is owned by another user');
  return directory;
}

function assertOutsideCandidate(stateDirectory: string, workspace?: string): void {
  if (!workspace) return;
  const root = resolve(workspace);
  const fromWorkspace = relative(root, stateDirectory);
  const fromState = relative(stateDirectory, root);
  if (
    fromWorkspace === '' ||
    (!fromWorkspace.startsWith('..') && !isAbsolute(fromWorkspace)) ||
    fromState === '' ||
    (!fromState.startsWith('..') && !isAbsolute(fromState))
  ) {
    throw new Error('check-run-settlement: private invocation state must be outside the candidate workspace');
  }
}

function recordPath(directory: string, id: string): string {
  if (!UUID.test(id)) throw new Error('check-run-settlement: invalid invocation id');
  return join(directory, `${id.toLowerCase()}.json`);
}

function cancellationFile(directory: string, id: string): string {
  return join(directory, `${id.toLowerCase()}.cancel.json`);
}

function syncDirectory(directory: string): void {
  const descriptor = openSync(directory, 'r');
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function writeRecord(directory: string, record: CheckRunInvocationRecord): void {
  const path = recordPath(directory, record.invocationId);
  const encoded = `${JSON.stringify(record)}\n`;
  if (Buffer.byteLength(encoded) > CHECK_RUN_INVOCATION_RECORD_MAX_BYTES)
    throw new Error('check-run-settlement: invocation record exceeds its byte bound');
  const temporary = `${path}.${process.pid}.${randomUUID()}.pending`;
  const descriptor = openSync(temporary, 'wx', 0o600);
  try {
    const bytes = Buffer.from(encoded);
    let offset = 0;
    while (offset < bytes.byteLength) offset += writeSync(descriptor, bytes, offset, bytes.byteLength - offset);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  renameSync(temporary, path);
  syncDirectory(directory);
}

function validateRecord(value: unknown): CheckRunInvocationRecord {
  const item = closedObject(
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
      'returns',
      'cancellation',
      'final',
      'failure',
    ],
    'invocation record',
  );
  if (item.schema !== 1 || typeof item.invocationId !== 'string' || !UUID.test(item.invocationId))
    throw new Error('check-run-settlement: invalid invocation record identity');
  const nonce = boundedText(item.nonce, 'invocation nonce', 128);
  if (!/^[a-f0-9]{64}$/.test(nonce)) throw new Error('check-run-settlement: invalid invocation record nonce');
  if (
    !['registered', 'queued', 'uploading', 'running', 'native-terminal', 'settled', 'unknown', 'cancel-requested', 'cancelled'].includes(
      String(item.phase),
    )
  )
    throw new Error('check-run-settlement: invalid invocation phase');
  const cancellation = closedObject(item.cancellation, ['requested', 'signal'], 'cancellation state');
  if (
    typeof cancellation.requested !== 'boolean' ||
    (cancellation.signal !== null && ![1, 2, 15].includes(Number(cancellation.signal)))
  )
    throw new Error('check-run-settlement: invalid cancellation state');
  let snapshot: CheckRunInvocationRecord['snapshot'] = null;
  if (item.snapshot !== null) {
    const rawSnapshot = closedObject(item.snapshot, ['workspace', 'scratch', 'sourceSha256', 'inputFiles'], 'snapshot state');
    const workspace = boundedText(rawSnapshot.workspace, 'frozen workspace path', 4096);
    const scratch = boundedText(rawSnapshot.scratch, 'frozen scratch path', 4096);
    if (!isAbsolute(workspace) || !isAbsolute(scratch)) throw new Error('check-run-settlement: snapshot paths must be absolute');
    snapshot = {
      workspace,
      scratch,
      sourceSha256: boundedHash(rawSnapshot.sourceSha256, 'snapshot source hash'),
      inputFiles: validateInputFiles(rawSnapshot.inputFiles),
    };
  }
  let candidateWorkspace: string | null = null;
  if (item.candidateWorkspace !== null) {
    candidateWorkspace = boundedText(item.candidateWorkspace, 'candidate workspace path', 4096);
    if (!isAbsolute(candidateWorkspace)) throw new Error('check-run-settlement: candidate workspace path must be absolute');
  }
  if (!Array.isArray(item.returns) || item.returns.length > CHECK_RUN_SETTLEMENT_MAX_ITEMS)
    throw new Error('check-run-settlement: invalid declared returns');
  const returns = validatePathList(item.returns, 'declared return path', true);
  const failure = item.failure === null ? null : boundedText(item.failure, 'failure detail');
  return {
    schema: 1,
    invocationId: item.invocationId,
    nonce,
    createdAt: boundedText(item.createdAt, 'creation time', 64),
    updatedAt: boundedText(item.updatedAt, 'update time', 64),
    phase: item.phase as CheckRunInvocationPhase,
    binding: validateCheckRunInvocationBinding(item.binding),
    physical: item.physical === null ? null : validatePhysical(item.physical),
    transportChild: item.transportChild === null ? null : validateTransportChild(item.transportChild),
    native: validateNative(item.native),
    snapshot,
    candidateWorkspace,
    returns,
    cancellation: {
      requested: cancellation.requested,
      signal: cancellation.signal as 1 | 2 | 15 | null,
    },
    final: item.final === null ? null : validateCheckRunFinalSettlement(item.final),
    failure,
  };
}

function readRecord(directory: string, id: string): CheckRunInvocationRecord {
  const file = recordPath(directory, id);
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0)
    throw new Error('check-run-settlement: invocation record is not a private regular file');
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid())
    throw new Error('check-run-settlement: invocation record is owned by another user');
  if (stat.size > CHECK_RUN_INVOCATION_RECORD_MAX_BYTES)
    throw new Error('check-run-settlement: invocation record exceeds its byte bound');
  return validateRecord(JSON.parse(readFileSync(file, 'utf8')));
}

async function mutateRecord<T>(
  id: string,
  options: CheckRunStateOptions,
  operation: (directory: string, record: CheckRunInvocationRecord) => T | Promise<T>,
): Promise<T> {
  const directory = checkRunSettlementStateDirectory(options);
  return withCheckFence(directory, id, async () => {
    const record = readRecord(directory, id);
    const result = await operation(directory, record);
    return result;
  });
}

async function updateRecord(
  directory: string,
  record: CheckRunInvocationRecord,
  update: Partial<CheckRunInvocationRecord>,
): Promise<CheckRunInvocationRecord> {
  const next = validateRecord({ ...record, ...update, updatedAt: new Date().toISOString() });
  writeRecord(directory, next);
  return next;
}

export async function registerCheckRunInvocation(
  bindingValue: CheckRunInvocationBinding,
  options: CheckRunStateOptions & { invocationId?: string; candidateWorkspace?: string } = {},
): Promise<CheckRunRegistration> {
  const binding = validateCheckRunInvocationBinding(bindingValue);
  const directory = checkRunSettlementStateDirectory(options);
  assertOutsideCandidate(directory, options.candidateWorkspace);
  const invocationId = (options.invocationId ?? randomUUID()).toLowerCase();
  if (!UUID.test(invocationId)) throw new Error('check-run-settlement: invocation id must be a UUID');
  return withCheckFence(directory, invocationId, () => {
    const path = recordPath(directory, invocationId);
    if (existsSync(path)) throw new Error('check-run-settlement: invocation id is already registered');
    const now = new Date().toISOString();
    const nonce = randomBytes(32).toString('hex');
    const record: CheckRunInvocationRecord = {
      schema: 1,
      invocationId,
      nonce,
      createdAt: now,
      updatedAt: now,
      phase: 'registered',
      binding,
      physical: null,
      transportChild: null,
      native: null,
      snapshot: null,
      candidateWorkspace: null,
      returns: [],
      cancellation: { requested: false, signal: null },
      final: null,
      failure: null,
    };
    writeRecord(directory, record);
    return {
      invocationId,
      nonce,
      binding,
      cancellation: { file: cancellationFile(directory, invocationId), id: invocationId },
    };
  });
}

export async function getCheckRunStatus(
  invocationId: string,
  options: CheckRunStateOptions = {},
): Promise<CheckRunInvocationRecord> {
  const directory = checkRunSettlementStateDirectory(options);
  return readRecord(directory, invocationId);
}

export async function markCheckRunQueued(
  invocationId: string,
  nonce: string,
  options: CheckRunStateOptions & {
    candidateWorkspace?: string;
    returns?: readonly string[];
    snapshot?: { workspace: string; scratch: string; sourceSha256: string; inputFiles?: readonly string[] };
  } = {},
): Promise<CheckRunInvocationRecord> {
  return mutateRecord(invocationId, options, async (directory, record) => {
    if (record.nonce !== nonce) throw new Error('check-run-settlement: wrong invocation nonce');
    if (record.final) throw new Error('check-run-settlement: invocation is already terminal');
    if (record.cancellation.requested) throw new Error('check-run-settlement: cancelled invocation cannot queue');
    if (record.phase !== 'registered' && record.phase !== 'queued')
      throw new Error(`check-run-settlement: cannot queue from ${record.phase}`);
    if (options.candidateWorkspace) assertOutsideCandidate(directory, options.candidateWorkspace);
    if (record.phase === 'queued') {
      const candidateWorkspace = options.candidateWorkspace ? resolve(options.candidateWorkspace) : record.candidateWorkspace;
      const paths = options.returns ? validatePathList([...options.returns], 'declared return path', true) : record.returns;
      const snapshot = options.snapshot
        ? {
            workspace: resolve(options.snapshot.workspace),
            scratch: resolve(options.snapshot.scratch),
            sourceSha256: boundedHash(options.snapshot.sourceSha256, 'snapshot source hash'),
            inputFiles: validateInputFiles(options.snapshot.inputFiles ?? []),
          }
        : record.snapshot;
      if (
        candidateWorkspace !== record.candidateWorkspace ||
        JSON.stringify(paths) !== JSON.stringify(record.returns) ||
        JSON.stringify(snapshot) !== JSON.stringify(record.snapshot)
      )
        throw new Error('check-run-settlement: queued invocation identity cannot be rebound');
      return record;
    }
    return updateRecord(directory, record, {
      phase: 'queued',
      candidateWorkspace: options.candidateWorkspace ? resolve(options.candidateWorkspace) : record.candidateWorkspace,
      returns: options.returns ? validatePathList([...options.returns], 'declared return path', true) : record.returns,
      snapshot: options.snapshot
        ? {
            workspace: resolve(options.snapshot.workspace),
            scratch: resolve(options.snapshot.scratch),
            sourceSha256: boundedHash(options.snapshot.sourceSha256, 'snapshot source hash'),
            inputFiles: validateInputFiles(options.snapshot.inputFiles ?? []),
          }
        : record.snapshot,
    });
  });
}

export async function allocateCheckRunPhysical(
  invocationId: string,
  nonce: string,
  host: string,
  run: string,
  options: CheckRunStateOptions = {},
): Promise<CheckRunInvocationRecord> {
  return mutateRecord(invocationId, options, async (directory, record) => {
    if (record.nonce !== nonce) throw new Error('check-run-settlement: wrong invocation nonce');
    if (record.cancellation.requested) throw new Error('check-run-settlement: cancelled invocation cannot allocate a run');
    if (record.phase !== 'queued' && record.phase !== 'uploading')
      throw new Error(`check-run-settlement: cannot allocate a run from ${record.phase}`);
    const physical = validatePhysical({ host, run });
    if (record.physical && (record.physical.host !== physical.host || record.physical.run !== physical.run))
      throw new Error('check-run-settlement: invocation already owns a different physical run');
    return updateRecord(directory, record, { phase: 'uploading', physical });
  });
}

export async function withCheckRunSpawnPermit<T>(
  invocationId: string,
  nonce: string,
  host: string,
  run: string,
  spawn: () => T,
  options: CheckRunStateOptions = {},
  identifyTransportChild?: (spawned: T) => CheckRunTransportChildIdentity | null,
): Promise<T> {
  return mutateRecord(invocationId, options, async (directory, record) => {
    const physical = validatePhysical({ host, run });
    if (record.nonce !== nonce) throw new Error('check-run-settlement: wrong invocation nonce');
    if (record.cancellation.requested) throw new Error('check-run-settlement: cancelled invocation cannot start');
    if (
      !record.physical ||
      record.physical.host !== physical.host ||
      record.physical.run !== physical.run
    )
      throw new Error('check-run-settlement: spawn does not match the registered physical run');
    if (record.phase !== 'uploading' && record.phase !== 'running')
      throw new Error(`check-run-settlement: cannot start from ${record.phase}`);
    await updateRecord(directory, record, { phase: 'running' });
    try {
      const spawned = spawn();
      const identity = identifyTransportChild?.(spawned) ?? null;
      if (identity) {
        const latest = readRecord(directory, invocationId);
        await updateRecord(directory, latest, { transportChild: validateTransportChild(identity) });
      }
      return spawned;
    } catch (error) {
      const latest = readRecord(directory, invocationId);
      await updateRecord(directory, latest, {
        phase: 'unknown',
        failure: `physical spawn failed: ${error instanceof Error ? error.message.slice(0, 512) : 'unknown error'}`,
      });
      throw error;
    }
  });
}

export async function markCheckRunNativeTerminal(
  invocationId: string,
  nonce: string,
  nativeValue: { host: string; run: string; exitCode: number; receiptSha256: string; lifetimeFailure?: boolean },
  options: CheckRunStateOptions = {},
): Promise<CheckRunInvocationRecord> {
  return mutateRecord(invocationId, options, async (directory, record) => {
    const physical = validatePhysical({ host: nativeValue.host, run: nativeValue.run });
    if (record.nonce !== nonce) throw new Error('check-run-settlement: wrong invocation nonce');
    if (
      !record.physical ||
      record.physical.host !== physical.host ||
      record.physical.run !== physical.run
    )
      throw new Error('check-run-settlement: native result does not match its physical run');
    if (record.native) throw new Error('check-run-settlement: duplicate native terminal event');
    if (!['uploading', 'running', 'cancel-requested'].includes(record.phase))
      throw new Error(`check-run-settlement: native terminal event is out of order from ${record.phase}`);
    const native = validateNative({
      exitCode: nativeValue.exitCode,
      lifetimeFailure: nativeValue.lifetimeFailure ?? false,
      receiptSha256: nativeValue.receiptSha256,
    });
    return updateRecord(directory, record, { phase: 'native-terminal', native });
  });
}

export async function acceptCheckRunFinalSettlement(
  raw: string,
  options: CheckRunStateOptions = {},
): Promise<CheckRunInvocationRecord> {
  if (Buffer.byteLength(raw) > CHECK_RUN_SETTLEMENT_MAX_BYTES)
    throw new Error('check-run-settlement: message exceeds its byte bound');
  let value: unknown;
  try {
    value = parseUniqueJson(raw.endsWith('\n') ? raw.slice(0, -1) : raw);
  } catch {
    throw new Error('check-run-settlement: malformed or partial final settlement');
  }
  const parsed = validateCheckRunFinalSettlement(value);
  return mutateRecord(parsed.invocationId, options, async (directory, record) => {
    if (record.final) throw new Error('check-run-settlement: duplicate or replayed final authority');
    return acceptFinalUnderLock(directory, record, raw);
  });
}

async function acceptFinalUnderLock(
  directory: string,
  record: CheckRunInvocationRecord,
  raw: string,
): Promise<CheckRunInvocationRecord> {
  if (record.final) throw new Error('check-run-settlement: duplicate or replayed final authority');
  const message = decodeCheckRunSettlement(raw, {
    invocationId: record.invocationId,
    nonce: record.nonce,
    binding: record.binding,
    ...(record.physical ? { physical: record.physical } : {}),
    nativeTerminalSeen: record.native !== null,
  });
  if (record.phase !== 'native-terminal')
    throw new Error(`check-run-settlement: final authority is out of order from ${record.phase}`);
  if (
    !record.native ||
    message.native?.exitCode !== record.native.exitCode ||
    message.native.receiptSha256 !== record.native.receiptSha256
  )
    throw new Error('check-run-settlement: final native outcome differs from the retained terminal event');
  const phase = message.cleanup.disposition === 'settled' ? 'settled' : 'unknown';
  return updateRecord(directory, record, { phase, final: message, failure: null });
}

export async function cancelCheckRunInvocation(
  invocationId: string,
  nonce: string,
  signal: 1 | 2 | 15 = 15,
  options: CheckRunStateOptions = {},
): Promise<CheckRunInvocationRecord> {
  if (![1, 2, 15].includes(signal)) throw new Error('check-run-settlement: invalid cancellation signal');
  return mutateRecord(invocationId, options, async (directory, record) => {
    if (record.nonce !== nonce) throw new Error('check-run-settlement: wrong invocation nonce');
    if (record.final) return record;
    const selectedSignal = record.cancellation.signal ?? signal;
    const next = await updateRecord(directory, record, {
      phase: 'cancel-requested',
      cancellation: { requested: true, signal: selectedSignal },
    });
    requestExecutionCancellation(
      { file: cancellationFile(directory, invocationId), id: invocationId },
      selectedSignal,
    );
    return next;
  });
}

export async function reconcileCheckRunInvocation(
  invocationId: string,
  options: CheckRunReconcileOptions = {},
): Promise<CheckRunInvocationRecord> {
  const before = await getCheckRunStatus(invocationId, options);
  if (before.final) return before;
  if (before.phase === 'unknown' && !options.force) return before;
  if (!before.physical) {
    if (before.cancellation.requested && (before.phase === 'cancel-requested' || before.phase === 'queued')) {
      return mutateRecord(invocationId, options, async (directory, record) => {
        if (record.physical || record.final) return record;
        return updateRecord(directory, record, { phase: 'cancelled', failure: null });
      });
    }
    return mutateRecord(invocationId, options, async (directory, record) =>
      updateRecord(directory, record, {
        phase: 'unknown',
        failure: 'physical host and run identity are unavailable; no replacement was started',
      }),
    );
  }
  if (!options.reconcilePhysical)
    return mutateRecord(invocationId, options, async (directory, record) =>
      updateRecord(directory, record, {
        phase: 'unknown',
        failure: 'trusted reconciliation transport is unavailable; original physical custody is retained',
      }),
    );
  try {
    const observed = await options.reconcilePhysical(before.physical, before);
    if (observed.disposition === 'unknown') {
      return mutateRecord(invocationId, options, async (directory, record) =>
        updateRecord(directory, record, {
          phase: 'unknown',
          failure: boundedText(observed.reason, 'reconciliation failure'),
        }),
      );
    }
    const message = validateCheckRunFinalSettlement(observed.final);
    if (message.invocationId !== before.invocationId || message.nonce !== before.nonce)
      throw new Error('reconciliation returned a foreign invocation settlement');
    if (JSON.stringify(message.binding) !== JSON.stringify(before.binding))
      throw new Error('reconciliation returned a mismatched invocation binding');
    if (message.physical.host !== before.physical.host || message.physical.run !== before.physical.run)
      throw new Error('reconciliation returned a replacement physical run');
    return mutateRecord(invocationId, options, async (directory, record) => {
      if (record.final) return record;
      if (!record.native && message.native) {
        const recordedNative = validateNative(message.native)!;
        await updateRecord(directory, record, { native: recordedNative, phase: 'native-terminal' });
        record = readRecord(directory, invocationId);
      } else if (record.native && record.phase !== 'native-terminal') {
        if (
          record.native.exitCode !== message.native?.exitCode ||
          record.native.receiptSha256 !== message.native?.receiptSha256
        )
          throw new Error('reconciliation native result differs from the retained terminal event');
        await updateRecord(directory, record, { phase: 'native-terminal' });
        record = readRecord(directory, invocationId);
      }
      const encoded = encodeCheckRunFinalSettlement(message);
      return acceptFinalUnderLock(directory, record, encoded);
    });
  } catch (error) {
    return mutateRecord(invocationId, options, async (directory, record) =>
      updateRecord(directory, record, {
        phase: 'unknown',
        failure: `reconciliation failed for the original physical run: ${error instanceof Error ? error.message.slice(0, 512) : 'unknown error'}`,
      }),
    );
  }
}

export function readCheckRunCancellation(
  invocationId: string,
  options: CheckRunStateOptions = {},
): { file: string; id: string; requested: boolean; signal: 1 | 2 | 15 | null } {
  const directory = checkRunSettlementStateDirectory(options);
  const record = readRecord(directory, invocationId);
  const path = cancellationFile(directory, invocationId);
  const intent = executionCancellation({ file: path, id: invocationId });
  return {
    file: path,
    id: invocationId,
    requested: record.cancellation.requested || intent !== null,
    signal: record.cancellation.signal ?? intent?.signal ?? null,
  };
}

export async function bindCheckRunWorkspace(
  invocationId: string,
  nonce: string,
  candidateWorkspace: string,
  snapshot: { workspace: string; scratch: string; sourceSha256: string; inputFiles?: readonly string[] },
  returns: readonly string[],
  options: CheckRunStateOptions = {},
): Promise<CheckRunInvocationRecord> {
  return markCheckRunQueued(invocationId, nonce, {
    ...options,
    candidateWorkspace,
    snapshot,
    returns,
  });
}

export async function setCheckRunUnknown(
  invocationId: string,
  nonce: string,
  reason: string,
  options: CheckRunStateOptions = {},
): Promise<CheckRunInvocationRecord> {
  return mutateRecord(invocationId, options, async (directory, record) => {
    if (record.nonce !== nonce) throw new Error('check-run-settlement: wrong invocation nonce');
    if (record.final && record.final.cleanup.disposition === 'settled') return record;
    return updateRecord(directory, record, { phase: 'unknown', failure: boundedText(reason, 'failure detail') });
  });
}

export function checkRunBindingHash(bindingValue: CheckRunInvocationBinding): string {
  return createHash('sha256').update(JSON.stringify(validateCheckRunInvocationBinding(bindingValue))).digest('hex');
}

function usage(): string {
  return [
    'Usage:',
    '  bun scripts/check-run-settlement.ts register --binding <private-json> [--state-dir <absolute-dir>]',
    '  bun scripts/check-run-settlement.ts status <invocation-id> [--state-dir <absolute-dir>]',
    '  bun scripts/check-run-settlement.ts cancel <invocation-id> [--signal 1|2|15] [--state-dir <absolute-dir>]',
    '  bun scripts/check-run-settlement.ts reconcile <invocation-id> --hosts <absolute-hosts-json>',
  ].join('\n');
}

if (import.meta.main) {
  const [operation, ...args] = Bun.argv.slice(2);
  const stateAt = args.indexOf('--state-dir');
  const stateDirectory = stateAt >= 0 ? args[stateAt + 1] : undefined;
  const stateOptions = stateDirectory ? { stateDirectory } : {};
  try {
    if (operation === 'register') {
      const bindingAt = args.indexOf('--binding');
      const file = bindingAt >= 0 ? args[bindingAt + 1] : undefined;
      if (!file || !isAbsolute(file)) throw new Error('register needs an absolute --binding file');
      const stat = lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0)
        throw new Error('binding file must be a private regular file');
      const binding = validateCheckRunInvocationBinding(JSON.parse(readFileSync(file, 'utf8')));
      const registration = await registerCheckRunInvocation(binding, stateOptions);
      process.stdout.write(`${JSON.stringify(registration)}\n`);
    } else if (operation === 'status') {
      const id = args[0];
      if (!id) throw new Error('status needs an invocation id');
      process.stdout.write(`${JSON.stringify(await getCheckRunStatus(id, stateOptions))}\n`);
    } else if (operation === 'cancel') {
      const id = args[0];
      if (!id) throw new Error('cancel needs an invocation id');
      const record = await getCheckRunStatus(id, stateOptions);
      const signalIndex = args.indexOf('--signal');
      const signal = signalIndex < 0 ? 15 : Number(args[signalIndex + 1]);
      if (signal !== 1 && signal !== 2 && signal !== 15) throw new Error('cancel signal must be 1, 2, or 15');
      process.stdout.write(
        `${JSON.stringify(await cancelCheckRunInvocation(id, record.nonce, signal, stateOptions))}\n`,
      );
    } else if (operation === 'reconcile') {
      const id = args[0];
      const hostsAt = args.indexOf('--hosts');
      const hostsFile = hostsAt >= 0 ? args[hostsAt + 1] : undefined;
      if (!id || !hostsFile || !isAbsolute(hostsFile)) throw new Error('reconcile needs an id and absolute --hosts file');
      const record = await getCheckRunStatus(id, stateOptions);
      if (record.final) {
        process.stdout.write(`${JSON.stringify(record)}\n`);
      } else {
        const { reconcileRegisteredCheckRun } = await import('./check-run.ts');
        const reconciled = await reconcileRegisteredCheckRun(id, hostsFile, stateOptions);
        process.stdout.write(`${JSON.stringify(reconciled)}\n`);
      }
    } else {
      throw new Error(usage());
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n${usage()}\n`);
    process.exitCode = 2;
  }
}
