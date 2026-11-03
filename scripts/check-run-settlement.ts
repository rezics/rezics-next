import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import {
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  linkSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { CHECK_HOST_NAME_PATTERN } from './check-placement.ts';
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
export const CHECK_RUN_PREPARED_EXECUTION_MAX_BYTES = 16 * 1024 * 1024;
export const CHECK_RUN_PREPARED_DESCRIPTOR_MAX_BYTES = 64 * 1024;
export const CHECK_RUN_SETTLEMENT_MAX_ITEMS = 64;
export const CHECK_RUN_SETTLEMENT_MAX_TEXT = 2048;
// The frozen source inventory is the largest schema array; eight value nodes per path bound its envelope overhead.
const CHECK_RUN_SNAPSHOT_MAX_INPUT_FILES = 50_000;
const CHECK_RUN_JSON_MAX_ARRAY_ITEMS = CHECK_RUN_SNAPSHOT_MAX_INPUT_FILES;
const CHECK_RUN_JSON_MAX_NODES = CHECK_RUN_SNAPSHOT_MAX_INPUT_FILES * 8;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH = /^[0-9a-f]{64}$/;
const REVISION = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const PHYSICAL_RUN = /^[a-zA-Z0-9-]{1,96}$/;
const CHECK_RUN_CUSTODY_OBSERVATION_MAX = 16;

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

export type CheckRunPhysicalIdentity = { host: string; run: string };
export type CheckRunTransportChildIdentity = { pid: number; bootId: string; start: string };
export type CheckRunTransportIdentityState = 'live-same' | 'gone-or-replaced' | 'unknown';

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
  | 'prepared'
  | 'claimed'
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
  preparedExecution: { file: string; sha256: string } | null;
  descriptor: { file: string; sha256: string } | null;
  preparationIntent: { file: string; sha256: string } | null;
  snapshotCustody: 'owned' | 'removed' | 'unknown' | null;
  returns: string[];
  cancellation: { requested: boolean; signal: 1 | 2 | 15 | null };
  final: CheckRunFinalSettlement | null;
  finalCustody: CheckRunFinalCustody | null;
  failure: string | null;
};

export type CheckRunFinalCustodyObservation = {
  observedAt: string;
  disposition: 'unknown' | 'settled' | 'rejected';
  transportIdentity: CheckRunTransportIdentityState | null;
  final: CheckRunFinalSettlement | null;
  reason: string | null;
};

export type CheckRunFinalCustodyContinuation = {
  count: number;
  sha256: string;
  first: CheckRunFinalCustodyObservation;
  latest: CheckRunFinalCustodyObservation;
};

export type CheckRunFinalCustodyAggregate = 'pending' | 'settled' | 'unknown';

/** Versioned status metadata; the authenticated final settlement itself remains immutable. */
export type CheckRunFinalCustody = {
  schema: 1;
  aggregate: CheckRunFinalCustodyAggregate;
  delivery: 'not-required' | 'pending' | 'delivered' | 'unknown' | 'received' | 'reconciled';
  deliverySha256: string;
  privateFiles: 'pending' | 'settled' | 'unknown';
  reconciliation: 'unknown' | 'settled';
  originalFinalSha256: string;
  identity: {
    sha256: string;
    bindingSha256: string;
    physical: CheckRunPhysicalIdentity;
    sourceSha256: string | null;
    snapshotSha256: string | null;
    candidateWorkspaceSha256: string | null;
    returnsSha256: string;
    preparedExecutionReferenceSha256: string | null;
    descriptorReferenceSha256: string | null;
    preparationIntentReferenceSha256: string | null;
  };
  observations: CheckRunFinalCustodyObservation[];
  continuation: CheckRunFinalCustodyContinuation | null;
};

export type CheckRunRegistration = {
  invocationId: string;
  nonce: string;
  binding: CheckRunInvocationBinding;
  cancellation: { file: string; id: string };
};

/** The owner-private, versioned caller ABI emitted by prepareCheckRunInvocation. */
export type CheckRunPreparedDescriptor = {
  schema: 1;
  type: 'check-run-preparation';
  invocationId: string;
  nonce: string;
  binding: CheckRunInvocationBinding;
  cancellation: { file: string; id: string };
};

export type CheckRunPreparationIntent = {
  schema: 1;
  type: 'check-run-preparation-intent';
  invocationId: string;
  descriptor: string;
  candidateWorkspace: string;
  snapshot: {
    workspace: string;
    scratch: string;
    sourceSha256: string | null;
    inputFiles: string[];
  };
};

export type CheckRunStateOptions = {
  stateDirectory?: string;
  /** Narrow fault-injection seam for durable cleanup tests. Production callers omit it. */
  removePrivateFile?: (path: string) => void;
};

export type CheckRunMessageExpectation = {
  invocationId: string;
  nonce: string;
  binding: CheckRunInvocationBinding;
  physical?: CheckRunPhysicalIdentity;
  nativeTerminalSeen: boolean;
  nativeTerminal?: CheckRunNativeDisposition;
};

export type CheckRunReconciliation =
  | { disposition: 'settled'; final: CheckRunFinalSettlement; transportIdentity?: CheckRunTransportIdentityState }
  | { disposition: 'unknown'; reason: string; transportIdentity?: CheckRunTransportIdentityState };

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

