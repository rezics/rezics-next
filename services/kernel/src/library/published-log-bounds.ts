import { memoizedValue } from '../memoized.ts';
import { BOUND_AXES, declareBound, repeatBound, sumBounds, type Bound } from '@rezics/bounds';
import { COMMAND_STEP_RETRIES } from '../work/retries.ts';
import accountCommandState from '../access/account-command-state.sql';
import accountShare from '../access/account-share.sql';
import fence from '../command/fence.sql';
import noEffectFence from '../command/no-effect-fence.sql';
import receiptRead from '../command/read-receipt.sql';
import timeRead from '../command/time.sql';
import partitionRead from '../partition/read.sql';
import { sessionReadPlan, sessionSourceWork, sessionPartitionWork } from './session-operation-bounds.ts';
import type { PublishedLogDueKey } from './published-log-retention.ts';
import { routeOf } from '../route/route.ts';
import { runLibraryBoundedStep, WORK_STEP_DEADLINE_MS } from './command-support.ts';
import read from './published-log-read.sql';
import lock from './published-log-lock.sql';
import page from './published-log-page.sql';
import due from './published-log-due.sql';
import insert from './published-log-insert.sql';
import remove from './published-log-delete.sql';
import restore from './published-log-restore.sql';
import purge from './published-log-purge.sql';

// These closed leaves execute on the original caller's client. They do not open a
// connection, acquire authority, or replace the enclosing command/source plan.
export type PublishedLogReadPlan = Readonly<{
  kind: 'published-log.read';
  input: Readonly<Parameters<typeof read.run>[1]>;
  total: Bound;
}>;
export type PublishedLogLockPlan = Readonly<{
  kind: 'published-log.lock';
  input: Readonly<Parameters<typeof lock.run>[1]>;
  total: Bound;
}>;
export type PublishedLogPagePlan = Readonly<{
  kind: 'published-log.page';
  input: Readonly<Parameters<typeof page.run>[1]>;
  total: Bound;
}>;
export type PublishedLogDuePlan = Readonly<{
  kind: 'published-log.due';
  input: Readonly<Parameters<typeof due.run>[1]>;
  total: Bound;
}>;
export type PublishedLogInsertPlan = Readonly<{
  kind: 'published-log.insert';
  input: Readonly<Parameters<typeof insert.run>[1]>;
  total: Bound;
}>;
export type PublishedLogDeletePlan = Readonly<{
  kind: 'published-log.delete';
  input: Readonly<Parameters<typeof remove.run>[1]>;
  total: Bound;
}>;
export type PublishedLogRestorePlan = Readonly<{
  kind: 'published-log.restore';
  input: Readonly<Parameters<typeof restore.run>[1]>;
  total: Bound;
}>;
export type PublishedLogPurgePlan = Readonly<{
  kind: 'published-log.purge';
  input: Readonly<Parameters<typeof purge.run>[1]>;
  total: Bound;
}>;

const bytes = (value: number): Bound =>
  declareBound({
    candidateKeys: 0,
    nativeRows: 0,
    identityMetadataRows: 0,
    emptySeeks: 0,
    nativePoints: 0,
    witnessKeys: 0,
    statements: 0,
    bytes: value,
    engineRequests: 0,
  });

// library.published_log schema: UUIDs are 36 ASCII characters, route is uint16,
// revision is a positive int32, state has the three literal values below, note is
// at most 1000 PostgreSQL characters. Six-byte JSON escaping bounds both control
// characters and four-byte supplementary Unicode in the native JSON encoding.
// PostgreSQL timestamp text reserves 64 characters including range/zone/BC suffix.
const uuid = 'f'.repeat(36);
const timestamp = '\u0000'.repeat(64);
const pageProjection = {
  route: 65535,
  id: uuid,
  accountId: uuid,
  sessionId: uuid,
  subjectId: uuid,
  sessionState: 'completed',
  startedAt: timestamp,
  completedAt: timestamp,
  note: '\u0000'.repeat(1000),
  publishedAt: timestamp,
  transactionId: uuid,
  sort_at: timestamp,
};
const readProjection = {
  ...pageProjection,
  revision: 2147483646,
  deleted: false,
  deletionId: uuid,
  deletedAt: timestamp,
  restoreUntil: timestamp,
};
const dueProjection = {
  route: 65535,
  logId: uuid,
  accountId: uuid,
  deletionId: uuid,
  revision: 2147483646,
  restoreUntil: timestamp,
};
// Include null as an alternative to each short scalar: false and the positive
// integers above already dominate null. State, UUID and timestamp strings do too.
const rowBytes = (projection: object) => Buffer.byteLength(JSON.stringify(projection)) + 1;

