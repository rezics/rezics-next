import { declareBound, sumBounds, type Bound } from '@rezics/bounds';
import type { Pool } from 'pg';
import { isAccessWorkDispatch } from '../access/work.ts';
import {
  currentCommandWorkAssociation,
  currentLibraryOperationAccounting,
  withNativeCommandAccounting,
} from '../command/work-context.ts';
import type { AccessContext } from '../request/access.ts';
import type { WorkDimensions } from './contract/work-dimensions.ts';
import {
  publishedLogDeletePlan,
  publishedLogDuePlan,
  publishedLogFullDisclosureWork,
  publishedLogInsertPlan,
  publishedLogLockPlan,
  publishedLogPagePlan,
  publishedLogPageReadOperationPlan,
  publishedLogPointReadOperationPlan,
  publishedLogPublicAccountWork,
  publishedLogPublishOperationPlan,
  publishedLogPurgePlan,
  publishedLogReadPlan,
  publishedLogRemainingMs,
  publishedLogRestoreOperationPlan,
  publishedLogRestorePlan,
  publishedLogRetractOperationPlan,
  publishedLogSourceGateWork,
} from './published-log-bounds.ts';
import { sessionReadPlan } from './session-operation-bounds.ts';
import { WORK_STEP_DEADLINE_MS } from './work-step-deadline.ts';
import accountCommandState from '../access/account-command-state.sql';
import accountShare from '../access/account-share.sql';
import publicAccountRead from '../access/account-public-read.sql';
import fence from '../command/fence.sql';
import noEffectFence from '../command/no-effect-fence.sql';
import receiptRead from '../command/read-receipt.sql';
import timeRead from '../command/time.sql';
import partitionRead from '../partition/read.sql';
import read from './published-log-read.sql';
import lock from './published-log-lock.sql';
import page from './published-log-page.sql';
import due from './published-log-due.sql';
import insert from './published-log-insert.sql';
import remove from './published-log-delete.sql';
import restore from './published-log-restore.sql';
import purge from './published-log-purge.sql';
import sessionRead from './progress-store-session-read.sql';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CEILING_SUBJECT = 'ffffffff-ffff-8fff-bfff-ffffffffffff';

const SQL_ZERO = Object.freeze({ witnessKeys: 0, engineRequests: 0 });

function zero(): Bound {
  return declareBound({
    candidateKeys: 0,
    nativeRows: 0,
    identityMetadataRows: 0,
    emptySeeks: 0,
    nativePoints: 0,
    witnessKeys: 0,
    statements: 0,
    bytes: 0,
    engineRequests: 0,
  });
}

function sqlAxes(bound: Bound): Bound {
  return declareBound({ ...bound, ...SQL_ZERO });
}

function bytesOf(sql: string, operands: readonly unknown[]): Bound {
  return declareBound({
    ...zero(),
    statements: 1,
    bytes: Buffer.byteLength(sql) + Buffer.byteLength(JSON.stringify(operands)) + 2,
  });
}

function controlStatement(sql: string, operands: readonly unknown[]): Bound | undefined {
  if (
    sql === 'COMMIT' ||
    sql === 'ROLLBACK' ||
    sql === 'BEGIN ISOLATION LEVEL SERIALIZABLE' ||
    sql === 'BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY' ||
    sql === 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' ||
    sql === "SET LOCAL lock_timeout = '200ms'" ||
    /^SET LOCAL statement_timeout = '\d+ms'$/.test(sql)
  )
    return sqlAxes(bytesOf(sql, operands));
}

function inputOf(query: { params: readonly string[] }, operands: readonly unknown[]): Record<string, unknown> {
  return Object.fromEntries(query.params.map((name, index) => [name, operands[index]]));
}

function uuidIn(value: unknown): string | undefined {
  if (typeof value === 'string' && UUID.test(value)) return value;
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = uuidIn(entry);
      if (found) return found;
    }
  }
  if (value && typeof value === 'object') {
    for (const entry of Object.values(value as Record<string, unknown>)) {
      const found = uuidIn(entry);
      if (found) return found;
    }
  }
}

function subjectFrom(operands: readonly unknown[]): string {
  for (const value of operands) {
    const found = uuidIn(value);
    if (found) return found;
  }
  return CEILING_SUBJECT;
}

