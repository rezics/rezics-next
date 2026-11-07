/** Compatibility facade. Planning lives in application/core; this file owns SQL runners and work consumption. */

import { memoizedValue } from '../memoized.ts';
import { AsyncLocalStorage } from 'node:async_hooks';
import { repeatBound, type Bound } from '@rezics/bounds';
import type { PoolClient } from 'pg';
import { currentCommandWorkAssociation, currentLibraryOperationAccounting } from '../command/work-context.ts';
import sessionInsert from './progress-store-session-insert.sql';
import sessionRead from './progress-store-session-read.sql';
import sessionUpdate from './progress-store-session-update.sql';
import sessionPage from './progress-store-session-page.sql';
import journalRead from './progress-store-session-journal-read.sql';
import journalLock from './progress-store-session-journal-lock.sql';
import journalUpdate from './progress-store-session-journal-update.sql';
import unitAdd from './progress-store-unit-add.sql';
import unitRemove from './progress-store-unit-remove.sql';
import unitClear from './progress-commands-clear-units.sql';
import unitPage from './progress-store-unit-page.sql';
import changeAppend from './progress-store-change-append.sql';
import changePage from './progress-store-change-page.sql';
import sessionLock from './session-lock.sql';
import discoveryPage from './progress-discovery-page.sql';
import discoveryGeneration from './progress-discovery-generation-read.sql';
import discoveryReleases from './progress-discovery-releases.sql';
import { RELEASE_LIMITS } from '@rezics/definitions';
import { createProgressOperationBounds, retainSessionOperands, sessionBytesWork } from './core/index.ts';
import { SESSION_LIMITS } from './contract/index.ts';
import type {
  SessionCommandOriginal,
  SessionOperationKind,
  SessionReadInput,
  SessionReadKind,
  SessionSqlKind,
} from './contract/index.ts';
import {
  createProgressOperationCatalog,
  PROGRESS_MEANING_SQL,
  PROGRESS_REFRESH_SQL,
} from './adapters/progress-statements.ts';

type Client = Pick<PoolClient, 'query'>;
type Query<I, R> = Readonly<{ sql: string; run(client: Client, input: I): Promise<R> }>;
type Input<Q> = Q extends Query<infer I, unknown> ? I : never;

export type { SessionSqlKind, SessionOperationKind, SessionReadKind };
export { SESSION_LIMITS, retainSessionOperands, sessionBytesWork };

export type SessionSqlPlan<I, R> = Readonly<{
  kind: SessionSqlKind;
  input: Readonly<I>;
  total: Bound;
  run(client: Client): Promise<R>;
}>;

export type SessionCommandPlan = Readonly<{
  kind: SessionOperationKind;
  original: SessionCommandOriginal;
  total: Bound;
  consumeAttempt(): Promise<void>;
}>;

export type SessionReadPlan = Readonly<{
  kind: SessionReadKind;
  original: SessionReadInput;
  total: Bound;
  run<T>(dispatch: () => Promise<T>): Promise<T>;
}>;

function bounds() {
  return memoizedValue(bounds, () => createProgressOperationBounds(createProgressOperationCatalog()));
}

const enclosingSessionPlan = new AsyncLocalStorage<Readonly<{ total: Bound }>>();

export function withSessionCommandPlan<T>(plan: SessionCommandPlan, dispatch: () => Promise<T>): Promise<T> {
  return enclosingSessionPlan.run(plan, dispatch);
}

export function consumeSessionWork<T>(kind: string, total: Bound, dispatch: () => Promise<T>): Promise<T> {
  if (currentLibraryOperationAccounting()) return dispatch();
  if (enclosingSessionPlan.getStore()) return dispatch();
  return consumeNativeSessionWork(kind, total, dispatch);
}

function consumeNativeSessionWork<T>(kind: string, total: Bound, dispatch: () => Promise<T>): Promise<T> {
  if (currentLibraryOperationAccounting()) return dispatch();
  const association = currentCommandWorkAssociation();
  const { engineRequests, ...native } = total;
  void engineRequests;
  return association ? association.run(`library.session.${kind}`, native, dispatch) : dispatch();
}

const uuid = 'ffffffff-ffff-8fff-bfff-ffffffffffff';
const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