function leaf(
  sql: string,
  input: object,
  candidates: number,
  rows: number,
  seeks: number,
  projection: object,
  projections: number,
  statements = 1,
): Bound {
  return sumBounds(
    declareBound({
      candidateKeys: candidates,
      nativeRows: rows,
      identityMetadataRows: 0,
      emptySeeks: seeks,
      nativePoints: seeks,
      witnessKeys: 0,
      statements,
      bytes: 0,
      // These closed SQL leaves do not supply Search admission or execution evidence.
      engineRequests: 0,
    }),
    bytes(Buffer.byteLength(sql)),
    bytes(Buffer.byteLength(JSON.stringify(input))),
    repeatBound(bytes(rowBytes(projection)), projections),
    bytes(2),
  );
}

export function publishedLogReadPlan(input: Parameters<typeof read.run>[1]): PublishedLogReadPlan {
  const original = Object.freeze({ ...input });
  return Object.freeze({
    kind: 'published-log.read',
    input: original,
    total: leaf(read.sql, original, 1, 1, 1, readProjection, 1),
  });
}
export function publishedLogLockPlan(input: Parameters<typeof lock.run>[1]): PublishedLogLockPlan {
  const original = Object.freeze({ ...input });
  return Object.freeze({
    kind: 'published-log.lock',
    input: original,
    total: leaf(lock.sql, original, 1, 1, 1, { ...readProjection, expired: false }, 1),
  });
}
export function publishedLogPagePlan(input: Parameters<typeof page.run>[1]): PublishedLogPagePlan {
  const original = Object.freeze({ ...input });
  // The UNION ALL has two independently limited index ranges on next pages.
  // Count discarded candidates before the final sort/LIMIT and both candidate
  // projections plus the final returned projection, including the sentinel.
  const streams = input.has_cursor ? 2 : 1;
  const rows = repeatBound(bytes(1), input.limit).bytes;
  const examined = repeatBound(bytes(rows), streams).bytes;
  return Object.freeze({
    kind: 'published-log.page',
    input: original,
    total: leaf(
      page.sql,
      original,
      rows,
      examined,
      streams,
      pageProjection,
      sumBounds(bytes(examined), bytes(rows)).bytes,
    ),
  });
}
export function publishedLogDuePlan(input: Parameters<typeof due.run>[1]): PublishedLogDuePlan {
  const original = Object.freeze({ ...input });
  // published_log_due is partial on deleted AND restore_until IS NOT NULL.
  // Cutoff and the exact three-column keyset are index ranges, not postfilters.
  return Object.freeze({
    kind: 'published-log.due',
    input: original,
    total: leaf(due.sql, original, input.limit, input.limit, 1, dueProjection, input.limit),
  });
}

// A successful row mutation also fires the Library native-source fence. Insert
// advances one owner fence and one fact-source head. Delete and restore update
// both old/new native-source fence anchors and one visibility head. Exact purge
// advances the retained old-owner fence only; it does not change visibility.
function mutation(
  sql: string,
  input: object,
  projections: number,
  projection: object,
  candidateKeys: number,
  nativeRows: number,
  nativePoints: number,
  triggerStatements: number,
  emptySeeks: number,
): Bound {
  return sumBounds(
    declareBound({
      candidateKeys,
      nativeRows,
      identityMetadataRows: 0,
      emptySeeks,
      nativePoints,
      witnessKeys: 0,
      statements: 1 + triggerStatements,
      bytes: 0,
      engineRequests: 0,
    }),
    bytes(Buffer.byteLength(sql)),
    bytes(Buffer.byteLength(JSON.stringify(input))),
    repeatBound(bytes(rowBytes(projection)), projections),
    bytes(2),
  );
}