/** Eight-axis native port; SQL leaves keep engine and witness at zero. */
export function publishedLogNativeWork(total: Bound): Readonly<{ dimensions: WorkDimensions; engineRequests: number }> {
  const pinned = sqlAxes(total);
  return Object.freeze({
    dimensions: Object.freeze({
      candidateKeys: pinned.candidateKeys,
      nativeRows: pinned.nativeRows,
      identityMetadataRows: pinned.identityMetadataRows,
      emptySeeks: pinned.emptySeeks,
      nativePoints: pinned.nativePoints,
      witnessKeys: pinned.witnessKeys,
      statements: pinned.statements,
      bytes: pinned.bytes,
    }),
    engineRequests: pinned.engineRequests,
  });
}

/** Envelope already reserved the complete operation; nested leaves do not consume again. */
export function consumePublishedLogWork<T>(kind: string, total: Bound, dispatch: () => Promise<T>): Promise<T> {
  if (currentLibraryOperationAccounting()) return dispatch();
  const association = currentCommandWorkAssociation();
  const native = publishedLogNativeWork(total);
  return association ? association.run(`library.published-log.${kind}`, native.dimensions, dispatch) : dispatch();
}

export const executePublishedLogRead = (
  client: Parameters<typeof read.run>[0],
  plan: ReturnType<typeof publishedLogReadPlan>,
) => consumePublishedLogWork(plan.kind, plan.total, () => read.run(client, plan.input));
export const executePublishedLogLock = (
  client: Parameters<typeof lock.run>[0],
  plan: ReturnType<typeof publishedLogLockPlan>,
) => consumePublishedLogWork(plan.kind, plan.total, () => lock.run(client, plan.input));
export const executePublishedLogPage = (
  client: Parameters<typeof page.run>[0],
  plan: ReturnType<typeof publishedLogPagePlan>,
) => consumePublishedLogWork(plan.kind, plan.total, () => page.run(client, plan.input));
export const executePublishedLogDue = (
  client: Parameters<typeof due.run>[0],
  plan: ReturnType<typeof publishedLogDuePlan>,
) => consumePublishedLogWork(plan.kind, plan.total, () => due.run(client, plan.input));
export const executePublishedLogInsert = (
  client: Parameters<typeof insert.run>[0],
  plan: ReturnType<typeof publishedLogInsertPlan>,
) => consumePublishedLogWork(plan.kind, plan.total, () => insert.run(client, plan.input));
export const executePublishedLogDelete = (
  client: Parameters<typeof remove.run>[0],
  plan: ReturnType<typeof publishedLogDeletePlan>,
) => consumePublishedLogWork(plan.kind, plan.total, () => remove.run(client, plan.input));
export const executePublishedLogRestore = (
  client: Parameters<typeof restore.run>[0],
  plan: ReturnType<typeof publishedLogRestorePlan>,
) => consumePublishedLogWork(plan.kind, plan.total, () => restore.run(client, plan.input));
export const executePublishedLogPurge = (
  client: Parameters<typeof purge.run>[0],
  plan: ReturnType<typeof publishedLogPurgePlan>,
) => consumePublishedLogWork(plan.kind, plan.total, () => purge.run(client, plan.input));

/** Original absolute deadline plus the existing Access ledger. Remaining ms size retries, not this cutoff. */
export function publishedLogAccessContext(pool: Pool, deadline: number): AccessContext {
  const association = currentCommandWorkAssociation();
  return {
    pool,
    deadline,
    ...(association ? { work: association.access } : {}),
  };
}

export function publishedLogRetrySlots(deadline: number): Readonly<{ remainingMs: number; attempts: number }> {
  const remainingMs = publishedLogRemainingMs(deadline);
  return Object.freeze({ remainingMs, attempts: 1 + Math.ceil(remainingMs / 25) });
}

/** Empty nested Source/Semantic path: every axis including engine/witness stays zero. */
export function publishedLogZeroOperand(): Bound {
  return sqlAxes(zero());
}

export function publishedLogNestedSourceUnits(subjectIds: readonly string[]): Bound {
  if (subjectIds.length === 0) return publishedLogZeroOperand();
  return sqlAxes(sumBounds(...subjectIds.map((subjectId) => publishedLogSourceGateWork(subjectId))));
}