function statement<I, R>(
  kind: SessionSqlKind,
  query: Query<I, R>,
  input: I,
  shape: Parameters<ReturnType<typeof createProgressOperationBounds>['statementWork']>[2],
  nested?: Bound,
): SessionSqlPlan<I, R> {
  const original = retainSessionOperands(input);
  const total = bounds().statementWork(query.sql, size(original), shape, nested);
  return Object.freeze({
    kind,
    input: original,
    total,
    run(client: Client) {
      return consumeSessionWork(`sql.${kind}`, total, () => query.run(client, original));
    },
  });
}

export const sessionInsertPlan = (input: Input<typeof sessionInsert>) =>
  statement('insert', sessionInsert, input, bounds().point(bounds().sessionBytes), bounds().sessionMutationEffects());
export const sessionReadPlan = (input: Input<typeof sessionRead>) =>
  statement('read', sessionRead, input, bounds().point(bounds().factBytes));
export const sessionUpdatePlan = (input: Input<typeof sessionUpdate>) =>
  statement('update', sessionUpdate, input, bounds().point(bounds().sessionBytes), bounds().sessionMutationEffects());
export const sessionLockPlan = (input: Input<typeof sessionLock>) =>
  statement('lock', sessionLock, input, bounds().point(size({ sessionId: uuid })));
export const sessionJournalReadPlan = (input: Input<typeof journalRead>) =>
  statement('journal-read', journalRead, input, bounds().point(bounds().journalBytes));
export const sessionJournalLockPlan = (input: Input<typeof journalLock>) =>
  statement('journal-lock', journalLock, input, bounds().point(bounds().journalBytes));
export const sessionJournalUpdatePlan = (input: Input<typeof journalUpdate>) =>
  statement(
    'journal-update',
    journalUpdate,
    input,
    bounds().point(bounds().journalBytes),
    bounds().sessionMutationEffects(),
  );

export function sessionUnitAddPlan(input: Input<typeof unitAdd>) {
  const count = input.unit_ids.length;
  return statement(
    'unit-add',
    unitAdd,
    input,
    {
      keys: count,
      rows: 1 + count * 4,
      points: 1 + count * 2,
      seeks: 1 + count,
      output: 1,
      rowBytes: size({ added: 100 }),
    },
    repeatBound(bounds().childFence(), count),
  );
}
export function sessionUnitRemovePlan(input: Input<typeof unitRemove>) {
  const count = input.unit_ids.length;
  return statement(
    'unit-remove',
    unitRemove,
    input,
    { keys: count, rows: count * 3, points: count, seeks: count, output: 1, rowBytes: size({ removed: 100 }) },
    repeatBound(bounds().childFence(), count),
  );
}
export function sessionUnitClearPlan(input: Input<typeof unitClear>) {
  return statement(
    'unit-clear',
    unitClear,
    input,
    { keys: SESSION_LIMITS.units, rows: 3 * SESSION_LIMITS.units, points: 1, seeks: 1, output: 0, rowBytes: 0 },
    repeatBound(bounds().childFence(), SESSION_LIMITS.units),
  );
}
export const sessionChangeAppendPlan = (input: Input<typeof changeAppend>) =>
  statement(
    'change-append',
    changeAppend,
    input,
    { ...bounds().point(bounds().changeBytes), rows: 3, points: 2 },
    bounds().childFence(),
  );

export function sessionSubjectPagePlan(input: Input<typeof sessionPage>) {
  const ranges = input.has_cursor ? 2 : 1;
  return statement('subject-page', sessionPage, input, {
    keys: ranges * input.limit,
    rows: ranges * input.limit,
    points: ranges,
    seeks: ranges,
    output: input.limit,
    rowBytes: bounds().factBytes,
  });
}
export const sessionUnitPagePlan = (input: Input<typeof unitPage>) =>
  statement('unit-page', unitPage, input, {
    keys: input.limit,
    rows: input.limit,
    points: 1,
    seeks: 1,
    output: input.limit,
    rowBytes: bounds().unitBytes,
  });
export const sessionChangePagePlan = (input: Input<typeof changePage>) =>
  statement('change-page', changePage, input, {
    keys: input.limit,
    rows: input.limit,
    points: 1,
    seeks: 1,
    output: input.limit,
    rowBytes: bounds().changeBytes,
  });
export const sessionDiscoveryGenerationPlan = (input: Input<typeof discoveryGeneration>) =>
  statement(
    'owner-generation',
    discoveryGeneration,
    input,
    bounds().point(size({ generation: '-9223372036854775808' })),
  );