export function publishedLogInsertPlan(input: Parameters<typeof insert.run>[1]): PublishedLogInsertPlan {
  const original = Object.freeze({ ...input });
  return Object.freeze({
    kind: 'published-log.insert',
    input: original,
    // Heap plus PK/account-page/owner entries; three trigger upserts include
    // the fact-head writer's own native-source fence trigger.
    total: mutation(insert.sql, original, 1, readProjection, 7, 10, 7, 3, 4),
  });
}
export function publishedLogDeletePlan(input: Parameters<typeof remove.run>[1]): PublishedLogDeletePlan {
  const original = Object.freeze({ ...input });
  return Object.freeze({
    kind: 'published-log.delete',
    input: original,
    // Old/new row versions and index changes plus two direct fence writes, the
    // fact visibility head and its native-source fence trigger.
    total: mutation(remove.sql, original, 1, readProjection, 8, 14, 5, 4, 5),
  });
}
export function publishedLogRestorePlan(input: Parameters<typeof restore.run>[1]): PublishedLogRestorePlan {
  const original = Object.freeze({ ...input });
  return Object.freeze({
    kind: 'published-log.restore',
    input: original,
    total: mutation(restore.sql, original, 1, readProjection, 8, 14, 5, 4, 5),
  });
}
export function publishedLogPurgePlan(input: Parameters<typeof purge.run>[1]): PublishedLogPurgePlan {
  const original = Object.freeze({ ...input });
  return Object.freeze({
    kind: 'published-log.purge',
    input: original,
    // Minimization removes the retained owner index and due entry; only the
    // old owner fence is advanced. The deleted visibility head is unchanged.
    total: mutation(purge.sql, original, 1, { purged: true }, 4, 6, 2, 1, 2),
  });
}

export const executePublishedLogRead = (client: Parameters<typeof read.run>[0], plan: PublishedLogReadPlan) =>
  runLibraryBoundedStep(plan.kind, plan.total, () => read.run(client, plan.input));
export const executePublishedLogLock = (client: Parameters<typeof lock.run>[0], plan: PublishedLogLockPlan) =>
  runLibraryBoundedStep(plan.kind, plan.total, () => lock.run(client, plan.input));
export const executePublishedLogPage = (client: Parameters<typeof page.run>[0], plan: PublishedLogPagePlan) =>
  runLibraryBoundedStep(plan.kind, plan.total, () => page.run(client, plan.input));
export const executePublishedLogDue = (client: Parameters<typeof due.run>[0], plan: PublishedLogDuePlan) =>
  runLibraryBoundedStep(plan.kind, plan.total, () => due.run(client, plan.input));
export const executePublishedLogInsert = (client: Parameters<typeof insert.run>[0], plan: PublishedLogInsertPlan) =>
  runLibraryBoundedStep(plan.kind, plan.total, () => insert.run(client, plan.input));
export const executePublishedLogDelete = (client: Parameters<typeof remove.run>[0], plan: PublishedLogDeletePlan) =>
  runLibraryBoundedStep(plan.kind, plan.total, () => remove.run(client, plan.input));
export const executePublishedLogRestore = (client: Parameters<typeof restore.run>[0], plan: PublishedLogRestorePlan) =>
  runLibraryBoundedStep(plan.kind, plan.total, () => restore.run(client, plan.input));
export const executePublishedLogPurge = (client: Parameters<typeof purge.run>[0], plan: PublishedLogPurgePlan) =>
  runLibraryBoundedStep(plan.kind, plan.total, () => purge.run(client, plan.input));

export type PublishedLogOperationPlan = Readonly<{
  kind: string;
  components: Readonly<Record<string, Bound>>;
  total: Bound;
  controls?: Readonly<Record<string, number | string>>;
}>;

const accountEpoch = '9223372036854775807';
const maximumCursorBytes = 4096;
export const PUBLISHED_LOG_RETENTION_PAGE_BOUND = 100;
export const PUBLISHED_LOG_RETENTION_SEGMENT_BOUND = 100;
function zero() {
  return memoizedValue(zero, () =>
    declareBound({
      candidateKeys: 0,
      nativeRows: 0,
      identityMetadataRows: 0,
      emptySeeks: 0,
      nativePoints: 0,
      witnessKeys: 0,
      statements: 0,
      bytes: 0,
      engineRequests: 0,
    }),
  );
}
const byteBound = (value: number): Bound => declareBound({ ...zero(), bytes: value });
const jsonBytes = (value: unknown) => byteBound(Buffer.byteLength(JSON.stringify(value) ?? 'null'));
const sqlOnly = (sql: string, input: object = {}) => leaf(sql, input, 0, 0, 0, {}, 0);
function alternative(...branches: readonly Bound[]): Bound {
  const values = branches.length ? branches : [zero()];
  return declareBound(
    Object.fromEntries(BOUND_AXES.map((axis) => [axis, Math.max(...values.map((value) => value[axis]))])),
  );
}
function operationPlan(
  kind: string,
  components: Record<string, Bound>,
  controls?: Record<string, number | string>,
): PublishedLogOperationPlan {
  const retained = Object.freeze({ ...components });
  return Object.freeze({
    kind,
    components: retained,
    total: sumBounds(...Object.values(retained)),
    ...(controls === undefined ? {} : { controls: Object.freeze({ ...controls }) }),
  });
}