export function publishedLogNestedDisclosureUnits(subjectIds: readonly string[], accountId: string): Bound {
  if (subjectIds.length === 0) return publishedLogZeroOperand();
  return sqlAxes(sumBounds(...subjectIds.map((subjectId) => publishedLogFullDisclosureWork(subjectId, accountId))));
}

export type PublishedLogNestedUnits = Readonly<{
  kind: string;
  originalDeadline: number;
  remainingMs: number;
  retryAttempts: number;
  abortedAttempts: Bound;
  successfulAttempt: Bound;
  nestedSource: Bound;
  nestedDisclosure: Bound;
  zeroSqlAxes: Readonly<{ witnessKeys: 0; engineRequests: 0 }>;
  total: Bound;
}>;

/** Finite nested execution/read units from reached producers, including aborted retries. */
export function publishedLogReachedNestedUnits(input: {
  kind:
    | 'published-log.publish'
    | 'published-log.retract'
    | 'published-log.restore'
    | 'published-log.point-read'
    | 'published-log.page-read';
  accountId: string;
  deadline: number;
  subjectIds?: readonly string[];
  sessionId?: string;
  logId?: string;
  note?: string | null;
  requestKey?: string;
  receiptKeyCount?: number;
  deletionId?: string;
  revision?: number;
  route?: number;
  limit?: number;
  hasCursor?: boolean;
}): PublishedLogNestedUnits {
  const remainingMs = publishedLogRemainingMs(input.deadline);
  const subjects = input.subjectIds ?? [];
  const nestedSource = publishedLogNestedSourceUnits(subjects);
  const nestedDisclosure = publishedLogNestedDisclosureUnits(subjects, input.accountId);
  const receiptKeyCount = input.receiptKeyCount ?? 1;
  const requestKey = input.requestKey ?? input.kind;
  const durationMs = remainingMs;
  const empty = publishedLogZeroOperand();
  let total = empty;
  let aborted = empty;
  if (input.kind === 'published-log.publish' && input.sessionId) {
    const plan = publishedLogPublishOperationPlan({
      accountId: input.accountId,
      sessionId: input.sessionId,
      note: input.note ?? null,
      requestKey,
      receiptKeyCount,
      ...(subjects[0] === undefined ? {} : { subjectId: subjects[0] }),
      durationMs,
    });
    total = plan.total;
    aborted = plan.components.abortedOrSuccessfulAttempts ?? empty;
  } else if (input.kind === 'published-log.retract' && input.logId) {
    const plan = publishedLogRetractOperationPlan({
      accountId: input.accountId,
      logId: input.logId,
      requestKey,
      receiptKeyCount,
      ...(input.revision === undefined ? {} : { revision: input.revision }),
      durationMs,
    });
    total = plan.total;
    aborted = plan.components.abortedOrSuccessfulAttempts ?? empty;
  } else if (
    input.kind === 'published-log.restore' &&
    input.logId &&
    input.deletionId &&
    input.revision !== undefined
  ) {
    const plan = publishedLogRestoreOperationPlan({
      accountId: input.accountId,
      logId: input.logId,
      deletionId: input.deletionId,
      revision: input.revision,
      requestKey,
      receiptKeyCount,
      ...(subjects[0] === undefined ? {} : { subjectId: subjects[0] }),
      durationMs,
    });
    total = plan.total;
    aborted = plan.components.abortedOrSuccessfulAttempts ?? empty;
  } else if (input.kind === 'published-log.point-read' && input.logId && input.route !== undefined) {
    total = publishedLogPointReadOperationPlan({
      route: input.route,
      logId: input.logId,
      accountId: input.accountId,
      ...(subjects[0] === undefined ? {} : { subjectId: subjects[0] }),
    }).total;
    aborted = empty;
  } else if (input.kind === 'published-log.page-read' && input.route !== undefined && input.limit !== undefined) {
    total = publishedLogPageReadOperationPlan({
      route: input.route,
      accountId: input.accountId,
      limit: input.limit,
      hasCursor: input.hasCursor === true,
    }).total;
    aborted = empty;
  }
  return Object.freeze({
    kind: input.kind,
    originalDeadline: input.deadline,
    remainingMs,
    retryAttempts: 1 + Math.ceil(remainingMs / 25),
    abortedAttempts: sqlAxes(aborted),
    successfulAttempt: sqlAxes(total),
    nestedSource,
    nestedDisclosure,
    zeroSqlAxes: SQL_ZERO,
    total: sqlAxes(total),
  });
}