function closedObjectWithOptional(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
    Reflect.ownKeys(value).some(
      (key) => typeof key !== 'string' || (!required.includes(key) && !optional.includes(key)),
    ) ||
    required.some((key) => !Object.hasOwn(value, key))
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

export function validateCheckRunPreparedDescriptor(value: unknown): CheckRunPreparedDescriptor {
  const item = closedObject(
    value,
    ['schema', 'type', 'invocationId', 'nonce', 'binding', 'cancellation'],
    'prepared descriptor',
  );
  if (
    item.schema !== 1 ||
    item.type !== 'check-run-preparation' ||
    typeof item.invocationId !== 'string' ||
    !UUID.test(item.invocationId)
  )
    throw new Error('check-run-settlement: invalid prepared descriptor identity');
  const nonce = boundedText(item.nonce, 'prepared descriptor nonce', 64);
  if (!/^[a-f0-9]{64}$/.test(nonce)) throw new Error('check-run-settlement: invalid prepared descriptor nonce');
  const cancellation = closedObject(item.cancellation, ['file', 'id'], 'prepared cancellation identity');
  const file = boundedText(cancellation.file, 'prepared cancellation file', 4096);
  if (!isAbsolute(file) || cancellation.id !== item.invocationId)
    throw new Error('check-run-settlement: invalid prepared cancellation identity');
  return {
    schema: 1,
    type: 'check-run-preparation',
    invocationId: item.invocationId,
    nonce,
    binding: validateCheckRunInvocationBinding(item.binding),
    cancellation: { file, id: item.invocationId },
  };
}

function validateCheckRunPreparationIntent(value: unknown): CheckRunPreparationIntent {
  const item = closedObject(
    value,
    ['schema', 'type', 'invocationId', 'descriptor', 'candidateWorkspace', 'snapshot'],
    'preparation intent',
  );
  if (
    item.schema !== 1 ||
    item.type !== 'check-run-preparation-intent' ||
    typeof item.invocationId !== 'string' ||
    !UUID.test(item.invocationId)
  )
    throw new Error('check-run-settlement: invalid preparation intent identity');
  const descriptor = boundedText(item.descriptor, 'preparation descriptor path', 4096);
  const candidateWorkspace = boundedText(item.candidateWorkspace, 'preparation candidate path', 4096);
  if (!isAbsolute(descriptor) || !isAbsolute(candidateWorkspace))
    throw new Error('check-run-settlement: preparation paths must be absolute');
  const snapshotValue = closedObject(
    item.snapshot,
    ['workspace', 'scratch', 'sourceSha256', 'inputFiles'],
    'preparation snapshot',
  );
  const workspace = boundedText(snapshotValue.workspace, 'preparation workspace path', 4096);
  const scratch = boundedText(snapshotValue.scratch, 'preparation scratch path', 4096);
  if (
    !isAbsolute(workspace) ||
    !isAbsolute(scratch) ||
    workspace !== join(scratch, 'workspace') ||
    !/^check-run-[0-9a-f-]{36}$/.test(basename(scratch))
  )
    throw new Error('check-run-settlement: preparation snapshot paths are invalid');
  const sourceSha256 =
    snapshotValue.sourceSha256 === null ? null : boundedHash(snapshotValue.sourceSha256, 'preparation source hash');
  return {
    schema: 1,
    type: 'check-run-preparation-intent',
    invocationId: item.invocationId.toLowerCase(),
    descriptor: resolve(descriptor),
    candidateWorkspace: resolve(candidateWorkspace),
    snapshot: {
      workspace,
      scratch,
      sourceSha256,
      inputFiles: validateInputFiles(snapshotValue.inputFiles),
    },
  };
}

function validatePhysical(value: unknown): CheckRunPhysicalIdentity {
  const item = closedObject(value, ['host', 'run'], 'physical identity');
  if (typeof item.host !== 'string' || !new RegExp(CHECK_HOST_NAME_PATTERN).test(item.host)) throw new Error('check-run-settlement: invalid physical host');
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

function jsonSha256(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function privateReferenceSha256(reference: { file: string; sha256: string } | null): string | null {
  return reference ? jsonSha256(reference) : null;
}

function aggregateFinalCustodyStatus(
  custody: Pick<CheckRunFinalCustody, 'delivery' | 'privateFiles' | 'reconciliation'>,
): CheckRunFinalCustodyAggregate {
  if (custody.delivery === 'unknown' || custody.privateFiles === 'unknown' || custody.reconciliation === 'unknown')
    return 'unknown';
  if (custody.delivery === 'pending' || custody.privateFiles === 'pending') return 'pending';
  return 'settled';
}

function validateFinalCustodyObservation(value: unknown): CheckRunFinalCustodyObservation {
  const observation = closedObject(
    value,
    ['observedAt', 'disposition', 'transportIdentity', 'final', 'reason'],
    'custody observation',
  );
  if (!['unknown', 'settled', 'rejected'].includes(String(observation.disposition)))
    throw new Error('check-run-settlement: invalid custody observation disposition');
  if (
    observation.transportIdentity !== null &&
    !['live-same', 'gone-or-replaced', 'unknown'].includes(String(observation.transportIdentity))
  )
    throw new Error('check-run-settlement: invalid transport identity observation');
  const final = observation.final === null ? null : validateCheckRunFinalSettlement(observation.final);
  const reason = observation.reason === null ? null : boundedText(observation.reason, 'custody observation reason');
  return {
    observedAt: boundedText(observation.observedAt, 'custody observation time', 64),
    disposition: observation.disposition as CheckRunFinalCustodyObservation['disposition'],
    transportIdentity: observation.transportIdentity as CheckRunTransportIdentityState | null,
    final,
    reason,
  };
}

function custodyObservationChainHash(
  previousSha256: string | null,
  observation: CheckRunFinalCustodyObservation,
): string {
  return createHash('sha256')
    .update('check-run-final-custody-observations-v1\0')
    .update(previousSha256 ?? '')
    .update('\0')
    .update(JSON.stringify(observation))
    .digest('hex');
}

function validateFinalCustody(value: unknown): CheckRunFinalCustody {
  const item = closedObjectWithOptional(
    value,
    [
      'schema',
      'delivery',
      'deliverySha256',
      'privateFiles',
      'reconciliation',
      'originalFinalSha256',
      'identity',
      'observations',
    ],
    ['aggregate', 'continuation'],
    'final custody state',
  );
  if (item.schema !== 1) throw new Error('check-run-settlement: unsupported final custody schema');
  if (item.aggregate !== undefined && !['pending', 'settled', 'unknown'].includes(String(item.aggregate)))
    throw new Error('check-run-settlement: invalid aggregate custody state');
  if (!['not-required', 'pending', 'delivered', 'unknown', 'received', 'reconciled'].includes(String(item.delivery)))
    throw new Error('check-run-settlement: invalid final delivery state');
  if (!['pending', 'settled', 'unknown'].includes(String(item.privateFiles)))
    throw new Error('check-run-settlement: invalid private-file custody state');
  if (!['unknown', 'settled'].includes(String(item.reconciliation)))
    throw new Error('check-run-settlement: invalid final reconciliation state');
  const deliverySha256 = boundedHash(item.deliverySha256, 'final delivery digest');
  const originalFinalSha256 = boundedHash(item.originalFinalSha256, 'original final digest');
  const identityValue = closedObject(
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
  const identityCore = {
    bindingSha256: boundedHash(identityValue.bindingSha256, 'final binding digest'),
    physical: validatePhysical(identityValue.physical),
    sourceSha256:
      identityValue.sourceSha256 === null ? null : boundedHash(identityValue.sourceSha256, 'final source digest'),
    snapshotSha256:
      identityValue.snapshotSha256 === null
        ? null
        : boundedHash(identityValue.snapshotSha256, 'snapshot identity digest'),
    candidateWorkspaceSha256:
      identityValue.candidateWorkspaceSha256 === null
        ? null
        : boundedHash(identityValue.candidateWorkspaceSha256, 'candidate workspace identity digest'),
    returnsSha256: boundedHash(identityValue.returnsSha256, 'final returns digest'),
    preparedExecutionReferenceSha256:
      identityValue.preparedExecutionReferenceSha256 === null
        ? null
        : boundedHash(identityValue.preparedExecutionReferenceSha256, 'prepared execution reference digest'),
    descriptorReferenceSha256:
      identityValue.descriptorReferenceSha256 === null
        ? null
        : boundedHash(identityValue.descriptorReferenceSha256, 'prepared descriptor reference digest'),
    preparationIntentReferenceSha256:
      identityValue.preparationIntentReferenceSha256 === null
        ? null
        : boundedHash(identityValue.preparationIntentReferenceSha256, 'preparation intent reference digest'),
  };
  const identitySha = boundedHash(identityValue.sha256, 'final custody identity digest');
  if (identitySha !== jsonSha256(identityCore))
    throw new Error('check-run-settlement: final custody identity digest is inconsistent');
  if (!Array.isArray(item.observations) || item.observations.length > CHECK_RUN_CUSTODY_OBSERVATION_MAX)
    throw new Error('check-run-settlement: final custody observation bound exceeded');
  const observations = item.observations.map(validateFinalCustodyObservation);
  let continuation: CheckRunFinalCustodyContinuation | null = null;
  if (item.continuation !== undefined && item.continuation !== null) {
    const rawContinuation = closedObject(
      item.continuation,
      ['count', 'sha256', 'first', 'latest'],
      'custody observation continuation',
    );
    const count = boundedCount(rawContinuation.count, 'custody continuation count');
    if (count < 1) throw new Error('check-run-settlement: invalid custody continuation count');
    const sha256 = boundedHash(rawContinuation.sha256, 'custody continuation digest');
    const first = validateFinalCustodyObservation(rawContinuation.first);
    const latest = validateFinalCustodyObservation(rawContinuation.latest);
    if (observations.length !== CHECK_RUN_CUSTODY_OBSERVATION_MAX)
      throw new Error('check-run-settlement: custody continuation needs a full observation prefix');
    if (
      count === 1 &&
      (JSON.stringify(first) !== JSON.stringify(latest) || sha256 !== custodyObservationChainHash(null, first))
    )
      throw new Error('check-run-settlement: invalid initial custody continuation');
    continuation = { count, sha256, first, latest };
  }
  const custody: Omit<CheckRunFinalCustody, 'aggregate'> = {
    schema: 1 as const,
    delivery: item.delivery as CheckRunFinalCustody['delivery'],
    deliverySha256,
    privateFiles: item.privateFiles as CheckRunFinalCustody['privateFiles'],
    reconciliation: item.reconciliation as CheckRunFinalCustody['reconciliation'],
    originalFinalSha256,
    identity: { sha256: identitySha, ...identityCore },
    observations,
    continuation,
  };
  return {
    ...custody,
    aggregate: aggregateFinalCustodyStatus(custody),
  };
}

function validateNative(value: unknown): CheckRunNativeDisposition | null {
  if (value === null) return null;
  const item = closedObject(value, ['exitCode', 'lifetimeFailure', 'receiptSha256'], 'native result');
  if (!Number.isInteger(item.exitCode) || (item.exitCode as number) < 0 || (item.exitCode as number) > 255)
    throw new Error('check-run-settlement: invalid native exit code');
  if (typeof item.lifetimeFailure !== 'boolean')
    throw new Error('check-run-settlement: invalid native lifetime status');
  return {
    exitCode: item.exitCode as number,
    lifetimeFailure: item.lifetimeFailure,
    receiptSha256: boundedHash(item.receiptSha256, 'native receipt hash'),
  };
}

function validatePreparedInputs(value: unknown): CheckRunPreparedInputs {
  const item = closedObject(
    value,
    ['status', 'sourceSha256', 'manifestSha256', 'fileCount', 'totalBytes'],
    'prepared inputs',
  );
  if (item.status !== 'verified' && item.status !== 'unavailable')
    throw new Error('check-run-settlement: invalid prepared input status');
  const sourceSha256 = item.sourceSha256 === null ? null : boundedHash(item.sourceSha256, 'prepared source hash');
  const manifestSha256 =
    item.manifestSha256 === null ? null : boundedHash(item.manifestSha256, 'prepared manifest hash');
  const fileCount = boundedCount(item.fileCount, 'prepared input file count', CHECK_RUN_SNAPSHOT_MAX_INPUT_FILES);
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
    if (depth > 64 || ++nodes > CHECK_RUN_JSON_MAX_NODES)
      throw new Error('check-run-settlement: JSON structure exceeds its bound');
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
        if (++count > CHECK_RUN_JSON_MAX_ARRAY_ITEMS)
          throw new Error('check-run-settlement: JSON array exceeds its bound');
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
  if (!Array.isArray(value) || value.length > CHECK_RUN_SNAPSHOT_MAX_INPUT_FILES)
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
      (returns.status !== 'empty' && returns.status !== 'restored') ||
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
  if (!expected.nativeTerminalSeen)
    throw new Error('check-run-settlement: final settlement arrived before native terminal');
  if (message.invocationId !== expected.invocationId) throw new Error('check-run-settlement: foreign invocation id');
  if (message.nonce !== expected.nonce) throw new Error('check-run-settlement: wrong invocation nonce');
  if (checkRunBindingHash(message.binding) !== checkRunBindingHash(expected.binding))
    throw new Error(
      'check-run-settlement: candidate, argv, environment, producer, host, preparation or return binding mismatch',
    );
  if (message.returns.declarationsSha256 !== expected.binding.returnsSha256)
    throw new Error('check-run-settlement: returned artifacts do not match the declared return binding');
  if (
    message.preparedInputs.status === 'verified' &&
    message.preparedInputs.sourceSha256 !== expected.binding.sourceSha256
  )
    throw new Error('check-run-settlement: prepared source does not match the candidate binding');
  if (expected.nativeTerminal) {
    if (
      !message.native ||
      message.native.exitCode !== expected.nativeTerminal.exitCode ||
      message.native.lifetimeFailure !== expected.nativeTerminal.lifetimeFailure ||
      message.native.receiptSha256 !== expected.nativeTerminal.receiptSha256
    )
      throw new Error('check-run-settlement: final result differs from the intermediate native terminal event');
  }
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
  const root = realpathSync(workspace);
  const privateDirectory = realpathSync(stateDirectory);
  const fromWorkspace = relative(root, privateDirectory);
  if (
    fromWorkspace === '' ||
    (fromWorkspace !== '..' && !fromWorkspace.startsWith(`..${sep}`) && !isAbsolute(fromWorkspace))
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

function cancellationWasRequested(directory: string, record: CheckRunInvocationRecord): boolean {
  return (
    record.cancellation.requested ||
    executionCancellation({ file: cancellationFile(directory, record.invocationId), id: record.invocationId }) !== null
  );
}

function preparedExecutionFile(directory: string, id: string): string {
  return join(directory, `${id.toLowerCase()}.prepared.json`);
}

export function checkRunPreparationIntentFile(descriptorFile: string): string {
  if (!isAbsolute(descriptorFile)) throw new Error('check-run-settlement: descriptor path must be absolute');
  return `${resolve(descriptorFile)}.intent.json`;
}

function assertPrivateDirectory(path: string, label: string): void {
  const stats = lstatSync(path);
  if (!stats.isDirectory() || stats.isSymbolicLink() || (stats.mode & 0o077) !== 0)
    throw new Error(`check-run-settlement: ${label} must be an owner-private real directory`);
  if (typeof process.getuid === 'function' && stats.uid !== process.getuid())
    throw new Error(`check-run-settlement: ${label} is owned by another user`);
}

function assertCanonicalParent(path: string, label: string): void {
  const directory = resolve(path, '..');
  if (realpathSync(directory) !== directory)
    throw new Error(`check-run-settlement: ${label} cannot use a symlinked parent directory`);
}

function writeNewPrivateFile(path: string, content: Buffer, maximumBytes: number, label: string): void {
  if (content.byteLength > maximumBytes) throw new Error(`check-run-settlement: ${label} exceeds its byte bound`);
  const directory = resolve(path, '..');
  assertPrivateDirectory(directory, `${label} directory`);
  assertCanonicalParent(path, label);
  const temporary = join(directory, `.${process.pid}.${randomUUID()}.pending`);
  try {
    const descriptor = openSync(temporary, 'wx', 0o600);
    try {
      let offset = 0;
      while (offset < content.byteLength) offset += writeSync(descriptor, content, offset, content.byteLength - offset);
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    linkSync(temporary, path);
    unlinkSync(temporary);
    syncDirectory(directory);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      // Preserve the creation error.
    }
    throw error;
  }
}

function readPrivateFile(path: string, maximumBytes: number, label: string): Buffer {
  const absolute = resolve(path);
  assertPrivateDirectory(resolve(absolute, '..'), `${label} directory`);
  let descriptor: number;
  try {
    descriptor = openSync(absolute, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  } catch (error) {
    throw new Error(
      `check-run-settlement: ${label} is not a readable private regular file: ${error instanceof Error ? error.message : 'open failed'}`,
    );
  }
  try {
    const stats = fstatSync(descriptor);
    if (
      !stats.isFile() ||
      (stats.mode & 0o077) !== 0 ||
      stats.nlink !== 1 ||
      (typeof process.getuid === 'function' && stats.uid !== process.getuid())
    )
      throw new Error(`check-run-settlement: ${label} must be an owner-only private regular file`);
    if (stats.size > maximumBytes) throw new Error(`check-run-settlement: ${label} exceeds its byte bound`);
    const bytes = readFileSync(descriptor);
    if (bytes.byteLength > maximumBytes) throw new Error(`check-run-settlement: ${label} exceeds its byte bound`);
    return bytes;
  } finally {
    closeSync(descriptor);
  }
}

export function writeCheckRunPreparationIntent(
  file: string,
  intentValue: CheckRunPreparationIntent,
): { file: string; sha256: string } {
  if (!isAbsolute(file)) throw new Error('check-run-settlement: preparation intent path must be absolute');
  const intent = validateCheckRunPreparationIntent(intentValue);
  const absolute = resolve(file);
  if (absolute !== checkRunPreparationIntentFile(intent.descriptor))
    throw new Error('check-run-settlement: preparation intent path does not match its descriptor');
  assertCanonicalParent(absolute, 'preparation intent');
  const parent = resolve(absolute, '..');
  assertPrivateDirectory(parent, 'preparation intent directory');
  assertOutsideCandidate(parent, intent.candidateWorkspace);
  if (existsSync(absolute)) throw new Error('check-run-settlement: preparation intent already exists');
  const bytes = Buffer.from(`${JSON.stringify(intent)}\n`);
  writeNewPrivateFile(absolute, bytes, CHECK_RUN_PREPARED_DESCRIPTOR_MAX_BYTES, 'preparation intent');
  return { file: absolute, sha256: createHash('sha256').update(bytes).digest('hex') };
}

export function readCheckRunPreparationIntent(file: string): CheckRunPreparationIntent {
  return readCheckRunPreparationIntentReference(file).intent;
}

export function readCheckRunPreparationIntentReference(file: string): {
  intent: CheckRunPreparationIntent;
  reference: { file: string; sha256: string };
} {
  if (!isAbsolute(file)) throw new Error('check-run-settlement: preparation intent path must be absolute');
  const absolute = resolve(file);
  assertCanonicalParent(absolute, 'preparation intent');
  const raw = readPrivateFile(absolute, CHECK_RUN_PREPARED_DESCRIPTOR_MAX_BYTES, 'preparation intent');
  const intent = validateCheckRunPreparationIntent(parseUniqueJson(raw.toString('utf8')));
  if (absolute !== checkRunPreparationIntentFile(intent.descriptor))
    throw new Error('check-run-settlement: preparation intent does not match its descriptor');
  return {
    intent,
    reference: { file: absolute, sha256: createHash('sha256').update(raw).digest('hex') },
  };
}

export function removeCheckRunPreparationIntentFile(
  reference: { file: string; sha256: string },
  candidateWorkspace: string,
  options: CheckRunStateOptions = {},
): void {
  if (
    !isAbsolute(reference.file) ||
    resolve(reference.file) !== reference.file ||
    !reference.file.endsWith('.intent.json')
  )
    throw new Error('check-run-settlement: preparation intent path is invalid');
  assertOutsideCandidate(resolve(reference.file, '..'), candidateWorkspace);
  removePrivateFileReference(reference, CHECK_RUN_PREPARED_DESCRIPTOR_MAX_BYTES, 'preparation intent', options);
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

function finalCustodyIdentity(
  record: Pick<
    CheckRunInvocationRecord,
    'binding' | 'snapshot' | 'candidateWorkspace' | 'returns' | 'preparedExecution' | 'descriptor' | 'preparationIntent'
  >,
  physical: CheckRunPhysicalIdentity,
): CheckRunFinalCustody['identity'] {
  const core = {
    bindingSha256: checkRunBindingHash(record.binding),
    physical: validatePhysical(physical),
    sourceSha256: record.snapshot?.sourceSha256 ?? null,
    snapshotSha256: record.snapshot ? jsonSha256(record.snapshot) : null,
    candidateWorkspaceSha256: record.candidateWorkspace ? jsonSha256(record.candidateWorkspace) : null,
    returnsSha256: jsonSha256(record.returns),
    preparedExecutionReferenceSha256: privateReferenceSha256(record.preparedExecution),
    descriptorReferenceSha256: privateReferenceSha256(record.descriptor),
    preparationIntentReferenceSha256: privateReferenceSha256(record.preparationIntent),
  };
  return { sha256: jsonSha256(core), ...core };
}

function makeFinalCustody(
  record: CheckRunInvocationRecord,
  final: CheckRunFinalSettlement,
  delivery: CheckRunFinalCustody['delivery'],
): CheckRunFinalCustody {
  if (!record.physical) throw new Error('check-run-settlement: final custody has no physical identity');
  const identity = finalCustodyIdentity(record, final.physical);
  if (identity.bindingSha256 !== checkRunBindingHash(final.binding))
    throw new Error('check-run-settlement: final custody binding differs from its invocation');
  const encoded = encodeCheckRunFinalSettlement(final);
  const settled = final.cleanup.disposition === 'settled';
  const custody: Omit<CheckRunFinalCustody, 'aggregate'> = {
    schema: 1 as const,
    delivery,
    deliverySha256: createHash('sha256').update(encoded).digest('hex'),
    privateFiles: record.preparedExecution || record.preparationIntent ? 'pending' : 'settled',
    reconciliation: settled ? 'settled' : 'unknown',
    originalFinalSha256: jsonSha256(final),
    identity,
    observations: [
      {
        observedAt: new Date().toISOString(),
        disposition: settled ? 'settled' : 'unknown',
        transportIdentity: null,
        final,
        reason: settled ? null : 'original final settlement reported unknown cleanup',
      },
    ],
    continuation: null,
  };
  return { ...custody, aggregate: aggregateFinalCustodyStatus(custody) };
}

function appendFinalCustodyObservation(
  custody: CheckRunFinalCustody,
  observation: CheckRunFinalCustodyObservation,
): CheckRunFinalCustody {
  const prior = validateFinalCustody(custody);
  let observations = prior.observations;
  let continuation = prior.continuation;
  if (observations.length < CHECK_RUN_CUSTODY_OBSERVATION_MAX) {
    observations = [...observations, observation];
  } else {
    const count = continuation?.count ?? 0;
    continuation = {
      count: Math.min(Number.MAX_SAFE_INTEGER, count + 1),
      sha256: custodyObservationChainHash(continuation?.sha256 ?? null, observation),
      first: continuation?.first ?? observation,
      latest: observation,
    };
  }
  return validateFinalCustody({
    ...prior,
    reconciliation: observation.disposition === 'settled' ? 'settled' : prior.reconciliation,
    observations,
    continuation,
  });
}

function validateFinalCustodyIdentity(record: CheckRunInvocationRecord, custody: CheckRunFinalCustody): string {
  if (!record.final || !record.physical) return 'original final or physical identity is unavailable';
  if (custody.originalFinalSha256 !== jsonSha256(record.final)) return 'original final digest changed';
  const identity = custody.identity;
  const core = {
    bindingSha256: checkRunBindingHash(record.binding),
    physical: validatePhysical(record.physical),
    sourceSha256: record.snapshot?.sourceSha256 ?? null,
    snapshotSha256: record.snapshot ? jsonSha256(record.snapshot) : null,
    candidateWorkspaceSha256: record.candidateWorkspace ? jsonSha256(record.candidateWorkspace) : null,
    returnsSha256: jsonSha256(record.returns),
    preparedExecutionReferenceSha256: identity.preparedExecutionReferenceSha256,
    descriptorReferenceSha256: identity.descriptorReferenceSha256,
    preparationIntentReferenceSha256: identity.preparationIntentReferenceSha256,
  };
  if (identity.sha256 !== jsonSha256(core)) return 'retained snapshot, declarations, or private-file identity changed';
  if (
    record.final.physical.host !== record.physical.host ||
    record.final.physical.run !== record.physical.run ||
    checkRunBindingHash(record.final.binding) !== identity.bindingSha256 ||
    identity.physical.host !== record.physical.host ||
    identity.physical.run !== record.physical.run
  )
    return 'original final binding or physical identity differs from its retained invocation';
  if (
    (record.preparedExecution &&
      privateReferenceSha256(record.preparedExecution) !== identity.preparedExecutionReferenceSha256) ||
    privateReferenceSha256(record.descriptor) !== identity.descriptorReferenceSha256 ||
    (record.preparationIntent &&
      privateReferenceSha256(record.preparationIntent) !== identity.preparationIntentReferenceSha256)
  )
    return 'retained private-file identity differs from the original invocation';
  return '';
}

function validateReconciliationCandidate(
  record: CheckRunInvocationRecord,
  custody: CheckRunFinalCustody,
  observed: CheckRunFinalSettlement,
  transportIdentity: CheckRunTransportIdentityState | null,
): string {
  const original = record.final;
  const physical = record.physical;
  const identityFailure = validateFinalCustodyIdentity(record, custody);
  if (identityFailure) return identityFailure;
  if (!original || !physical) return 'original final or physical identity is unavailable';
  const identity = custody.identity;
  if (observed.invocationId !== record.invocationId || observed.nonce !== record.nonce)
    return 'reconciliation returned a foreign invocation settlement';
  if (checkRunBindingHash(observed.binding) !== identity.bindingSha256)
    return 'reconciliation returned a changed eleven-field binding';
  if (observed.physical.host !== physical.host || observed.physical.run !== physical.run)
    return 'reconciliation returned a replacement physical host or run';
  if (transportIdentity !== 'gone-or-replaced') return 'original local transport child is not affirmatively absent';
  if (
    JSON.stringify(observed.native) !== JSON.stringify(original.native) ||
    (record.native !== null &&
      JSON.stringify(observed.native) !==
        JSON.stringify({
          exitCode: record.native.exitCode,
          lifetimeFailure: record.native.lifetimeFailure,
          receiptSha256: record.native.receiptSha256,
        }))
  )
    return 'reconciliation native result differs from the immutable original terminal observation';
  if (observed.preparedInputs.sourceSha256 !== record.binding.sourceSha256)
    return 'reconciliation prepared source differs from the original frozen source';
  if (
    original.preparedInputs.status === 'verified' &&
    JSON.stringify(observed.preparedInputs) !== JSON.stringify(original.preparedInputs)
  )
    return 'reconciliation prepared-input evidence differs from the original verified evidence';
  if (
    observed.returns.declarationsSha256 !== record.binding.returnsSha256 ||
    observed.returns.declarationsSha256 !== original.returns.declarationsSha256
  )
    return 'reconciliation return declarations differ from the original invocation';
  if (
    ['empty', 'restored'].includes(original.returns.status) &&
    JSON.stringify(observed.returns) !== JSON.stringify(original.returns)
  )
    return 'reconciliation changed previously verified returned artifacts';
  if (observed.cleanup.disposition !== 'settled') return 'original physical run cleanup remains unverified';
  return '';
}

function validateFreshReconciliationCandidate(
  record: CheckRunInvocationRecord,
  observed: CheckRunFinalSettlement,
  transportIdentity: CheckRunTransportIdentityState | null,
): string {
  if (observed.invocationId !== record.invocationId || observed.nonce !== record.nonce)
    return 'reconciliation returned a foreign invocation settlement';
  if (checkRunBindingHash(observed.binding) !== checkRunBindingHash(record.binding))
    return 'reconciliation returned a changed eleven-field binding';
  if (
    !record.physical ||
    observed.physical.host !== record.physical.host ||
    observed.physical.run !== record.physical.run
  )
    return 'reconciliation returned a replacement physical host or run';
  if (transportIdentity !== 'gone-or-replaced') return 'original local transport child is not affirmatively absent';
  if (
    record.native &&
    JSON.stringify(observed.native) !==
      JSON.stringify({
        exitCode: record.native.exitCode,
        lifetimeFailure: record.native.lifetimeFailure,
        receiptSha256: record.native.receiptSha256,
      })
  )
    return 'reconciliation native result differs from the retained terminal event';
  if (observed.preparedInputs.sourceSha256 !== record.binding.sourceSha256)
    return 'reconciliation prepared source differs from the original frozen source';
  if (record.snapshot && observed.preparedInputs.sourceSha256 !== record.snapshot.sourceSha256)
    return 'reconciliation prepared inputs do not match the retained snapshot';
  if (
    observed.returns.declarationsSha256 !== record.binding.returnsSha256 ||
    observed.returns.declarationsSha256 !== jsonSha256(record.returns)
  )
    return 'reconciliation return declarations differ from the registered invocation';
  if (observed.cleanup.disposition !== 'settled') return 'original physical run cleanup remains unverified';
  return '';
}

function validateRecord(value: unknown): CheckRunInvocationRecord {
  const item = closedObjectWithOptional(
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
    ['preparedExecution', 'descriptor', 'preparationIntent', 'snapshotCustody', 'finalCustody'],
    'invocation record',
  );
  if (item.schema !== 1 || typeof item.invocationId !== 'string' || !UUID.test(item.invocationId))
    throw new Error('check-run-settlement: invalid invocation record identity');
  const nonce = boundedText(item.nonce, 'invocation nonce', 128);
  if (!/^[a-f0-9]{64}$/.test(nonce)) throw new Error('check-run-settlement: invalid invocation record nonce');
  if (
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
    throw new Error('check-run-settlement: invalid invocation phase');
  const cancellation = closedObject(item.cancellation, ['requested', 'signal'], 'cancellation state');
  if (
    typeof cancellation.requested !== 'boolean' ||
    (cancellation.signal !== null && ![1, 2, 15].includes(Number(cancellation.signal)))
  )
    throw new Error('check-run-settlement: invalid cancellation state');
  let snapshot: CheckRunInvocationRecord['snapshot'] = null;
  if (item.snapshot !== null) {
    const rawSnapshot = closedObject(
      item.snapshot,
      ['workspace', 'scratch', 'sourceSha256', 'inputFiles'],
      'snapshot state',
    );
    const workspace = boundedText(rawSnapshot.workspace, 'frozen workspace path', 4096);
    const scratch = boundedText(rawSnapshot.scratch, 'frozen scratch path', 4096);
    if (!isAbsolute(workspace) || !isAbsolute(scratch))
      throw new Error('check-run-settlement: snapshot paths must be absolute');
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
    if (!isAbsolute(candidateWorkspace))
      throw new Error('check-run-settlement: candidate workspace path must be absolute');
  }
  const privateFileReference = (value: unknown, label: string): { file: string; sha256: string } | null => {
    if (value === undefined || value === null) return null;
    const reference = closedObject(value, ['file', 'sha256'], label);
    const file = boundedText(reference.file, `${label} path`, 4096);
    if (!isAbsolute(file)) throw new Error(`check-run-settlement: ${label} path must be absolute`);
    return { file, sha256: boundedHash(reference.sha256, `${label} digest`) };
  };
  const snapshotCustody = item.snapshotCustody === undefined ? null : item.snapshotCustody;
  if (snapshotCustody !== null && !['owned', 'removed', 'unknown'].includes(String(snapshotCustody)))
    throw new Error('check-run-settlement: invalid snapshot custody');
  const preparedExecution = privateFileReference(item.preparedExecution, 'prepared execution');
  const descriptor = privateFileReference(item.descriptor, 'prepared descriptor');
  const preparationIntent = privateFileReference(item.preparationIntent, 'preparation intent');
  if (item.phase === 'prepared' && (!snapshot || !preparedExecution || !descriptor))
    throw new Error('check-run-settlement: prepared invocation is missing its durable execution state');
  if (item.phase === 'claimed' && (!snapshot || !descriptor))
    throw new Error('check-run-settlement: prepared invocation is missing its durable execution state');
  if (['prepared', 'claimed'].includes(String(item.phase)) && snapshotCustody !== 'owned')
    throw new Error('check-run-settlement: prepared invocation does not own its frozen snapshot');
  if (!Array.isArray(item.returns) || item.returns.length > CHECK_RUN_SETTLEMENT_MAX_ITEMS)
    throw new Error('check-run-settlement: invalid declared returns');
  const returns = validatePathList(item.returns, 'declared return path', true);
  const failure = item.failure === null ? null : boundedText(item.failure, 'failure detail');
  const final = item.final === null ? null : validateCheckRunFinalSettlement(item.final);
  const finalCustody = item.finalCustody == null ? null : validateFinalCustody(item.finalCustody);
  const phase =
    item.phase === 'settled' && finalCustody?.aggregate !== 'settled'
      ? 'unknown'
      : (item.phase as CheckRunInvocationPhase);
  return {
    schema: 1,
    invocationId: item.invocationId,
    nonce,
    createdAt: boundedText(item.createdAt, 'creation time', 64),
    updatedAt: boundedText(item.updatedAt, 'update time', 64),
    phase,
    binding: validateCheckRunInvocationBinding(item.binding),
    physical: item.physical === null ? null : validatePhysical(item.physical),
    transportChild: item.transportChild === null ? null : validateTransportChild(item.transportChild),
    native: validateNative(item.native),
    snapshot,
    candidateWorkspace,
    preparedExecution,
    descriptor,
    preparationIntent,
    snapshotCustody: snapshotCustody as CheckRunInvocationRecord['snapshotCustody'],
    returns,
    cancellation: {
      requested: cancellation.requested,
      signal: cancellation.signal as 1 | 2 | 15 | null,
    },
    final,
    finalCustody,
    failure,
  };
}

function readRecord(directory: string, id: string): CheckRunInvocationRecord {
  const file = recordPath(directory, id);
  const raw = readPrivateFile(file, CHECK_RUN_INVOCATION_RECORD_MAX_BYTES, 'invocation record');
  return validateRecord(parseUniqueJson(raw.toString('utf8')));
}

function removePrivateFileReference(
  reference: { file: string; sha256: string },
  maximumBytes: number,
  label: string,
  options: CheckRunStateOptions,
): void {
  const absolute = resolve(reference.file);
  if (absolute !== reference.file) throw new Error(`check-run-settlement: ${label} path is not canonical`);
  assertCanonicalParent(absolute, label);
  const parent = resolve(absolute, '..');
  assertPrivateDirectory(parent, `${label} directory`);
  let before;
  try {
    before = lstatSync(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    syncDirectory(parent);
    return;
  }
  const raw = readPrivateFile(absolute, maximumBytes, label);
  if (createHash('sha256').update(raw).digest('hex') !== reference.sha256)
    throw new Error(`check-run-settlement: ${label} state was substituted`);
  const current = lstatSync(absolute);
  if (
    !current.isFile() ||
    current.isSymbolicLink() ||
    current.dev !== before.dev ||
    current.ino !== before.ino ||
    current.nlink !== 1 ||
    (current.mode & 0o077) !== 0 ||
    (typeof process.getuid === 'function' && current.uid !== process.getuid())
  )
    throw new Error(`check-run-settlement: ${label} identity changed during disposal`);
  (options.removePrivateFile ?? unlinkSync)(absolute);
  syncDirectory(parent);
  try {
    lstatSync(absolute);
    throw new Error(`check-run-settlement: ${label} removal was not verified`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

function retainedPreparationIntentDescriptor(
  record: CheckRunInvocationRecord,
  reference: { file: string; sha256: string },
): string {
  const suffix = '.intent.json';
  if (!record.candidateWorkspace || !reference.file.endsWith(suffix) || resolve(reference.file) !== reference.file)
    throw new Error('check-run-settlement: preparation intent reference is not bound to a retained candidate');
  const descriptorFile = reference.file.slice(0, -suffix.length);
  if (
    !descriptorFile ||
    checkRunPreparationIntentFile(descriptorFile) !== reference.file ||
    (record.descriptor &&
      (record.descriptor.file !== descriptorFile ||
        !isAbsolute(record.descriptor.file) ||
        resolve(record.descriptor.file) !== record.descriptor.file))
  )
    throw new Error('check-run-settlement: preparation intent path differs from its durable descriptor identity');
  assertCanonicalParent(reference.file, 'preparation intent');
  const parent = resolve(reference.file, '..');
  assertPrivateDirectory(parent, 'preparation intent directory');
  assertOutsideCandidate(parent, record.candidateWorkspace);
  return descriptorFile;
}

function validatePreparationIntentForRecord(
  record: CheckRunInvocationRecord,
  descriptorFile: string,
  intent: CheckRunPreparationIntent,
): void {
  if (
    intent.invocationId !== record.invocationId ||
    intent.descriptor !== descriptorFile ||
    intent.candidateWorkspace !== record.candidateWorkspace ||
    (record.snapshot &&
      (intent.snapshot.workspace !== record.snapshot.workspace ||
        intent.snapshot.scratch !== record.snapshot.scratch ||
        (intent.snapshot.sourceSha256 !== null && intent.snapshot.sourceSha256 !== record.snapshot.sourceSha256)))
  )
    throw new Error('check-run-settlement: preparation intent differs from its durable invocation');
}

function retainedPreparationIntentIsAbsent(file: string): boolean {
  try {
    lstatSync(file);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return true;
  }
}

function readRetainedPreparationIntent(
  record: CheckRunInvocationRecord,
  reference: { file: string; sha256: string },
): CheckRunPreparationIntent | null {
  const descriptorFile = retainedPreparationIntentDescriptor(record, reference);
  if (retainedPreparationIntentIsAbsent(reference.file)) return null;
  try {
    const { intent, reference: actual } = readCheckRunPreparationIntentReference(reference.file);
    if (actual.sha256 !== reference.sha256)
      throw new Error('check-run-settlement: preparation intent state was substituted');
    validatePreparationIntentForRecord(record, descriptorFile, intent);
    return intent;
  } catch (error) {
    // An unlink may have completed before its durable reference clear was lost. Only a verified ENOENT
    // under the already checked canonical private parent recovers that narrow crash boundary.
    if (retainedPreparationIntentIsAbsent(reference.file)) return null;
    throw error;
  }
}

type PrivateCleanupResult = { record: CheckRunInvocationRecord; failure?: Error };

async function cleanupPrivateReferencesUnderLock(
  directory: string,
  initial: CheckRunInvocationRecord,
  options: CheckRunStateOptions,
): Promise<PrivateCleanupResult> {
  let record = initial;
  // The caller descriptor remains the durable replay-resistant handle; private execution and pre-exposure intent are erased.
  for (const field of ['preparedExecution', 'preparationIntent'] as const) {
    const reference = record[field];
    if (!reference) continue;
    try {
      if (field === 'preparedExecution') {
        if (reference.file !== preparedExecutionFile(directory, record.invocationId))
          throw new Error('check-run-settlement: prepared execution path does not match its invocation');
        removePrivateFileReference(reference, CHECK_RUN_PREPARED_EXECUTION_MAX_BYTES, 'prepared execution', options);
        record = await updateRecord(directory, record, { preparedExecution: null });
      } else {
        const intent = readRetainedPreparationIntent(record, reference);
        const candidateWorkspace = record.candidateWorkspace;
        if (!candidateWorkspace)
          throw new Error('check-run-settlement: preparation intent has no retained candidate identity');
        if (intent)
          validatePreparationIntentForRecord(record, retainedPreparationIntentDescriptor(record, reference), intent);
        removeCheckRunPreparationIntentFile(reference, candidateWorkspace, options);
        record = await updateRecord(directory, record, { preparationIntent: null });
      }
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      if (record.finalCustody) {
        try {
          record = await updateRecord(directory, record, {
            phase: 'unknown',
            finalCustody: { ...record.finalCustody, privateFiles: 'unknown' },
          });
        } catch {
          // The previous durable record still contains the exact outstanding file reference.
        }
      }
      return { record, failure };
    }
  }
  if (record.finalCustody) {
    const finalCustody =
      record.finalCustody.privateFiles === 'settled'
        ? record.finalCustody
        : validateFinalCustody({ ...record.finalCustody, privateFiles: 'settled' });
    const phase = finalCustody.aggregate === 'settled' ? 'settled' : 'unknown';
    if (record.finalCustody.privateFiles !== 'settled' || record.phase !== phase)
      record = await updateRecord(directory, record, { phase, finalCustody });
  }
  return { record };
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
  options: CheckRunStateOptions & {
    invocationId?: string;
    candidateWorkspace?: string;
    snapshot?: { workspace: string; scratch: string; sourceSha256: string; inputFiles: readonly string[] };
    returns?: readonly string[];
    preparationIntent?: { file: string; sha256: string };
    descriptorFile?: string;
  } = {},
): Promise<CheckRunRegistration> {
  const binding = validateCheckRunInvocationBinding(bindingValue);
  const directory = checkRunSettlementStateDirectory(options);
  assertOutsideCandidate(directory, options.candidateWorkspace);
  const invocationId = (options.invocationId ?? randomUUID()).toLowerCase();
  if (!UUID.test(invocationId)) throw new Error('check-run-settlement: invocation id must be a UUID');
  const candidateWorkspace = options.candidateWorkspace ? resolve(options.candidateWorkspace) : null;
  const snapshot = options.snapshot
    ? {
        workspace: resolve(options.snapshot.workspace),
        scratch: resolve(options.snapshot.scratch),
        sourceSha256: boundedHash(options.snapshot.sourceSha256, 'snapshot source hash'),
        inputFiles: validateInputFiles([...options.snapshot.inputFiles]),
      }
    : null;
  const returns = options.returns ? validatePathList([...options.returns], 'declared return path', true) : [];
  if (snapshot && snapshot.sourceSha256 !== binding.sourceSha256)
    throw new Error('check-run-settlement: registered snapshot does not match its binding');
  if (options.returns && jsonSha256(returns) !== binding.returnsSha256)
    throw new Error('check-run-settlement: registered returns do not match their binding');
  if (candidateWorkspace) assertOutsideCandidate(directory, candidateWorkspace);
  let preparationIntent: { file: string; sha256: string } | null = null;
  if (options.preparationIntent) {
    preparationIntent = {
      file: boundedText(options.preparationIntent.file, 'preparation intent path', 4096),
      sha256: boundedHash(options.preparationIntent.sha256, 'preparation intent digest'),
    };
    const rawIntent = readPrivateFile(
      preparationIntent.file,
      CHECK_RUN_PREPARED_DESCRIPTOR_MAX_BYTES,
      'preparation intent',
    );
    if (createHash('sha256').update(rawIntent).digest('hex') !== preparationIntent.sha256)
      throw new Error('check-run-settlement: preparation intent was substituted');
    const intent = validateCheckRunPreparationIntent(parseUniqueJson(rawIntent.toString('utf8')));
    if (
      intent.invocationId !== invocationId ||
      intent.candidateWorkspace !== candidateWorkspace ||
      (options.descriptorFile && intent.descriptor !== resolve(options.descriptorFile)) ||
      (snapshot &&
        (intent.snapshot.workspace !== snapshot.workspace ||
          intent.snapshot.scratch !== snapshot.scratch ||
          (intent.snapshot.sourceSha256 !== null && intent.snapshot.sourceSha256 !== snapshot.sourceSha256)))
    )
      throw new Error('check-run-settlement: preparation intent differs from the registered invocation');
  }
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
      snapshot,
      candidateWorkspace,
      preparedExecution: null,
      descriptor: null,
      preparationIntent,
      snapshotCustody: snapshot ? 'owned' : null,
      returns,
      cancellation: { requested: false, signal: null },
      final: null,
      finalCustody: null,
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

export async function persistCheckRunPreparedInvocation(
  registration: CheckRunRegistration,
  options: CheckRunStateOptions & {
    candidateWorkspace: string;
    snapshot: { workspace: string; scratch: string; sourceSha256: string; inputFiles: readonly string[] };
    returns: readonly string[];
    descriptorFile: string;
    execution: unknown;
  },
): Promise<CheckRunPreparedDescriptor> {
  if (!isAbsolute(options.descriptorFile))
    throw new Error('check-run-settlement: prepared descriptor path must be absolute');
  const directory = checkRunSettlementStateDirectory(options);
  const descriptorFile = resolve(options.descriptorFile);
  const descriptorDirectory = resolve(descriptorFile, '..');
  assertPrivateDirectory(descriptorDirectory, 'prepared descriptor directory');
  assertCanonicalParent(descriptorFile, 'prepared descriptor');
  assertOutsideCandidate(directory, options.candidateWorkspace);
  assertOutsideCandidate(descriptorDirectory, options.candidateWorkspace);
  if (existsSync(descriptorFile)) throw new Error('check-run-settlement: prepared descriptor path already exists');
  const snapshot = {
    workspace: resolve(options.snapshot.workspace),
    scratch: resolve(options.snapshot.scratch),
    sourceSha256: boundedHash(options.snapshot.sourceSha256, 'snapshot source hash'),
    inputFiles: validateInputFiles([...options.snapshot.inputFiles]),
  };
  const candidateWorkspace = resolve(options.candidateWorkspace);
  const returns = validatePathList([...options.returns], 'declared return path', true);
  if (snapshot.sourceSha256 !== registration.binding.sourceSha256)
    throw new Error('check-run-settlement: prepared snapshot does not match its registered binding');
  if (createHash('sha256').update(JSON.stringify(returns)).digest('hex') !== registration.binding.returnsSha256)
    throw new Error('check-run-settlement: prepared returns do not match their registered binding');
  const executionFile = preparedExecutionFile(directory, registration.invocationId);
  const executionBytes = Buffer.from(`${JSON.stringify(options.execution)}\n`);
  if (executionBytes.byteLength > CHECK_RUN_PREPARED_EXECUTION_MAX_BYTES)
    throw new Error('check-run-settlement: prepared execution exceeds its byte bound');
  const descriptor: CheckRunPreparedDescriptor = {
    schema: 1,
    type: 'check-run-preparation',
    invocationId: registration.invocationId,
    nonce: registration.nonce,
    binding: registration.binding,
    cancellation: registration.cancellation,
  };
  const descriptorBytes = Buffer.from(`${JSON.stringify(descriptor)}\n`);
  if (descriptorBytes.byteLength > CHECK_RUN_PREPARED_DESCRIPTOR_MAX_BYTES)
    throw new Error('check-run-settlement: prepared descriptor exceeds its byte bound');
  const executionHash = createHash('sha256').update(executionBytes).digest('hex');
  const descriptorHash = createHash('sha256').update(descriptorBytes).digest('hex');
  return withCheckFence(directory, registration.invocationId, async () => {
    const record = readRecord(directory, registration.invocationId);
    if (record.nonce !== registration.nonce) throw new Error('check-run-settlement: wrong invocation nonce');
    if (record.phase !== 'registered' || cancellationWasRequested(directory, record))
      throw new Error('check-run-settlement: invocation is no longer available for preparation');
    if (
      checkRunBindingHash(record.binding) !== checkRunBindingHash(registration.binding) ||
      record.candidateWorkspace !== candidateWorkspace ||
      JSON.stringify(record.returns) !== JSON.stringify(returns) ||
      (record.snapshot !== null && JSON.stringify(record.snapshot) !== JSON.stringify(snapshot))
    )
      throw new Error('check-run-settlement: registered preparation identity cannot be rebound');
    if (record.preparationIntent) {
      if (record.preparationIntent.file !== checkRunPreparationIntentFile(descriptorFile))
        throw new Error('check-run-settlement: descriptor path differs from the registered preparation intent');
      const { intent, reference } = readCheckRunPreparationIntentReference(record.preparationIntent.file);
      if (
        reference.sha256 !== record.preparationIntent.sha256 ||
        intent.invocationId !== record.invocationId ||
        intent.descriptor !== descriptorFile ||
        intent.candidateWorkspace !== candidateWorkspace ||
        intent.snapshot.workspace !== snapshot.workspace ||
        intent.snapshot.scratch !== snapshot.scratch ||
        (intent.snapshot.sourceSha256 !== null && intent.snapshot.sourceSha256 !== snapshot.sourceSha256)
      )
        throw new Error('check-run-settlement: preparation intent differs from registered snapshot custody');
    }
    const recordedCustody = await updateRecord(directory, record, {
      candidateWorkspace,
      snapshot,
      returns,
      preparedExecution: { file: executionFile, sha256: executionHash },
      descriptor: { file: descriptorFile, sha256: descriptorHash },
      snapshotCustody: 'owned',
    });
    writeNewPrivateFile(executionFile, executionBytes, CHECK_RUN_PREPARED_EXECUTION_MAX_BYTES, 'prepared execution');
    const next = await updateRecord(directory, recordedCustody, { phase: 'prepared' });
    if (next.phase !== 'prepared') throw new Error('check-run-settlement: prepared invocation was not persisted');
    writeNewPrivateFile(
      descriptorFile,
      descriptorBytes,
      CHECK_RUN_PREPARED_DESCRIPTOR_MAX_BYTES,
      'prepared descriptor',
    );
    return descriptor;
  });
}

export function readCheckRunPreparedDescriptor(file: string): CheckRunPreparedDescriptor {
  return readCheckRunPreparedDescriptorReference(file).descriptor;
}

export function readCheckRunPreparedDescriptorReference(file: string): {
  descriptor: CheckRunPreparedDescriptor;
  reference: { file: string; sha256: string };
} {
  if (!isAbsolute(file)) throw new Error('check-run-settlement: prepared descriptor path must be absolute');
  const absolute = resolve(file);
  assertCanonicalParent(absolute, 'prepared descriptor');
  const raw = readPrivateFile(absolute, CHECK_RUN_PREPARED_DESCRIPTOR_MAX_BYTES, 'prepared descriptor');
  try {
    return {
      descriptor: validateCheckRunPreparedDescriptor(parseUniqueJson(raw.toString('utf8'))),
      reference: { file: absolute, sha256: createHash('sha256').update(raw).digest('hex') },
    };
  } catch (error) {
    throw new Error(
      `check-run-settlement: invalid prepared descriptor: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function claimCheckRunPreparedInvocation(
  descriptorFile: string,
  options: CheckRunStateOptions = {},
): Promise<{ descriptor: CheckRunPreparedDescriptor; record: CheckRunInvocationRecord; execution: unknown }> {
  const first = readCheckRunPreparedDescriptor(descriptorFile);
  const directory = checkRunSettlementStateDirectory(options);
  const absoluteDescriptorFile = resolve(descriptorFile);
  const recordPathForInvocation = recordPath(directory, first.invocationId);
  if (!existsSync(recordPathForInvocation))
    throw new Error('check-run-settlement: prepared invocation is not registered');
  return withCheckFence(directory, first.invocationId, async () => {
    const record = readRecord(directory, first.invocationId);
    assertCanonicalParent(absoluteDescriptorFile, 'prepared descriptor');
    const rawDescriptor = readPrivateFile(
      absoluteDescriptorFile,
      CHECK_RUN_PREPARED_DESCRIPTOR_MAX_BYTES,
      'prepared descriptor',
    );
    const descriptor = validateCheckRunPreparedDescriptor(parseUniqueJson(rawDescriptor.toString('utf8')));
    const descriptorHash = createHash('sha256').update(rawDescriptor).digest('hex');
    if (
      !record.descriptor ||
      record.descriptor.file !== absoluteDescriptorFile ||
      record.descriptor.sha256 !== descriptorHash ||
      first.invocationId !== descriptor.invocationId ||
      first.nonce !== descriptor.nonce ||
      checkRunBindingHash(first.binding) !== checkRunBindingHash(descriptor.binding) ||
      JSON.stringify(first.cancellation) !== JSON.stringify(descriptor.cancellation) ||
      record.nonce !== descriptor.nonce ||
      checkRunBindingHash(record.binding) !== checkRunBindingHash(descriptor.binding) ||
      descriptor.cancellation.file !== cancellationFile(directory, descriptor.invocationId) ||
      descriptor.cancellation.id !== descriptor.invocationId
    )
      throw new Error('check-run-settlement: prepared descriptor does not match its durable invocation');
    if (record.phase !== 'prepared' || cancellationWasRequested(directory, record) || record.final)
      throw new Error(`check-run-settlement: prepared invocation cannot be claimed from ${record.phase}`);
    if (
      !record.preparedExecution ||
      record.preparedExecution.file !== preparedExecutionFile(directory, record.invocationId)
    )
      throw new Error('check-run-settlement: prepared execution state is unavailable');
    const rawExecution = readPrivateFile(
      record.preparedExecution.file,
      CHECK_RUN_PREPARED_EXECUTION_MAX_BYTES,
      'prepared execution',
    );
    if (createHash('sha256').update(rawExecution).digest('hex') !== record.preparedExecution.sha256)
      throw new Error('check-run-settlement: prepared execution state was substituted');
    const execution = parseUniqueJson(rawExecution.toString('utf8'));
    const claimed = await updateRecord(directory, record, { phase: 'claimed' });
    return { descriptor, record: claimed, execution };
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
    if (cancellationWasRequested(directory, record))
      throw new Error('check-run-settlement: cancelled invocation cannot queue');
    if (record.phase !== 'registered' && record.phase !== 'claimed' && record.phase !== 'queued')
      throw new Error(`check-run-settlement: cannot queue from ${record.phase}`);
    if (options.candidateWorkspace) assertOutsideCandidate(directory, options.candidateWorkspace);
    const selectedReturns = options.returns
      ? validatePathList([...options.returns], 'declared return path', true)
      : record.returns;
    if (
      options.returns &&
      createHash('sha256').update(JSON.stringify(selectedReturns)).digest('hex') !== record.binding.returnsSha256
    )
      throw new Error('check-run-settlement: declared returns do not match the registered binding');
    if (
      options.snapshot &&
      (!options.returns ||
        boundedHash(options.snapshot.sourceSha256, 'snapshot source hash') !== record.binding.sourceSha256)
    )
      throw new Error(
        'check-run-settlement: frozen snapshot or return declarations do not match the registered binding',
      );
    if (record.phase === 'claimed') {
      const candidateWorkspace = options.candidateWorkspace ? resolve(options.candidateWorkspace) : null;
      const paths = options.returns ? validatePathList([...options.returns], 'declared return path', true) : [];
      const snapshot = options.snapshot
        ? {
            workspace: resolve(options.snapshot.workspace),
            scratch: resolve(options.snapshot.scratch),
            sourceSha256: boundedHash(options.snapshot.sourceSha256, 'snapshot source hash'),
            inputFiles: validateInputFiles(options.snapshot.inputFiles ?? []),
          }
        : null;
      if (
        candidateWorkspace !== record.candidateWorkspace ||
        JSON.stringify(paths) !== JSON.stringify(record.returns) ||
        JSON.stringify(snapshot) !== JSON.stringify(record.snapshot)
      )
        throw new Error('check-run-settlement: claimed prepared invocation identity cannot be rebound');
      return updateRecord(directory, record, { phase: 'queued' });
    }
    if (record.phase === 'queued') {
      const candidateWorkspace = options.candidateWorkspace
        ? resolve(options.candidateWorkspace)
        : record.candidateWorkspace;
      const paths = options.returns
        ? validatePathList([...options.returns], 'declared return path', true)
        : record.returns;
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
    if (cancellationWasRequested(directory, record))
      throw new Error('check-run-settlement: cancelled invocation cannot allocate a run');
    if (record.phase !== 'queued' && record.phase !== 'uploading')
      throw new Error(`check-run-settlement: cannot allocate a run from ${record.phase}`);
    const physical = validatePhysical({ host, run });
    if (record.physical && (record.physical.host !== physical.host || record.physical.run !== physical.run))
      throw new Error('check-run-settlement: invocation already owns a different physical run');
    return updateRecord(directory, record, { phase: 'uploading', physical });
  });
}

/** Linearize the queued-to-admission boundary against durable cancellation before transport starts. */
export async function beginCheckRunAllocation(
  invocationId: string,
  nonce: string,
  options: CheckRunStateOptions = {},
): Promise<CheckRunInvocationRecord> {
  return mutateRecord(invocationId, options, async (directory, record) => {
    if (record.nonce !== nonce) throw new Error('check-run-settlement: wrong invocation nonce');
    if (record.final) throw new Error('check-run-settlement: invocation is already terminal');
    if (cancellationWasRequested(directory, record))
      throw new Error('check-run-settlement: cancelled invocation cannot begin allocation');
    if (record.phase !== 'queued')
      throw new Error(`check-run-settlement: allocation admission needs a queued invocation, got ${record.phase}`);
    return updateRecord(directory, record, { phase: 'uploading' });
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
    if (cancellationWasRequested(directory, record))
      throw new Error('check-run-settlement: cancelled invocation cannot start');
    if (!record.physical || record.physical.host !== physical.host || record.physical.run !== physical.run)
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
    if (!record.physical || record.physical.host !== physical.host || record.physical.run !== physical.run)
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
    return acceptFinalUnderLock(directory, record, raw, 'received', options);
  });
}

/** Pin a final durably before attempting FD 3 emission; the digest blocks contradictory replay. */
export async function stageCheckRunFinalSettlement(
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
    return acceptFinalUnderLock(directory, record, raw, 'pending', options);
  });
}

export async function markCheckRunFinalSettlementDelivery(
  invocationId: string,
  deliverySha256: string,
  disposition: 'delivered' | 'unknown' | 'not-required',
  options: CheckRunStateOptions = {},
): Promise<CheckRunInvocationRecord> {
  return mutateRecord(invocationId, options, async (directory, record) => {
    if (!record.final || !record.finalCustody)
      throw new Error('check-run-settlement: final settlement is not durably staged');
    const digest = boundedHash(deliverySha256, 'final delivery digest');
    if (
      digest !== record.finalCustody.deliverySha256 ||
      record.finalCustody.originalFinalSha256 !== jsonSha256(record.final)
    )
      throw new Error('check-run-settlement: final delivery does not match the immutable original settlement');
    if (record.finalCustody.delivery === disposition) return record;
    if (record.finalCustody.delivery !== 'pending')
      throw new Error('check-run-settlement: final delivery state is already terminal');
    const finalCustody = validateFinalCustody({ ...record.finalCustody, delivery: disposition });
    return updateRecord(directory, record, {
      phase: finalCustody.aggregate === 'settled' ? 'settled' : 'unknown',
      finalCustody,
    });
  });
}

async function acceptFinalUnderLock(
  directory: string,
  record: CheckRunInvocationRecord,
  raw: string,
  delivery: CheckRunFinalCustody['delivery'],
  options: CheckRunStateOptions,
): Promise<CheckRunInvocationRecord> {
  if (record.final) throw new Error('check-run-settlement: duplicate or replayed final authority');
  const message = decodeCheckRunSettlement(raw, {
    invocationId: record.invocationId,
    nonce: record.nonce,
    binding: record.binding,
    ...(record.physical ? { physical: record.physical } : {}),
    nativeTerminalSeen: record.native !== null,
    ...(record.native ? { nativeTerminal: record.native } : {}),
  });
  if (record.phase !== 'native-terminal')
    throw new Error(`check-run-settlement: final authority is out of order from ${record.phase}`);
  if (
    !record.native ||
    !message.native ||
    message.native.exitCode !== record.native.exitCode ||
    message.native.lifetimeFailure !== record.native.lifetimeFailure ||
    message.native.receiptSha256 !== record.native.receiptSha256
  )
    throw new Error('check-run-settlement: final native outcome differs from the retained terminal event');
  const finalCustody = makeFinalCustody(record, message, delivery);
  const phase = finalCustody.aggregate === 'settled' ? 'settled' : 'unknown';
  const snapshotCustody: CheckRunInvocationRecord['snapshotCustody'] =
    message.cleanup.localWorktree === 'removed'
      ? 'removed'
      : message.cleanup.localWorktree === 'retained'
        ? 'owned'
        : 'unknown';
  const next = await updateRecord(directory, record, {
    phase,
    final: message,
    finalCustody,
    snapshotCustody,
  });
  return (await cleanupPrivateReferencesUnderLock(directory, next, options)).record;
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
      // Keep the terminal native observation's phase so a racing authenticated final can still be admitted.
      phase: record.phase === 'native-terminal' ? 'native-terminal' : 'cancel-requested',
      cancellation: { requested: true, signal: selectedSignal },
    });
    requestExecutionCancellation({ file: cancellationFile(directory, invocationId), id: invocationId }, selectedSignal);
    return next;
  });
}

export async function reconcileCheckRunInvocation(
  invocationId: string,
  options: CheckRunReconcileOptions = {},
): Promise<CheckRunInvocationRecord> {
  const before = await getCheckRunStatus(invocationId, options);
  if (before.final) {
    const custody = before.finalCustody ?? makeFinalCustody(before, before.final, 'unknown');
    const identityFailure = validateFinalCustodyIdentity(before, custody);
    if (identityFailure) {
      return mutateRecord(invocationId, options, async (directory, record) => {
        if (!record.final) return record;
        const currentCustody = record.finalCustody ?? makeFinalCustody(record, record.final, 'unknown');
        const reason = validateFinalCustodyIdentity(record, currentCustody) || identityFailure;
        const updated = appendFinalCustodyObservation(currentCustody, {
          observedAt: new Date().toISOString(),
          disposition: 'rejected',
          transportIdentity: null,
          final: null,
          reason,
        });
        return updateRecord(directory, record, {
          phase: 'unknown',
          finalCustody: { ...updated, reconciliation: 'unknown' },
          failure: reason,
        });
      });
    }
    if (custody.reconciliation === 'settled' || before.final.cleanup.disposition === 'settled') {
      return mutateRecord(invocationId, options, async (directory, record) => {
        if (!record.final) return record;
        const currentCustody = record.finalCustody ?? makeFinalCustody(record, record.final, 'unknown');
        const currentIdentityFailure = validateFinalCustodyIdentity(record, currentCustody);
        if (currentIdentityFailure) {
          const updated = appendFinalCustodyObservation(currentCustody, {
            observedAt: new Date().toISOString(),
            disposition: 'rejected',
            transportIdentity: null,
            final: null,
            reason: currentIdentityFailure,
          });
          return updateRecord(directory, record, {
            phase: 'unknown',
            finalCustody: { ...updated, reconciliation: 'unknown' },
            failure: currentIdentityFailure,
          });
        }
        const cleaned = await cleanupPrivateReferencesUnderLock(
          directory,
          record.finalCustody ? record : await updateRecord(directory, record, { finalCustody: currentCustody }),
          options,
        );
        return cleaned.record;
      });
    }
    if (!before.physical || !options.reconcilePhysical) {
      return mutateRecord(invocationId, options, async (directory, record) => {
        if (!record.final || !record.finalCustody) {
          if (!record.final) return record;
          return updateRecord(directory, record, {
            phase: 'unknown',
            finalCustody: makeFinalCustody(record, record.final, 'unknown'),
            failure: 'exact physical reconciliation evidence is unavailable; original final remains immutable',
          });
        }
        const custody = record.finalCustody;
        if (custody.reconciliation === 'settled')
          return (await cleanupPrivateReferencesUnderLock(directory, record, options)).record;
        const updated = appendFinalCustodyObservation(custody, {
          observedAt: new Date().toISOString(),
          disposition: 'unknown',
          transportIdentity: null,
          final: null,
          reason: 'exact physical reconciliation evidence is unavailable; original final remains immutable',
        });
        return updateRecord(directory, record, {
          phase: 'unknown',
          finalCustody: updated,
          failure: 'exact physical reconciliation evidence is unavailable; original final remains immutable',
        });
      });
    }

    let observedFinal: CheckRunFinalSettlement | null = null;
    let observedTransportIdentity: CheckRunTransportIdentityState | null = null;
    let reconciliationFailure = 'reconciliation did not return exact custody evidence';
    try {
      const observed = await options.reconcilePhysical(before.physical, before);
      observedTransportIdentity = observed.transportIdentity ?? null;
      if (observed.disposition === 'settled') observedFinal = validateCheckRunFinalSettlement(observed.final);
      else reconciliationFailure = boundedText(observed.reason, 'reconciliation failure');
      if (observedFinal)
        reconciliationFailure = validateReconciliationCandidate(
          before,
          custody,
          observedFinal,
          observedTransportIdentity,
        );
    } catch (error) {
      reconciliationFailure = `reconciliation failed for the original physical run: ${error instanceof Error ? error.message.slice(0, 512) : 'unknown error'}`;
    }
    return mutateRecord(invocationId, options, async (directory, record) => {
      if (!record.final) return record;
      const currentCustody = record.finalCustody ?? makeFinalCustody(record, record.final, 'unknown');
      const currentIdentityFailure = validateFinalCustodyIdentity(record, currentCustody);
      if (currentIdentityFailure) {
        const updated = appendFinalCustodyObservation(currentCustody, {
          observedAt: new Date().toISOString(),
          disposition: observedFinal ? 'rejected' : 'unknown',
          transportIdentity: observedTransportIdentity,
          final: observedFinal,
          reason: currentIdentityFailure,
        });
        return updateRecord(directory, record, {
          phase: 'unknown',
          finalCustody: { ...updated, reconciliation: 'unknown' },
          failure: currentIdentityFailure,
        });
      }
      if (currentCustody.reconciliation === 'settled')
        return (await cleanupPrivateReferencesUnderLock(directory, record, options)).record;
      const currentCandidateFailure = observedFinal
        ? validateReconciliationCandidate(record, currentCustody, observedFinal, observedTransportIdentity)
        : '';
      const reason = currentCandidateFailure || reconciliationFailure || null;
      const disposition = observedFinal
        ? reason
          ? 'rejected'
          : observedFinal.cleanup.disposition === 'settled'
            ? 'settled'
            : 'unknown'
        : 'unknown';
      const updatedCustody = appendFinalCustodyObservation(currentCustody, {
        observedAt: new Date().toISOString(),
        disposition,
        transportIdentity: observedTransportIdentity,
        final: observedFinal,
        reason,
      });
      const phase = updatedCustody.aggregate === 'settled' ? 'settled' : 'unknown';
      const snapshotCustody: CheckRunInvocationRecord['snapshotCustody'] =
        disposition === 'settled' && observedFinal
          ? observedFinal.cleanup.localWorktree === 'removed'
            ? 'removed'
            : observedFinal.cleanup.localWorktree === 'retained'
              ? 'owned'
              : 'unknown'
          : record.snapshotCustody;
      const next = await updateRecord(directory, record, {
        phase,
        snapshotCustody,
        finalCustody: updatedCustody,
        failure: reason ?? record.failure,
      });
      return (await cleanupPrivateReferencesUnderLock(directory, next, options)).record;
    });
  }
  if (before.phase === 'unknown' && !options.force) return before;
  if (!before.physical) {
    if (before.cancellation.requested) {
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
    const mismatch = validateFreshReconciliationCandidate(before, message, observed.transportIdentity ?? null);
    if (mismatch) throw new Error(mismatch);
    return mutateRecord(invocationId, options, async (directory, record) => {
      if (record.final) return record;
      if (!record.native && message.native) {
        const recordedNative = validateNative(message.native)!;
        await updateRecord(directory, record, { native: recordedNative, phase: 'native-terminal' });
        record = readRecord(directory, invocationId);
      } else if (record.native && record.phase !== 'native-terminal') {
        if (
          record.native.exitCode !== message.native?.exitCode ||
          record.native.lifetimeFailure !== message.native?.lifetimeFailure ||
          record.native.receiptSha256 !== message.native?.receiptSha256
        )
          throw new Error('reconciliation native result differs from the retained terminal event');
        await updateRecord(directory, record, { phase: 'native-terminal' });
        record = readRecord(directory, invocationId);
      }
      const encoded = encodeCheckRunFinalSettlement(message);
      return acceptFinalUnderLock(directory, record, encoded, 'reconciled', options);
    });
  } catch (error) {
    return mutateRecord(invocationId, options, async (directory, record) => {
      const reason = `reconciliation failed for the original physical run: ${error instanceof Error ? error.message.slice(0, 512) : 'unknown error'}`;
      if (record.final) return record;
      return updateRecord(directory, record, { phase: 'unknown', failure: reason });
    });
  }
}

export async function markCheckRunPreparedSnapshotCustody(
  invocationId: string,
  nonce: string,
  disposition: 'removed' | 'unknown',
  options: CheckRunStateOptions = {},
): Promise<CheckRunInvocationRecord> {
  return mutateRecord(invocationId, options, async (directory, record) => {
    if (record.nonce !== nonce) throw new Error('check-run-settlement: wrong invocation nonce');
    if (record.final) throw new Error('check-run-settlement: final invocation custody is immutable');
    if (record.physical)
      throw new Error('check-run-settlement: physical invocation custody needs remote reconciliation');
    if (disposition === 'removed' && !['cancelled', 'unknown'].includes(record.phase))
      throw new Error('check-run-settlement: snapshot removal needs a terminal pre-physical invocation');
    const next = await updateRecord(directory, record, { snapshotCustody: disposition });
    if (disposition === 'unknown') return next;
    return (await cleanupPrivateReferencesUnderLock(directory, next, options)).record;
  });
}

export async function discardCheckRunPreparedExecution(
  invocationId: string,
  nonce: string,
  options: CheckRunStateOptions = {},
): Promise<CheckRunInvocationRecord> {
  return mutateRecord(invocationId, options, async (directory, record) => {
    if (record.nonce !== nonce) throw new Error('check-run-settlement: wrong invocation nonce');
    if (record.phase === 'prepared' || record.phase === 'registered')
      throw new Error('check-run-settlement: unclaimed prepared execution cannot be discarded');
    const result = await cleanupPrivateReferencesUnderLock(directory, record, options);
    if (result.failure) throw result.failure;
    return result.record;
  });
}

export async function discardCheckRunPreparationIntent(
  invocationId: string,
  nonce: string,
  options: CheckRunStateOptions = {},
): Promise<CheckRunInvocationRecord> {
  return mutateRecord(invocationId, options, async (directory, record) => {
    if (record.nonce !== nonce) throw new Error('check-run-settlement: wrong invocation nonce');
    if (!record.preparationIntent) return record;
    const reference = record.preparationIntent;
    const intent = readRetainedPreparationIntent(record, reference);
    const candidateWorkspace = record.candidateWorkspace;
    if (!candidateWorkspace)
      throw new Error('check-run-settlement: preparation intent has no retained candidate identity');
    if (intent)
      validatePreparationIntentForRecord(record, retainedPreparationIntentDescriptor(record, reference), intent);
    removeCheckRunPreparationIntentFile(reference, candidateWorkspace, options);
    return updateRecord(directory, record, { preparationIntent: null });
  });
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
  return createHash('sha256')
    .update(JSON.stringify(validateCheckRunInvocationBinding(bindingValue)))
    .digest('hex');
}

export function checkRunNativeReceiptDigest(receipt: RemotePhysicalRunReceipt): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        schema: receipt.schema,
        host: receipt.host,
        run: receipt.run,
        exitCode: receipt.exitCode,
        lifetimeFailure: receipt.lifetimeFailure,
      }),
    )
    .digest('hex');
}

function usage(): string {
  return [
    'Usage:',
    '  bun scripts/check-run-settlement.ts register --binding <private-json> [--state-dir <absolute-dir>]',
    '  bun scripts/check-run-settlement.ts status <invocation-id> [--state-dir <absolute-dir>]',
    '  bun scripts/check-run-settlement.ts cancel <invocation-id> [--signal 1|2|15] [--state-dir <absolute-dir>]',
    '  bun scripts/check-run-settlement.ts reconcile <invocation-id> [--hosts <absolute-hosts-json>] [--state-dir <absolute-dir>]',
    '  bun scripts/check-run-settlement.ts reconcile --descriptor <absolute-private-json> [--hosts <absolute-hosts-json>] [--state-dir <absolute-dir>]',
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
      const descriptorAt = args.indexOf('--descriptor');
      const descriptorFile = descriptorAt >= 0 ? args[descriptorAt + 1] : undefined;
      const id = descriptorAt >= 0 ? undefined : args[0];
      const hostsAt = args.indexOf('--hosts');
      const hostsFile = hostsAt >= 0 ? args[hostsAt + 1] : undefined;
      if (
        (!id && !descriptorFile) ||
        (descriptorFile !== undefined && !isAbsolute(descriptorFile)) ||
        (hostsFile !== undefined && !isAbsolute(hostsFile))
      )
        throw new Error('reconcile needs an id and, for a physical run, an absolute --hosts file');
      const checkRun = await import('./check-run.ts');
      const reconciled = descriptorFile
        ? await checkRun.reconcileCheckRunPreparationIntent(descriptorFile, hostsFile, stateOptions)
        : await checkRun.reconcileRegisteredCheckRun(id!, hostsFile, stateOptions);
      process.stdout.write(`${JSON.stringify(reconciled)}\n`);
    } else {
      throw new Error(usage());
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n${usage()}\n`);
    process.exitCode = 2;
  }
}