const publicLog = {
  id: uuid,
  accountId: uuid,
  subjectId: uuid,
  sessionState: 'abandoned',
  startedAt: timestamp,
  completedAt: timestamp,
  note: '\0'.repeat(1000),
  publishedAt: timestamp,
};
const publicLogReceipt = {
  publishedLog: publicLog,
  revision: 2_147_483_646,
  deletionId: uuid,
};
const partitionRow = {
  partitionNo: 4095,
  node: '\0'.repeat(256),
  writeState: 'active',
  movedTo: '\0'.repeat(256),
  epoch: 2_147_483_647,
  position: '9223372036854775807',
};
const accountStateRow = {
  kind: 'organization',
  state: 'deleted',
  fenced: true,
  minimumAuthnEpoch: accountEpoch,
};
const fenceRow = { epoch: 2_147_483_647, position: '9223372036854775807' };
const receiptKey = `rk1.255.${'f'.repeat(43)}`;

function readPartitionBound(partitionNo: number): Bound {
  return leaf(partitionRead.sql, { partition_no: partitionNo }, 1, 1, 1, partitionRow, 1);
}
function readAccountStateBound(route: number, accountId: string): Bound {
  return leaf(accountCommandState.sql, { route, account_id: accountId }, 1, 1, 1, accountStateRow, 1);
}
function accountShareBound(route: number, accountId: string): Bound {
  return leaf(accountShare.sql, { route, account_id: accountId }, 1, 1, 1, { state: 'deleted', fenced: true }, 1);
}
function timeReadBound(): Bound {
  return leaf(timeRead.sql, { at: timestamp }, 0, 1, 1, { value: timestamp }, 1);
}
function readTransactionBound(isolation: 'REPEATABLE READ' | 'READ COMMITTED', statementTimeoutMs?: number): Bound {
  return sumBounds(
    sqlOnly(`BEGIN ISOLATION LEVEL ${isolation} READ ONLY`),
    ...(statementTimeoutMs === undefined ? [] : [sqlOnly(`SET LOCAL statement_timeout = '${statementTimeoutMs}ms'`)]),
    alternative(sqlOnly('COMMIT'), sqlOnly('ROLLBACK')),
  );
}

function commandControls(prepared: boolean, durationMs: number): Bound {
  const timeoutMs = Math.max(1, Math.floor(durationMs));
  const transaction = sumBounds(
    sqlOnly('BEGIN ISOLATION LEVEL SERIALIZABLE'),
    sqlOnly("SET LOCAL lock_timeout = '200ms'"),
    sqlOnly(`SET LOCAL statement_timeout = '${timeoutMs}ms'`),
    sqlOnly(`SET LOCAL statement_timeout = '${timeoutMs}ms'`),
    alternative(sqlOnly('COMMIT'), sqlOnly('ROLLBACK')),
    ...(prepared ? [] : [timeReadBound()]),
  );
  return sumBounds(
    transaction,
    ...(prepared ? [sumBounds(readTransactionBound('READ COMMITTED', Math.min(200, timeoutMs)), timeReadBound())] : []),
  );
}

function commandReceiptReadBound(
  accountId: string,
  commandKind: string,
  receiptKeyCount: number,
  response: unknown,
): Bound {
  const responseShape = response ?? publicLogReceipt;
  const idempotencyKeys = Array(receiptKeyCount - 1)
    .fill(receiptKey)
    .concat('界'.repeat(255));
  return leaf(
    receiptRead.sql,
    {
      partition_no: 4095,
      principal_kind: 'account',
      principal_id: accountId,
      command_kind: commandKind,
      idempotency_keys: idempotencyKeys,
    },
    receiptKeyCount,
    receiptKeyCount,
    receiptKeyCount,
    {
      requestDigest: 'f'.repeat(64),
      epoch: 2_147_483_647,
      position: '9223372036854775807',
      transactionId: uuid,
      response: responseShape,
      payloadState: 'retained',
    },
    receiptKeyCount,
  );
}