function logLeaf(sql: string, operands: readonly unknown[]): Bound | undefined {
  try {
    if (sql === read.sql)
      return publishedLogReadPlan(inputOf(read, operands) as Parameters<typeof publishedLogReadPlan>[0]).total;
    if (sql === lock.sql)
      return publishedLogLockPlan(inputOf(lock, operands) as Parameters<typeof publishedLogLockPlan>[0]).total;
    if (sql === page.sql)
      return publishedLogPagePlan(inputOf(page, operands) as Parameters<typeof publishedLogPagePlan>[0]).total;
    if (sql === due.sql)
      return publishedLogDuePlan(inputOf(due, operands) as Parameters<typeof publishedLogDuePlan>[0]).total;
    if (sql === insert.sql)
      return publishedLogInsertPlan(inputOf(insert, operands) as Parameters<typeof publishedLogInsertPlan>[0]).total;
    if (sql === remove.sql)
      return publishedLogDeletePlan(inputOf(remove, operands) as Parameters<typeof publishedLogDeletePlan>[0]).total;
    if (sql === restore.sql)
      return publishedLogRestorePlan(inputOf(restore, operands) as Parameters<typeof publishedLogRestorePlan>[0]).total;
    if (sql === purge.sql)
      return publishedLogPurgePlan(inputOf(purge, operands) as Parameters<typeof publishedLogPurgePlan>[0]).total;
  } catch {
    return sqlAxes(bytesOf(sql, operands));
  }
}

function sessionLeaf(sql: string, operands: readonly unknown[]): Bound | undefined {
  if (sql !== sessionRead.sql) return;
  try {
    return sessionReadPlan(inputOf(sessionRead, operands) as Parameters<typeof sessionReadPlan>[0]).total;
  } catch {
    return sqlAxes(bytesOf(sql, operands));
  }
}

function disclosureLeaf(sql: string, operands: readonly unknown[]): Bound | undefined {
  if (sql === publicAccountRead.sql) return publishedLogPublicAccountWork(subjectFrom(operands));
}

function platformLeaf(sql: string, operands: readonly unknown[]): Bound | undefined {
  if (
    sql === partitionRead.sql ||
    sql === accountCommandState.sql ||
    sql === accountShare.sql ||
    sql === timeRead.sql ||
    sql === receiptRead.sql ||
    sql === fence.sql ||
    sql === noEffectFence.sql
  )
    return sqlAxes(bytesOf(sql, operands));
}

/** Closed catalog of reached native SQL, including aborted control statements. */
export function publishedLogStatement(sql: string, operands: readonly unknown[]): Bound | undefined {
  return (
    controlStatement(sql, operands) ??
    logLeaf(sql, operands) ??
    sessionLeaf(sql, operands) ??
    disclosureLeaf(sql, operands) ??
    platformLeaf(sql, operands)
  );
}

export function publishedLogConnectionWork(): Bound {
  return declareBound({
    ...zero(),
    nativePoints: 1,
  });
}

/** Query interceptor on the reserved envelope; consume skips while that frame is open. */
export function withPublishedLogNativeWork<T>(deadline: number, run: () => Promise<T>): Promise<T> {
  void deadline;
  return withNativeCommandAccounting(
    {
      connection(dispatch) {
        if (isAccessWorkDispatch() || currentLibraryOperationAccounting()) return dispatch();
        return consumePublishedLogWork('connection', publishedLogConnectionWork(), dispatch);
      },
      query(sql, operands, dispatch) {
        if (isAccessWorkDispatch()) {
          return currentLibraryOperationAccounting()
            ? dispatch()
            : consumePublishedLogWork('access-sql', sqlAxes(bytesOf(sql, operands)), dispatch);
        }
        const bound = publishedLogStatement(sql, operands);
        if (!bound || currentLibraryOperationAccounting()) return dispatch();
        return consumePublishedLogWork('statement', bound, dispatch);
      },
    },
    run,
  );
}

export function bindPublishedLogNativeWork(deadline: number): <R>(dispatch: () => Promise<R>) => Promise<R> {
  return (dispatch) => withPublishedLogNativeWork(deadline, dispatch);
}

export const PUBLISHED_LOG_WORK_STEP_DEADLINE_MS = WORK_STEP_DEADLINE_MS;