export function sessionDiscoveryPagePlan(input: Input<typeof discoveryPage>) {
  return statement('owner-page', discoveryPage, input, {
    keys: input.limit,
    rows: 2 * input.limit,
    points: 1 + input.limit,
    seeks: 1 + input.limit,
    output: input.limit,
    rowBytes: bounds().factBytes,
  });
}
export const sessionDiscoveryReleasesPlan = (input: Input<typeof discoveryReleases>) =>
  statement('discovery-releases', discoveryReleases, input, {
    keys: input.digests.length,
    rows: input.digests.length,
    points: input.digests.length,
    seeks: input.digests.length,
    output: input.digests.length,
    rowBytes: size({ digest: `sha256:${'f'.repeat(64)}`, body: null }) + 6 * RELEASE_LIMITS.bytes,
  });

type MeaningInput = { route: number; sessionId: string; pin: string; meanings: string };
export function sessionMeaningInsertPlan(input: MeaningInput, count: number) {
  return statement(
    'meaning-insert',
    {
      sql: PROGRESS_MEANING_SQL,
      run: (client, original: MeaningInput) =>
        client.query(PROGRESS_MEANING_SQL, [original.route, original.sessionId, original.pin, original.meanings]),
    },
    input,
    { keys: count, rows: count * 2, points: count, seeks: count, output: 0, rowBytes: 0 },
  );
}
export function sessionMeaningRefreshPlan(input: { route: number; sessionId: string }) {
  return statement(
    'meaning-refresh',
    {
      sql: PROGRESS_REFRESH_SQL,
      run: (client, original: typeof input) => client.query(PROGRESS_REFRESH_SQL, [original.route, original.sessionId]),
    },
    input,
    { keys: 0, rows: 0, points: 0, seeks: 0, output: 1, rowBytes: 4 },
    bounds().progressRefresh(),
  );
}

export function sessionPresentationWork(measures: number, sessions = 1): Bound {
  return bounds().sessionPresentationWork(measures, sessions);
}

export function sessionCoreCommandAttemptWork(
  kind: string,
  accountId: string,
  receiptKeys: number,
  response: object,
): Bound {
  return bounds().sessionCoreCommandAttemptWork(kind, accountId, receiptKeys, response);
}

export function sessionCommandPlan(
  kind: SessionOperationKind,
  original: SessionCommandOriginal,
  receiptKeys: number,
  preparesSource = false,
  durationMs = 5000,
): SessionCommandPlan {
  const plan = bounds().sessionCommandPlan(kind, original, receiptKeys, preparesSource, durationMs);
  return Object.freeze({
    kind: plan.kind,
    original: plan.original,
    total: plan.total,
    consumeAttempt() {
      return consumeNativeSessionWork(`command.${plan.kind}`, plan.total, async () => undefined);
    },
  });
}

export function sessionSnapshotWork(accountId: string): Bound {
  return bounds().sessionSnapshotWork(accountId);
}

export function sessionPartitionWork(partition: number): Bound {
  return bounds().sessionPartitionWork(partition);
}

export function sessionReleaseWork(digest: string, active = false): Bound {
  return bounds().sessionReleaseWork(digest, active);
}

export function sessionSourceWork(subjectId: string, withProfile: boolean): Bound {
  return bounds().sessionSourceWork(subjectId, withProfile);
}

export function sessionHeadWork(input: { route: number; account_id: string; subject_id: string }): Bound {
  return bounds().sessionHeadWork(input);
}

export function sessionActivityWork(input: {
  route: number;
  account_id: string;
  subject_id: string;
  time: string;
  completed: boolean;
}): Bound {
  return bounds().sessionActivityWork(input);
}

export function sessionShelfWork(route: number, accountId: string, counters: boolean): Bound {
  return bounds().sessionShelfWork(route, accountId, counters);
}

export function sessionProfileMigrationWork(route: number, accountId: string): Bound {
  return bounds().sessionProfileMigrationWork(route, accountId);
}

export function sessionReadTimeWork(): Bound {
  return bounds().sessionReadTimeWork();
}

export function sessionReadOperationPlan(
  kind: SessionReadKind,
  accountId: string,
  input: SessionReadInput,
): SessionReadPlan {
  const plan = bounds().sessionReadOperationPlan(kind, accountId, input);
  return Object.freeze({
    kind: plan.kind,
    original: plan.original,
    total: plan.total,
    run<T>(dispatch: () => Promise<T>) {
      if (enclosingSessionPlan.getStore()) return dispatch();
      return consumeNativeSessionWork(kind, plan.total, () =>
        enclosingSessionPlan.run({ total: plan.total }, dispatch),
      );
    },
  });
}