function eventFenceBound(input: {
  accountId: string;
  commandKind: string;
  response: unknown;
  eventType: string;
  logId?: string;
  withBasis: boolean;
}): Bound {
  const receipt = {
    principal: { kind: 'account', id: input.accountId },
    kind: input.commandKind,
    key: receiptKey,
    digest: 'f'.repeat(44),
    response: input.response,
  };
  const basis = input.withBasis
    ? { principal: { kind: 'account', id: input.accountId }, clientId: uuid, requestedBy: uuid }
    : null;
  const outboxAndFence = input.withBasis
    ? { candidateKeys: 18, nativeRows: 12, seeks: 12 }
    : {
        candidateKeys: 14,
        nativeRows: 9,
        seeks: 9,
      };
  return leaf(
    fence.sql,
    {
      partition_no: 4095,
      transaction_id: uuid,
      receipt,
      basis,
      events: [
        {
          type: input.eventType,
          subject: input.accountId,
          data: { logId: input.logId ?? uuid },
          id: uuid,
        },
      ],
    },
    outboxAndFence.candidateKeys,
    outboxAndFence.nativeRows,
    outboxAndFence.seeks,
    fenceRow,
    1,
  );
}

function noEffectFenceBound(accountId: string, commandKind: string, response: unknown): Bound {
  const receipt = {
    principal: { kind: 'account', id: accountId },
    kind: commandKind,
    key: receiptKey,
    digest: 'f'.repeat(44),
    response,
  };
  return leaf(noEffectFence.sql, { partition_no: 4095, transaction_id: uuid, receipt }, 5, 5, 4, fenceRow, 1);
}

function writableRecoveryBound(partitionNo: number, durationMs: number): Bound {
  return sumBounds(
    readTransactionBound('READ COMMITTED', Math.min(200, Math.max(1, Math.floor(durationMs)))),
    readPartitionBound(partitionNo),
  );
}

function ownAccountCommandPlan(input: {
  kind: string;
  commandKind: string;
  accountId: string;
  requestInput: unknown;
  receiptKeyCount: number;
  prepared: Bound;
  body: Bound;
  response: unknown;
  eventType: string;
  logId?: string;
  hasAccountAuthorization: boolean;
  durationMs?: number;
}): PublishedLogOperationPlan {
  const durationMs = input.durationMs ?? WORK_STEP_DEADLINE_MS;
  const attempts = 1 + Math.ceil(durationMs / 25);
  const route = routeOf(input.accountId)!;
  const commandInputBytes = jsonBytes({
    identity: { principal: { kind: 'account', id: input.accountId }, basis: { clientId: uuid, requestedBy: uuid } },
    kind: input.commandKind,
    input: input.requestInput,
  });
  const accountAuthorization = input.hasAccountAuthorization
    ? sumBounds(accountShareBound(route, input.accountId), readAccountStateBound(route, input.accountId))
    : zero();
  const eventAndReceipt = eventFenceBound({
    accountId: input.accountId,
    commandKind: input.commandKind,
    response: input.response,
    eventType: input.eventType,
    ...(input.logId === undefined ? {} : { logId: input.logId }),
    withBasis: true,
  });
  const commonAttempt = sumBounds(
    commandControls(input.prepared !== zero(), durationMs),
    accountAuthorization,
    commandReceiptReadBound(input.accountId, input.commandKind, input.receiptKeyCount, input.response),
    input.prepared,
    commandInputBytes,
  );
  // Current authorization and the complete original preparation precede receipt
  // lookup. Only a fresh receipt runs the body, fence/outbox and response path.
  const perAttempt = sumBounds(
    commonAttempt,
    alternative(zero(), sumBounds(input.body, eventAndReceipt, jsonBytes(input.response))),
  );
  const partitionNo = Math.floor(route / 16);
  const recovery = repeatBound(writableRecoveryBound(partitionNo, durationMs), Math.ceil(durationMs / 25));
  return operationPlan(
    input.kind,
    {
      commandAttempts: repeatBound(perAttempt, attempts),
      writableRecovery: recovery,
    },
    {
      commandAttempts: attempts,
      retryQuantumMs: 25,
      durationMs,
      receiptKeyCount: input.receiptKeyCount,
      rawRequestKeyBytes: 765,
    },
  );
}

export function publishedLogPublishOperationPlan(input: {
  accountId: string;
  sessionId: string;
  note: string | null;
  requestKey: string;
  receiptKeyCount: number;
}): PublishedLogOperationPlan {
  const route = routeOf(input.accountId)!;
  const sessionRead = sessionReadPlan({ route, session_id: input.sessionId }).total;
  return ownAccountCommandPlan({
    kind: 'published-log.publish',
    commandKind: 'published_log.create',
    accountId: input.accountId,
    requestInput: { sessionId: input.sessionId, note: input.note },
    receiptKeyCount: input.receiptKeyCount,
    prepared: sumBounds(sessionRead, sessionSourceWork(uuid, false)),
    body: sumBounds(
      sessionRead,
      publishedLogInsertPlan({
        route,
        log_id: uuid,
        account_id: input.accountId,
        session_id: input.sessionId,
        subject_id: uuid,
        session_state: 'abandoned',
        started_at: timestamp,
        completed_at: timestamp,
        note: input.note ?? '\0'.repeat(1000),
        published_at: timestamp,
        transaction_id: uuid,
      }).total,
    ),
    response: { publishedLog: publicLog, revision: 2_147_483_646 },
    eventType: 'com.rezics.library.published_log.updated.v1',
    hasAccountAuthorization: true,
  });
}

export function publishedLogRetractOperationPlan(input: {
  accountId: string;
  logId: string;
  requestKey: string;
  revision?: number;
  receiptKeyCount: number;
}): PublishedLogOperationPlan {
  const route = routeOf(input.accountId)!;
  const lockBound = publishedLogLockPlan({ route, account_id: input.accountId, log_id: input.logId, time: timestamp });
  const removeBound = publishedLogDeletePlan({
    route,
    account_id: input.accountId,
    log_id: input.logId,
    revision: input.revision ?? 2_147_483_646,
    deletion_id: uuid,
    time: timestamp,
    transaction_id: uuid,
  });
  return ownAccountCommandPlan({
    kind: 'published-log.retract',
    commandKind: 'published_log.delete',
    accountId: input.accountId,
    requestInput:
      input.revision === undefined ? { logId: input.logId } : { logId: input.logId, revision: input.revision },
    receiptKeyCount: input.receiptKeyCount,
    prepared: zero(),
    body: sumBounds(lockBound.total, removeBound.total),
    response: publicLogReceipt,
    eventType: 'com.rezics.library.published_log.deleted.v1',
    logId: input.logId,
    hasAccountAuthorization: true,
  });
}

export function publishedLogRestoreOperationPlan(input: {
  accountId: string;
  logId: string;
  deletionId: string;
  revision: number;
  requestKey: string;
  receiptKeyCount: number;
}): PublishedLogOperationPlan {
  const route = Number.parseInt(input.accountId.slice(24, 28), 16);
  const preparedRow = publishedLogReadPlan({ route, log_id: input.logId }).total;
  const lockBound = publishedLogLockPlan({ route, account_id: input.accountId, log_id: input.logId, time: timestamp });
  const restoreBound = publishedLogRestorePlan({
    route,
    account_id: input.accountId,
    log_id: input.logId,
    revision: input.revision,
    deletion_id: input.deletionId,
    time: timestamp,
    transaction_id: uuid,
  });
  return ownAccountCommandPlan({
    kind: 'published-log.restore',
    commandKind: 'published_log.restore',
    accountId: input.accountId,
    requestInput: { logId: input.logId, deletionId: input.deletionId, revision: input.revision },
    receiptKeyCount: input.receiptKeyCount,
    prepared: sumBounds(preparedRow, sessionSourceWork(uuid, false)),
    body: sumBounds(lockBound.total, restoreBound.total),
    response: { publishedLog: publicLog, revision: 2_147_483_646 },
    eventType: 'com.rezics.library.published_log.updated.v1',
    logId: input.logId,
    hasAccountAuthorization: true,
  });
}

export function publishedLogPointReadOperationPlan(input: { route: number; logId: string }): PublishedLogOperationPlan {
  const logRead = publishedLogReadPlan({ route: input.route, log_id: input.logId }).total;
  const ownerState = readAccountStateBound(input.route, uuid);
  const publicOutput = jsonBytes({ publishedLog: publicLog, revision: 2_147_483_646 });
  const tombstoneOutput = jsonBytes({ publishedLog: { id: uuid, deleted: true } });
  return operationPlan('published-log.point-read', {
    readTransaction: readTransactionBound('REPEATABLE READ'),
    logPoint: logRead,
    liveOwnerDisclosureAndResponse: alternative(
      tombstoneOutput,
      sumBounds(ownerState, sessionSourceWork(uuid, false), publicOutput),
    ),
  });
}

export function publishedLogPageReadOperationPlan(input: {
  route: number;
  accountId: string;
  limit: number;
  hasCursor: boolean;
}): PublishedLogOperationPlan {
  const rawLimit = input.limit + 1;
  const pageBound = publishedLogPagePlan({
    route: input.route,
    account_id: input.accountId,
    after_published_at: timestamp,
    after_log_id: uuid,
    has_cursor: input.hasCursor,
    limit: rawLimit,
  });
  const serialized = jsonBytes({
    publishedLogs: Array.from({ length: input.limit }, () => publicLog),
    next: 'x'.repeat(maximumCursorBytes),
  });
  return operationPlan(
    'published-log.page-read',
    {
      readTransaction: readTransactionBound('REPEATABLE READ'),
      partitionEpoch: sessionPartitionWork(Math.floor(input.route / 16)),
      ownerStateAndFloor: readAccountStateBound(input.route, input.accountId),
      firstAndNextPageStreams: alternative(zero(), pageBound.total),
      originalAndTerminalDisclosure: repeatBound(sessionSourceWork(uuid, false), input.limit),
      signedCursorInput: byteBound(input.hasCursor ? maximumCursorBytes : 0),
      serializedResponse: serialized,
    },
    { rawLimit, disclosureMaximum: input.limit, pageSentinel: 1 },
  );
}

export function publishedLogRetentionPurgeOperationPlan(
  key: PublishedLogDueKey,
  receiptKeyCount: number,
  durationMs = WORK_STEP_DEADLINE_MS,
): PublishedLogOperationPlan {
  const lockBound = publishedLogLockPlan({
    route: key.route,
    account_id: key.accountId,
    log_id: key.logId,
    time: timestamp,
  });
  const purgeBound = publishedLogPurgePlan({
    route: key.route,
    log_id: key.logId,
    deletion_id: key.deletionId,
    revision: key.revision,
    restore_until: key.restoreUntil,
    time: timestamp,
  });
  const response = { purged: true };
  const event = eventFenceBound({
    accountId: key.accountId,
    commandKind: 'library.published-log.retention.purge',
    response,
    eventType: 'com.rezics.library.published_log.purged.v1',
    logId: key.logId,
    withBasis: false,
  });
  const noEffect = noEffectFenceBound(key.accountId, 'library.published-log.retention.purge', { purged: false });
  const route = key.route;
  const commandKind = 'library.published-log.retention.purge';
  const receiptInput = { kind: commandKind, key };
  const freshBranch = sumBounds(purgeBound.total, event, jsonBytes({ purged: true }));
  const noEffectBranch = sumBounds(noEffect, jsonBytes({ purged: false }));
  const oneAttempt = sumBounds(
    commandControls(false, durationMs),
    commandReceiptReadBound(key.accountId, commandKind, receiptKeyCount, { purged: true }),
    lockBound.total,
    jsonBytes(receiptInput),
    alternative(freshBranch, noEffectBranch),
  );
  const attempts = 1 + Math.ceil(durationMs / 25);
  return operationPlan(
    'published-log.retention.purge',
    {
      exactCommandAttempts: repeatBound(oneAttempt, attempts),
      writableRecovery: repeatBound(
        writableRecoveryBound(Math.floor(route / 16), durationMs),
        Math.ceil(durationMs / 25),
      ),
    },
    {
      commandAttempts: attempts,
      deadlineMs: durationMs,
      receiptKeyCount,
      rawRequestKeyBytes: 765,
      noEffectAndPurgeBranches: 2,
      exactDeletionLocator: JSON.stringify({
        deletionId: key.deletionId,
        revision: key.revision,
        restoreUntil: key.restoreUntil,
      }),
    },
  );
}

export function publishedLogRetentionPageOperationPlan(input: {
  cutoff: string;
  cursor: { partition: number; after?: PublishedLogDueKey };
  receiptKeyCount: number;
  durationMs: number;
}): PublishedLogOperationPlan {
  const locator: PublishedLogDueKey = {
    route: 65535,
    logId: uuid,
    accountId: uuid,
    deletionId: uuid,
    revision: 2_147_483_646,
    restoreUntil: timestamp,
  };
  const partition = readPartitionBound(4095);
  const due = publishedLogDuePlan({
    partition_no: 4095,
    cutoff: timestamp,
    after_time: timestamp,
    after_route: 4095,
    after_id: uuid,
    limit: 1,
  }).total;
  const maximumCursor = { partition: 4095, after: locator };
  const pageTransactions = sumBounds(
    sqlOnly('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'),
    sqlOnly(`SET LOCAL statement_timeout = '${Math.max(1, Math.floor(input.durationMs))}ms'`),
    alternative(sqlOnly('COMMIT'), sqlOnly('ROLLBACK')),
  );
  const pageStep = sumBounds(
    repeatBound(pageTransactions, PUBLISHED_LOG_RETENTION_PAGE_BOUND),
    repeatBound(partition, PUBLISHED_LOG_RETENTION_PAGE_BOUND),
    repeatBound(due, PUBLISHED_LOG_RETENTION_PAGE_BOUND),
    repeatBound(
      publishedLogRetentionPurgeOperationPlan(locator, input.receiptKeyCount, input.durationMs).total,
      PUBLISHED_LOG_RETENTION_PAGE_BOUND,
    ),
    jsonBytes({ cutoff: input.cutoff, cursor: maximumCursor }),
    jsonBytes({
      cursor: { partition: 4095, after: locator },
      examined: PUBLISHED_LOG_RETENTION_PAGE_BOUND,
      purged: PUBLISHED_LOG_RETENTION_PAGE_BOUND,
      pending: PUBLISHED_LOG_RETENTION_PAGE_BOUND,
      probes: PUBLISHED_LOG_RETENTION_PAGE_BOUND,
    }),
  );
  return operationPlan(
    'published-log.retention.page',
    { durableStepAttempts: repeatBound(pageStep, COMMAND_STEP_RETRIES.maxAttempts) },
    {
      pageBound: PUBLISHED_LOG_RETENTION_PAGE_BOUND,
      stepAttempts: COMMAND_STEP_RETRIES.maxAttempts,
      dueKeysIncludingNegativeAndEof: PUBLISHED_LOG_RETENTION_PAGE_BOUND,
      partitionProbes: PUBLISHED_LOG_RETENTION_PAGE_BOUND,
      exactCommandsPerPage: PUBLISHED_LOG_RETENTION_PAGE_BOUND,
      receiptKeyCount: input.receiptKeyCount,
      rawRequestKeyBytes: 765,
      deadlineMs: input.durationMs,
      cutoff: input.cutoff,
      cursor: JSON.stringify(input.cursor),
    },
  );
}

export function publishedLogRetentionSegmentOperationPlan(input: {
  root: string;
  sequence: number;
  cutoff: string;
  cursor: { partition: number; after?: PublishedLogDueKey };
  receiptKeyCount: number;
  durationMs: number;
}): PublishedLogOperationPlan {
  const page = publishedLogRetentionPageOperationPlan(input);
  const next = {
    root: input.root,
    sequence: input.sequence + 1,
    cutoff: input.cutoff,
    cursor: {
      partition: 4095,
      after: {
        route: 65535,
        logId: uuid,
        accountId: uuid,
        deletionId: uuid,
        revision: 2_147_483_646,
        restoreUntil: timestamp,
      },
    },
  };
  const continuation = sumBounds(
    jsonBytes({
      workflowName: 'library.publishedLogRetentionSegment',
      queueName: 'maintenance',
      workflowID: `library.publishedLogRetention:${input.root}:${input.sequence + 1}`,
      workflowIDReusePolicy: 'return-existing',
      input: next,
    }),
    declareBound({ ...zero(), engineRequests: 1 }),
  );
  return operationPlan(
    'published-log.retention.segment',
    {
      durablePages: repeatBound(page.total, PUBLISHED_LOG_RETENTION_SEGMENT_BOUND),
      returnExistingContinuation: repeatBound(continuation, COMMAND_STEP_RETRIES.maxAttempts),
      segmentInput: jsonBytes({
        root: input.root,
        sequence: input.sequence,
        cutoff: input.cutoff,
        cursor: input.cursor,
      }),
    },
    {
      segmentBound: PUBLISHED_LOG_RETENTION_SEGMENT_BOUND,
      durablePages: PUBLISHED_LOG_RETENTION_SEGMENT_BOUND,
      pageStepAttempts: COMMAND_STEP_RETRIES.maxAttempts,
      continuationAttempts: COMMAND_STEP_RETRIES.maxAttempts,
      receiptKeyCount: input.receiptKeyCount,
      rawRequestKeyBytes: 765,
      continuationPolicy: 'return-existing',
      root: input.root,
      sequence: input.sequence,
      cutoff: input.cutoff,
      cursor: JSON.stringify(input.cursor),
      continuationCursor: JSON.stringify(next.cursor),
      deadlineMs: input.durationMs,
    },
  );
}
