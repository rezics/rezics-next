import { memoizedValue } from '../memoized.ts';
import { AsyncLocalStorage } from 'node:async_hooks';
import { declareBound, repeatBound, sumBounds, type Bound } from '@rezics/bounds';
import { RELEASE_LIMITS } from '@rezics/definitions';
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
import receiptRead from '../command/read-receipt.sql';
import eventFence from '../command/fence.sql';
import noEffectFence from '../command/no-effect-fence.sql';
import timeRead from '../command/time.sql';
import accountRead from '../access/account-read.sql';
import accountShare from '../access/account-share.sql';
import partitionRead from '../partition/read.sql';
import releaseRead from '../semantic/definitions-read.sql';
import releaseExists from '../semantic/definitions-exists.sql';
import releaseActive from '../semantic/definitions-active.sql';
import mappingOwners from '../semantic/identity-epoch-read-owners.sql';
import mappingSources from '../semantic/identity-epoch-read-sources.sql';
import mappingPending from '../semantic/identity-epoch-read-pending.sql';
import mappingCurrent from '../semantic/identity-terminal-closure-current.sql';
import subjectReference from '../semantic/read-subject-reference.sql';
import itemTypes from '../semantic/read-item-types.sql';
import profileMigration from './profile-migration-progress.sql';
import { partitionOf, routeOf } from '../route/route.ts';
import headEnsure from './shelf-head-ensure.sql';
import headTouch from './shelf-head-touch.sql';
import entryRaise from './shelf-entry-raise.sql';
import gateRead from './shelf-maintenance-gate-read.sql';
import gateEnsure from './shelf-maintenance-gate-ensure.sql';
import gateLock from './shelf-maintenance-gate-lock.sql';
import gateShare from './shelf-maintenance-gate-share.sql';
import gateSave from './shelf-maintenance-gate-save.sql';
import shelfInputs from './shelf-maintenance-inputs.sql';
import runCreate from './shelf-maintenance-run-create.sql';
import runRead from './shelf-maintenance-run-read.sql';
import stepSave from './shelf-maintenance-step-save.sql';
import counterInitialize from './shelf-counter-owner-initialize.sql';
import counterRead from './shelf-counter-owner-read.sql';
import counterComplete from './shelf-counter-owner-complete.sql';

type Client = Pick<PoolClient, 'query'>;
type Query<I, R> = Readonly<{ sql: string; run(client: Client, input: I): Promise<R> }>;
type Input<Q> = Q extends Query<infer I, unknown> ? I : never;

/** Closed Library leaves. A declaration is neither a grant nor execution evidence. */
export type SessionSqlKind =
  | 'insert'
  | 'read'
  | 'update'
  | 'lock'
  | 'subject-page'
  | 'journal-read'
  | 'journal-lock'
  | 'journal-update'
  | 'unit-add'
  | 'unit-remove'
  | 'unit-clear'
  | 'unit-page'
  | 'change-append'
  | 'change-page'
  | 'owner-page'
  | 'owner-generation'
  | 'discovery-releases'
  | 'meaning-insert'
  | 'meaning-refresh';

export type SessionSqlPlan<I, R> = Readonly<{
  kind: SessionSqlKind;
  input: Readonly<I>;
  total: Bound;
  run(client: Client): Promise<R>;
}>;

export const SESSION_LIMITS = Object.freeze({ page: 100, ownerPage: 50, measures: 8, unitWrite: 100, units: 20_000 });
// Canonical routable placeholder for subject-routed source plans (see published-log-bounds.ts).
const uuid = 'ffffffff-ffff-7fff-bfff-ffffffffffff';
const timestamp = '\0'.repeat(64);
// PostgreSQL unconstrained numeric: 131072 digits before and 16383 after the
// decimal point, plus sign and point. Native imported/retained values can exceed
// today's HTTP decimal range; a read declaration must cover them too.
const numeric = '9'.repeat(131_072 + 16_383 + 2);
const text = (characters: number) => '\0'.repeat(characters);
const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const pin = { provenance: 'profile', releaseDigest: `sha256:${'f'.repeat(64)}`, acceptingType: '', profileId: '' };
function pinBytes() {
  return memoizedValue(pinBytes, () => size(pin) + 2 * 6 * RELEASE_LIMITS.bytes);
}
const measure = { unit: text(128), amount: numeric, total: numeric };
const session = {
  route: 65535,
  id: uuid,
  accountId: uuid,
  subjectId: uuid,
  versionSubjectId: uuid,
  mode: 'completed_units',
  unit: text(128),
  total: numeric,
  amount: numeric,
  locator: text(256),
  position: numeric,
  completedUnitCount: 20_000,
  state: 'completed',
  revision: 2_147_483_647,
  startedAt: timestamp,
  completedAt: timestamp,
  transactionId: uuid,
  additionalMeasures: [],
};
// additional_measures has a separate 4096-byte JSONB CHECK. At most seven
// repeated measures are returned even when every unit is a different meaning.
const sessionBytes = size(session) + 6 * 4096;
// Public multi-measure serialization repeats the primary amount/total in measures.
const responseSessionBytes = sessionBytes + size({ measures: [measure] });
function factBytes() {
  return memoizedValue(factBytes, () => sessionBytes + size({ libraryProfilePin: null }) + pinBytes());
}
const journalBytes = size({
  sessionId: uuid,
  accountId: uuid,
  revision: 2_147_483_646,
  startYear: 9999,
  startMonth: 12,
  startDay: 31,
  finishYear: 9999,
  finishMonth: 12,
  finishDay: 31,
  reflection: text(2000),
  assessmentPresence: 'explicit_null',
  assessmentUnits: 20,
  assessmentMeaningRevision: 1,
});
const unitBytes = size({ route: 65535, sessionId: uuid, unitId: text(128), addedAt: timestamp });
// The native sparse intent caps the combined add/remove list at 100 original IDs.
// Reserve both JSON field names independently of the distribution.
const intentBytes = size({ add: [], remove: [] }) + 100 * (size(text(128)) + 1) + size(measure);
const changeBytes =
  size({
    route: 65535,
    sessionId: uuid,
    changeNo: 2_147_483_647,
    intent: null,
    recordedAt: timestamp,
    transactionId: uuid,
  }) + intentBytes;
const bigint = '-9223372036854775808';
const ownerKey = { route: 65535, accountId: uuid };
const subjectKey = { ...ownerKey, subjectId: uuid };
const consumptionOwnerBytes = size({
  ...ownerKey,
  retainedSessions: bigint,
  completedOccurrences: bigint,
  completedSubjects: bigint,
  unknownProfileCompleted: bigint,
  revision: uuid,
});
const consumptionSubjectBytes = size({ ...subjectKey, retainedSessions: bigint, completedOccurrences: bigint });
const reportedBucketBytes = size({
  ...ownerKey,
  year: 9999,
  bucket: 13,
  completed: bigint,
  subjects: bigint,
  unknownProfile: bigint,
  monthPrecision: bigint,
  dayPrecision: bigint,
});
const reportedSubjectBytes = size({ ...subjectKey, year: 9999, bucket: 13, completed: bigint });
// The two profile_key columns have an octet_length <= 1024 CHECK. Escaping
// is independent of that native byte limit, as it is for original SQL binds.
const insightsProfileBytes = size({
  ...subjectKey,
  year: 9999,
  profileKey: text(1024),
  completed: bigint,
  subjects: bigint,
  repeats: bigint,
  knownProfiles: bigint,
});
const assessmentBytes = size({
  ...ownerKey,
  meaningRevision: 16,
  units: 20,
  occurrences: bigint,
  absent: bigint,
  explicitNull: bigint,
  valued: bigint,
  historicalUnknown: bigint,
  revision: uuid,
});
function projectedMeaningBytes() {
  return memoizedValue(
    projectedMeaningBytes,
    () =>
      pinBytes() +
      size({
        profilePin: null,
        unitId: text(128),
        meaningRevision: 1,
        mode: 'completed_units',
        unit: text(128),
        dimension: '',
        precision: 6,
        minimum: numeric,
        maximum: numeric,
        totalPolicy: 'forbidden',
        identityKind: 'session_local',
        structureKind: 'none',
        locator: text(256),
      }) +
      6 * RELEASE_LIMITS.bytes,
  );
}
function currentProgressBytes() {
  return memoizedValue(
    currentProgressBytes,
    () =>
      projectedMeaningBytes() +
      size({
        ...subjectKey,
        sessionId: uuid,
        scope: 'backlog',
        state: 'abandoned',
        covered: false,
        occurrences: bigint,
        currentKnown: bigint,
        currentSum: numeric,
        totalKnown: bigint,
        totalSum: numeric,
        revision: uuid,
      }),
  );
}

export function sessionBytesWork(bytes: number): Bound {
  return declareBound({
    candidateKeys: 0,
    nativeRows: 0,
    identityMetadataRows: 0,
    emptySeeks: 0,
    nativePoints: 0,
    witnessKeys: 0,
    statements: 0,
    bytes,
    engineRequests: 0,
  });
}

type Shape = Readonly<{ keys: number; rows: number; points: number; seeks: number; output: number; rowBytes: number }>;
const point = (rowBytes: number): Shape => ({ keys: 1, rows: 1, points: 1, seeks: 1, output: 1, rowBytes });

/** Each native point counts its heap and every reached index tuple separately. */
function nativePoint(rows: number, points: number, statements: number, bytes: number): Bound {
  return declareBound({
    candidateKeys: 0,
    nativeRows: rows,
    identityMetadataRows: 0,
    nativePoints: points,
    emptySeeks: points,
    witnessKeys: 0,
    statements,
    bytes,
    engineRequests: 0,
  });
}

// Old/new index entries of progress_session: primary plus the 20 schema indexes
// (including partial indexes, which can be entered/withdrawn on state change).
// A failed CAS retains this maximum. No result rowCount refunds dispatched work.
function sessionHeapAndIndexes() {
  return memoizedValue(sessionHeapAndIndexes, () => nativePoint(2 + 2 * 21, 1 + 2 * 21, 0, 2 * factBytes()));
}
// All scalar statistics are exact owner/subject/year/meaning points. These
// counts include negative probes, ON CONFLICT old/new tuples and cleanup DELETEs.
function sourceHeads() {
  return memoizedValue(sourceHeads, () => nativePoint(4 * 4, 4, 4, 4 * 4 * size({ ...ownerKey, generation: bigint })));
}
function consumption() {
  return memoizedValue(consumption, () =>
    repeatBound(
      nativePoint(
        4 + 1 + 3 + 3 + 2 + 2,
        6,
        6,
        (4 + 3 + 2) * consumptionOwnerBytes + (1 + 3 + 2) * consumptionSubjectBytes,
      ),
      2,
    ),
  );
}
function reportedYear() {
  return memoizedValue(reportedYear, () =>
    repeatBound(
      nativePoint(4 + 3 + 2 + 4 + 3, 5, 5, (4 + 3) * reportedSubjectBytes + (2 + 4 + 3) * reportedBucketBytes),
      2,
    ),
  );
}
function insightsYear() {
  return memoizedValue(insightsYear, () =>
    repeatBound(
      nativePoint(
        4 + 3 + 1 + 4 + 1 + 3 + 3 + 1 + 3 + 3,
        10,
        10,
        (4 + 3 + 1 + 4 + 1 + 3 + 3 + 1 + 3 + 3) * insightsProfileBytes,
      ),
      2,
    ),
  );
}
function assessment() {
  return memoizedValue(assessment, () =>
    sumBounds(
      nativePoint(4 + 1 + 3, 3, 3, (4 + 1 + 3) * assessmentBytes),
      repeatBound(nativePoint(4 + 3 + 1 + 4 + 2, 5, 5, (4 + 3 + 1 + 4 + 2) * assessmentBytes), 2),
    ),
  );
}

// reading_insights_current_progress_refresh removes every OLD measure then
// inserts every NEW one, even for a same-value update or a journal-only patch.
// apply touches group, scope, owner and its empty-group cleanup independently.
function progressApply() {
  return memoizedValue(progressApply, () =>
    nativePoint(1 + 4 + 3 + 3 + 2, 5, 5, (1 + 4 + 3 + 3 + 2) * currentProgressBytes()),
  );
}
function progressRefresh() {
  return memoizedValue(progressRefresh, () =>
    sumBounds(
      nativePoint(1 + 1 + 2 + 3 + 2 + 3 + 2 + 2 + 1 + 4 + 1 + 2 + 4 + 3 + 3 + 3, 16, 16, 2 * factBytes()),
      repeatBound(
        sumBounds(nativePoint(3 + 1 + 3, 3, 3, (3 + 1 + 3) * currentProgressBytes()), progressApply()),
        2 * SESSION_LIMITS.measures,
      ),
    ),
  );
}
function migration() {
  return memoizedValue(migration, () => nativePoint(4 + 1 + 4 + 3, 7, 7, pinBytes()));
}
// Scope refresh: exact head lock, live pin existence, support/index/pin
// insertion or withdrawal, and at most 64 state metadata rows on pin removal.
function memberScope() {
  return memoizedValue(memberScope, () =>
    repeatBound(nativePoint(1 + 2 + 4 + 4 + 4 + 2 + 2 + 2 + 64, 9, 9, pinBytes()), 2),
  );
}
function sessionTriggers() {
  return memoizedValue(sessionTriggers, () =>
    sumBounds(
      sourceHeads(),
      consumption(),
      reportedYear(),
      insightsYear(),
      assessment(),
      progressRefresh(),
      migration(),
      memberScope(),
    ),
  );
}
function childFence() {
  return memoizedValue(childFence, () =>
    nativePoint(1 + 4, 2, 2, (1 + 4) * size({ route: 65535, sessionId: uuid, writeState: 'active' })),
  );
}

export function retainSessionOperands<I>(input: I): I {
  const original = structuredClone(input);
  function freeze(value: unknown): void {
    if (value === null || typeof value !== 'object') return;
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  freeze(original);
  return original;
}

function statement<I, R>(
  kind: SessionSqlKind,
  query: Query<I, R>,
  input: I,
  shape: Shape,
  nested?: Bound,
): SessionSqlPlan<I, R> {
  const original = retainSessionOperands(input);
  const total = statementWork(query.sql, size(original), shape, nested);
  return Object.freeze({
    kind,
    input: original,
    total,
    run(client: Client) {
      return consumeSessionWork(`sql.${kind}`, total, () => query.run(client, original));
    },
  });
}

function statementWork(sql: string, inputBytes: number, shape: Shape, nested?: Bound): Bound {
  return sumBounds(
    declareBound({
      candidateKeys: shape.keys,
      nativeRows: shape.rows,
      identityMetadataRows: 0,
      nativePoints: shape.points,
      emptySeeks: shape.seeks,
      witnessKeys: 0,
      statements: 1,
      bytes: Buffer.byteLength(sql) + inputBytes + 2 + shape.output * (shape.rowBytes + 1),
      // These closed leaves execute SQL only. Keep the ninth axis explicit.
      engineRequests: 0,
    }),
    ...(nested ? [nested] : []),
  );
}

const enclosingSessionPlan = new AsyncLocalStorage<Readonly<{ total: Bound }>>();

/** Keep the complete immutable attempt declaration across preparation, transaction and retries. */
export function withSessionCommandPlan<T>(plan: SessionCommandPlan, dispatch: () => Promise<T>): Promise<T> {
  return enclosingSessionPlan.run(plan, dispatch);
}

/** Translation to the existing eight-axis port is explicit; no ninth-axis work is dropped. */
export function consumeSessionWork<T>(kind: string, total: Bound, dispatch: () => Promise<T>): Promise<T> {
  if (currentLibraryOperationAccounting()) return dispatch();
  if (enclosingSessionPlan.getStore()) return dispatch();
  return consumeNativeSessionWork(kind, total, dispatch);
}

function consumeNativeSessionWork<T>(kind: string, total: Bound, dispatch: () => Promise<T>): Promise<T> {
  if (currentLibraryOperationAccounting()) return dispatch();
  const association = currentCommandWorkAssociation();
  const { engineRequests, ...native } = total;
  // The closed operation set contains no Search request. Search's discovery
  // composition keeps its own engineRequests accounting at its existing root.
  void engineRequests;
  return association ? association.run(`library.session.${kind}`, native, dispatch) : dispatch();
}

export const sessionInsertPlan = (input: Input<typeof sessionInsert>) =>
  statement('insert', sessionInsert, input, point(sessionBytes), sumBounds(sessionHeapAndIndexes(), sessionTriggers()));
export const sessionReadPlan = (input: Input<typeof sessionRead>) =>
  statement('read', sessionRead, input, point(factBytes()));
export const sessionUpdatePlan = (input: Input<typeof sessionUpdate>) =>
  statement('update', sessionUpdate, input, point(sessionBytes), sumBounds(sessionHeapAndIndexes(), sessionTriggers()));
export const sessionLockPlan = (input: Input<typeof sessionLock>) =>
  statement('lock', sessionLock, input, point(size({ sessionId: uuid })));
export const sessionJournalReadPlan = (input: Input<typeof journalRead>) =>
  statement('journal-read', journalRead, input, point(journalBytes));
export const sessionJournalLockPlan = (input: Input<typeof journalLock>) =>
  statement('journal-lock', journalLock, input, point(journalBytes));
export const sessionJournalUpdatePlan = (input: Input<typeof journalUpdate>) =>
  statement(
    'journal-update',
    journalUpdate,
    input,
    point(journalBytes),
    sumBounds(sessionHeapAndIndexes(), sessionTriggers()),
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
    repeatBound(childFence(), count),
  );
}
export function sessionUnitRemovePlan(input: Input<typeof unitRemove>) {
  const count = input.unit_ids.length;
  return statement(
    'unit-remove',
    unitRemove,
    input,
    { keys: count, rows: count * 3, points: count, seeks: count, output: 1, rowBytes: size({ removed: 100 }) },
    repeatBound(childFence(), count),
  );
}
export function sessionUnitClearPlan(input: Input<typeof unitClear>) {
  return statement(
    'unit-clear',
    unitClear,
    input,
    { keys: SESSION_LIMITS.units, rows: 3 * SESSION_LIMITS.units, points: 1, seeks: 1, output: 0, rowBytes: 0 },
    repeatBound(childFence(), SESSION_LIMITS.units),
  );
}
export const sessionChangeAppendPlan = (input: Input<typeof changeAppend>) =>
  statement('change-append', changeAppend, input, { ...point(changeBytes), rows: 3, points: 2 }, childFence());

export function sessionSubjectPagePlan(input: Input<typeof sessionPage>) {
  // First uses one branch. Next may visit both timestamp ranges, each with its
  // own LIMIT, before the merge discards candidates. The sentinel is raw work.
  const ranges = input.has_cursor ? 2 : 1;
  return statement('subject-page', sessionPage, input, {
    keys: ranges * input.limit,
    rows: ranges * input.limit,
    points: ranges,
    seeks: ranges,
    output: input.limit,
    rowBytes: factBytes(),
  });
}
export const sessionUnitPagePlan = (input: Input<typeof unitPage>) =>
  statement('unit-page', unitPage, input, {
    keys: input.limit,
    rows: input.limit,
    points: 1,
    seeks: 1,
    output: input.limit,
    rowBytes: unitBytes,
  });
export const sessionChangePagePlan = (input: Input<typeof changePage>) =>
  statement('change-page', changePage, input, {
    keys: input.limit,
    rows: input.limit,
    points: 1,
    seeks: 1,
    output: input.limit,
    rowBytes: changeBytes,
  });
export const sessionDiscoveryGenerationPlan = (input: Input<typeof discoveryGeneration>) =>
  statement('owner-generation', discoveryGeneration, input, point(size({ generation: '-9223372036854775808' })));
export function sessionDiscoveryPagePlan(input: Input<typeof discoveryPage>) {
  // Exactly one of the eight filter branches is active. Candidate IDs and the
  // joined session point are distinct work, including the discarded 51st row.
  return statement('owner-page', discoveryPage, input, {
    keys: input.limit,
    rows: 2 * input.limit,
    points: 1 + input.limit,
    seeks: 1 + input.limit,
    output: input.limit,
    rowBytes: factBytes(),
  });
}
export const sessionDiscoveryReleasesPlan = (input: Input<typeof discoveryReleases>) =>
  statement('discovery-releases', discoveryReleases, input, {
    keys: input.digests.length,
    rows: input.digests.length,
    points: input.digests.length,
    seeks: input.digests.length,
    output: input.digests.length,
    rowBytes: size({ digest: pin.releaseDigest, body: null }) + 6 * RELEASE_LIMITS.bytes,
  });

const meaningSql = `INSERT INTO library.reading_insights_progress_meaning
        (route,session_id,unit_id,meaning_revision,mode,profile_pin,dimension,precision,minimum,maximum,
         total_policy,identity_kind,structure_kind)
       SELECT $1,$2,unit_id,1,mode,$3::jsonb,dimension,precision,minimum,maximum,total_policy,identity_kind,structure_kind
       FROM jsonb_to_recordset($4::jsonb) AS accepted(
         unit_id text, mode text, dimension text, precision smallint, minimum numeric, maximum numeric,
         total_policy text, identity_kind text, structure_kind text)`;
type MeaningInput = { route: number; sessionId: string; pin: string; meanings: string };
export function sessionMeaningInsertPlan(input: MeaningInput, count: number) {
  return statement(
    'meaning-insert',
    {
      sql: meaningSql,
      run: (client, original: MeaningInput) =>
        client.query(meaningSql, [original.route, original.sessionId, original.pin, original.meanings]),
    },
    input,
    { keys: count, rows: count * 2, points: count, seeks: count, output: 0, rowBytes: 0 },
  );
}
const refreshSql = 'SELECT library.reading_insights_current_progress_refresh($1,$2)';
export function sessionMeaningRefreshPlan(input: { route: number; sessionId: string }) {
  return statement(
    'meaning-refresh',
    {
      sql: refreshSql,
      run: (client, original: typeof input) => client.query(refreshSql, [original.route, original.sessionId]),
    },
    input,
    { keys: 0, rows: 0, points: 0, seeks: 0, output: 1, rowBytes: 4 },
    progressRefresh(),
  );
}

/** Response work is declared before rendering, independently of its success. */
export function sessionPresentationWork(measures: number, sessions = 1): Bound {
  // Labels, forms and input rules are projections of one bounded immutable
  // release. Repeated measures serialize independently, even on the same pin.
  return repeatBound(
    sessionBytesWork(responseSessionBytes + pinBytes() + (1 + measures) * 6 * RELEASE_LIMITS.bytes),
    sessions,
  );
}

export type SessionOperationKind = 'start' | 'record' | 'complete' | 'abandon' | 'reopen' | 'retire' | 'journal';
export type SessionCommandPlan = Readonly<{
  kind: SessionOperationKind;
  original: Readonly<{
    accountId: string;
    clientId: string;
    requestedBy: string | null;
    kind: string;
    key: string;
    input: unknown;
  }>;
  /** Full Library attempt, including its closed preparation/mutation branches.
   * Native Access producers compose through their existing independent work port. */
  total: Bound;
  consumeAttempt(): Promise<void>;
}>;

function sqlWork(sql: string, input: unknown, rows: number, points: number, outputBytes: number, metadata = 0): Bound {
  return declareBound({
    candidateKeys: 0,
    nativeRows: rows,
    identityMetadataRows: metadata,
    nativePoints: points,
    emptySeeks: points,
    witnessKeys: 0,
    statements: 1,
    bytes: Buffer.byteLength(sql) + size(input) + outputBytes,
    engineRequests: 0,
  });
}

/** One command attempt, including replay, rollback and the no-effect fence.
 * Native Access owns account/action/group preparation via its original work port.
 * There is no second command invocation or admission for these declarations.
 */
export function sessionCommandPlan(
  kind: SessionOperationKind,
  original: SessionCommandPlan['original'],
  receiptKeys: number,
  preparesSource = false,
  durationMs = 5000,
): SessionCommandPlan {
  const retained = retainSessionOperands(original);
  const responseBytes =
    kind === 'journal' ? size({ sessionId: uuid, revision: 2_147_483_646, changed: false }) : responseSessionBytes;
  const receipt = {
    principal: { kind: 'account', id: retained.accountId },
    kind: retained.kind,
    key: 'rk1.2147483647.' + 'f'.repeat(64),
    digest: 'f'.repeat(44),
    response: null,
  };
  const controls = [
    'BEGIN ISOLATION LEVEL SERIALIZABLE',
    'BEGIN ISOLATION LEVEL SERIALIZABLE',
    "SET LOCAL lock_timeout = '200ms'",
    "SET LOCAL statement_timeout = '5000ms'",
    "SET LOCAL statement_timeout = '5000ms'",
    'COMMIT',
    'ROLLBACK',
  ];
  const control = sumBounds(
    ...controls.map((sql) => sqlWork(sql, [], 0, 0, 0)),
    // Core's time mint is a completed read-only transaction before preparation.
    boundedCommandReadWork(),
    sqlWork(timeRead.sql, { at: timestamp }, 1, 1, size({ value: timestamp })),
    // Native Access supplies account row/byte work; add its statement and original binds.
    sqlWork(accountRead.sql, { route: routeOf(retained.accountId)!, account_id: retained.accountId }, 0, 0, 0),
    // Current account hold is independent of the permission engine.
    sqlWork(accountShare.sql, { route: 65535, account_id: retained.accountId }, 1, 1, 256),
    sqlWork(
      receiptRead.sql,
      {
        partition_no: 4095,
        principal_kind: 'account',
        principal_id: retained.accountId,
        command_kind: retained.kind,
        idempotency_keys: Array(receiptKeys).fill(receipt.key),
      },
      receiptKeys,
      receiptKeys,
      responseBytes +
        size({
          requestDigest: 'f'.repeat(64),
          epoch: 2_147_483_647,
          position: '-9223372036854775808',
          transactionId: uuid,
          response: null,
          payloadState: 'retained',
        }),
    ),
    // event fence: partition old/new heap + PK; outbox heap + all five indexes;
    // History basis heap + its three indexes; receipt heap + three indexes.
    sqlWork(
      eventFence.sql,
      {
        partition_no: 4095,
        transaction_id: uuid,
        receipt,
        basis: {
          principal: { kind: 'account', id: retained.accountId },
          clientId: retained.clientId,
          requestedBy: retained.requestedBy,
        },
        events: [
          {
            type: 'com.rezics.library.progress_session.updated.v1',
            subject: retained.accountId,
            id: uuid,
            data: { sessionId: uuid },
          },
        ],
      },
      4 + 6 + 4 + 4,
      1 + 5 + 3 + 3,
      size({ epoch: 2_147_483_647, position: '-9223372036854775808' }),
    ),
    sqlWork(
      noEffectFence.sql,
      { partition_no: 4095, transaction_id: uuid, receipt },
      1 + 4,
      1 + 3,
      size({ epoch: 2_147_483_647, position: '-9223372036854775808' }),
    ),
    sessionPartitionWork(partitionOf(routeOf(retained.accountId)!)),
    // A failed write reads its partition again after rollback. Fenced recovery
    // releases the failed client, pauses 25ms, then checks out one read client.
    // The original absolute deadline bounds these probes, independently of
    // population and contention retries. No later attempt extends that budget.
    repeatBound(
      sumBounds(boundedCommandReadWork(), sessionPartitionWork(partitionOf(routeOf(retained.accountId)!))),
      1 + Math.ceil(durationMs / 25),
    ),
    sessionBytesWork(size(retained) + 3 * responseBytes),
  );
  const total = sumBounds(control, commandJourneyWork(kind, retained, preparesSource));
  return Object.freeze({
    kind,
    original: retained,
    total,
    consumeAttempt() {
      return consumeNativeSessionWork(`command.${kind}`, total, async () => undefined);
    },
  });
}

function boundedCommandReadWork(): Bound {
  return sumBounds(
    ...[
      'BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY',
      "SET LOCAL statement_timeout = '200ms'",
      'COMMIT',
      'ROLLBACK',
    ].map((sql) => sqlWork(sql, [], 0, 0, 0)),
  );
}

/** Preparation snapshots have one connection and one RR transaction, released by
 * withConnection. Rollback is retained even if the first statement fails. */
export function sessionSnapshotWork(accountId: string): Bound {
  return sumBounds(
    ...['BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY', 'COMMIT', 'ROLLBACK'].map((sql) =>
      sqlWork(sql, [], 0, 0, 0),
    ),
    // Access's own native account read supplies the row/byte work; this term adds
    // the actual statement text and original binds, absent from its six axes.
    sqlWork(accountRead.sql, { route: 65535, account_id: accountId }, 0, 0, 0),
  );
}

export function sessionPartitionWork(partition: number): Bound {
  return sqlWork(
    partitionRead.sql,
    { partition_no: partition },
    1,
    1,
    size({
      partitionNo: 4095,
      node: text(256),
      movedTo: text(256),
      writeState: 'active',
      epoch: 2_147_483_647,
      position: '-9223372036854775808',
    }),
  );
}

/** Cache hit/miss are both native points. Cold validation/digest parsing is
 * bounded by the immutable Definitions release ceiling, never another profile. */
export function sessionReleaseWork(digest: string, active = false): Bound {
  return sumBounds(
    sqlWork(releaseExists.sql, { route: 0, digest }, 1, 1, size({ digest })),
    sqlWork(releaseRead.sql, { route: 0, digest }, 1, 1, 6 * RELEASE_LIMITS.bytes),
    ...(active
      ? [sqlWork(releaseActive.sql, { route: 0 }, 1, 1, size({ digest: pin.releaseDigest, head: 2_147_483_647 }))]
      : []),
  );
}

/** One original Source anchor: three mapping reads (before, resolve, final),
 * each double-collects source and control homes. Source and terminal disclosure
 * repeat even when their IDs coincide. Native Access charges its own checks.
 */
export function sessionSourceWork(subjectId: string, withProfile: boolean): Bound {
  const mapping = sumBounds(
    sqlWork(mappingOwners.sql, [[4095]], 1, 1, 256, 1),
    sqlWork(mappingSources.sql, [[subjectId], [65535]], 4, 4, 2048, 3),
    sqlWork(mappingOwners.sql, [[4095]], 1, 1, 256, 1),
    sqlWork(mappingPending.sql, [[4095], [uuid]], 1, 1, 256, 1),
    sqlWork(mappingCurrent.sql, [[4095], [uuid], [subjectId]], 4, 4, 2048, 3),
    repeatBound(
      sumBounds(
        ...[
          'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY',
          "SET LOCAL statement_timeout = '5000ms'",
          'COMMIT',
          'ROLLBACK',
        ].map((sql) => sqlWork(sql, [], 0, 0, 0)),
      ),
      2,
    ),
  );
  return sumBounds(
    repeatBound(mapping, 2 * 3),
    sqlWork(accountRead.sql, { route: 65535, account_id: uuid }, 0, 0, 0),
    repeatBound(
      sumBounds(
        sessionPartitionWork(4095),
        sqlWork(
          subjectReference.sql,
          { route: 65535, subject_id: subjectId },
          2,
          2,
          size({ id: uuid, redirect: uuid }),
        ),
        ...[
          'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY',
          "SET LOCAL statement_timeout = '5000ms'",
          'COMMIT',
          'ROLLBACK',
        ].map((sql) => sqlWork(sql, [], 0, 0, 0)),
      ),
      3,
    ),
    // The type leaf also probes the exact optional account-agent link. The
    // terminal can differ from the requested ID, but both UUID binds have the same width.
    sqlWork(
      itemTypes.sql,
      { partition_no: partitionOf(routeOf(subjectId)!), routes: [routeOf(subjectId)!], subject_ids: [subjectId] },
      2,
      2,
      size({ id: uuid, type: '', agent_account_id: uuid, agent_verified: false }) + 6 * RELEASE_LIMITS.bytes,
    ),
    ...(withProfile ? [sessionReleaseWork(pin.releaseDigest, true)] : []),
  );
}

export function sessionHeadWork(input: { route: number; account_id: string; subject_id: string }): Bound {
  return sumBounds(
    sqlWork(headEnsure.sql, input, 4, 1, size({ lastChangedAt: timestamp, lastCompletedAt: timestamp })),
    // Head triggers refresh the one owner activity projection.
    nativePoint(1 + 1 + 3, 3, 3, size(input)),
  );
}

export function sessionActivityWork(input: {
  route: number;
  account_id: string;
  subject_id: string;
  time: string;
  completed: boolean;
}): Bound {
  return sumBounds(
    sqlWork(headTouch.sql, input, 4, 1, 0),
    sqlWork(entryRaise.sql, input, 3, 1, 0),
    // Exact Entry activity update reaches its source-fence, owner activity and
    // statistics hooks even when no logical state transition is appended.
    sourceHeads(),
    memberScope(),
    nativePoint(1 + 1 + 3, 3, 3, size(input)),
  );
}

/** Existing gate initialization can retain a durable backfill run. It does not
 * execute that run's future pages or enqueue a second scheduler here. */
export function sessionShelfWork(route: number, accountId: string, counters: boolean): Bound {
  const input = { route, account_id: accountId };
  const gateBytes = size({
    initialized: false,
    mode: 'rebuilding',
    ready: false,
    epoch: '-9223372036854775808',
    activeGeneration: uuid,
    runId: uuid,
  });
  const runBytes =
    size({
      runId: uuid,
      epoch: '-9223372036854775808',
      sequence: '-9223372036854775808',
      segment: 2_147_483_647,
      kind: 'backfill',
      phase: 'sessions',
      cursor: null,
      buildGeneration: uuid,
      enqueuePending: false,
      cancelled: false,
    }) +
    6 * 2048;
  const gate = sumBounds(
    sqlWork(accountShare.sql, input, 1, 1, 256),
    sqlWork(gateRead.sql, input, 1, 1, gateBytes),
    sqlWork(gateEnsure.sql, input, 4, 1, 0),
    sqlWork(gateLock.sql, input, 1, 1, gateBytes),
    // EXISTS uses three independent leading owner indexes, including the empty
    // result and LIMIT node of each family. It never scans all owner facts.
    sqlWork(shelfInputs.sql, input, 6, 3, size({ entries: false, collections: false, sessions: false })),
    sqlWork(
      runCreate.sql,
      {
        ...input,
        run_id: uuid,
        epoch: '-9223372036854775808',
        kind: 'backfill',
        phase: 'drain',
        build_generation: null,
      },
      4,
      3,
      0,
    ),
    sqlWork(
      gateSave.sql,
      { ...input, mode: 'open', ready: false, epoch: '-9223372036854775808', active_generation: uuid, run_id: uuid },
      3,
      1,
      0,
    ),
    sqlWork(stepSave.sql, { ...input, run_id: uuid }, 1 + 3, 2, 0),
    repeatBound(sqlWork(runRead.sql, { ...input, run_id: uuid }, 1, 1, runBytes), 2),
    repeatBound(sqlWork(gateShare.sql, input, 1, 1, gateBytes), 2),
  );
  return counters
    ? sumBounds(
        gate,
        sqlWork(counterInitialize.sql, { ...input, fence_id: uuid }, 4, 1, 0),
        repeatBound(
          sqlWork(
            counterRead.sql,
            input,
            1,
            1,
            size({
              fenceId: uuid,
              epoch: '-9223372036854775808',
              state: 'initializing',
              ready: false,
              generationId: uuid,
            }),
          ),
          2,
        ),
        sqlWork(
          counterComplete.sql,
          { ...input, ready: false, epoch: '-9223372036854775808', generation_id: uuid },
          3,
          1,
          0,
        ),
      )
    : gate;
}

export function sessionProfileMigrationWork(route: number, accountId: string): Bound {
  return sqlWork(
    profileMigration.sql,
    { route, account_id: accountId },
    1,
    1,
    size({ phase: 'progress_meanings', digest: pin.releaseDigest, after: uuid }),
  );
}

export function sessionReadTimeWork(): Bound {
  return sqlWork(timeRead.sql, { at: timestamp }, 1, 1, size({ value: timestamp }));
}

/** Closed whole-attempt composition. Unknown stored projections use the native
 * schema widths above; the original request is still serialized independently.
 * Every SQL leaf binds its actual original operands before dispatch. Those
 * declarations are included here, rather than charged for a second time.
 */
function commandJourneyWork(
  kind: SessionOperationKind,
  original: SessionCommandPlan['original'],
  preparesSource: boolean,
): Bound {
  const route = routeOf(original.accountId)!;
  const input = original.input as Record<string, unknown>;
  const bindBytes = size(original.input) + 2 * factBytes() + size({ time: timestamp, transactionId: uuid });
  const read = statementWork(sessionRead.sql, size({ route, session_id: uuid }), point(factBytes()));
  const lock = statementWork(sessionLock.sql, size({ route, session_id: uuid }), point(size({ session_id: uuid })));
  const head = sessionHeadWork({ route, account_id: original.accountId, subject_id: uuid });
  const activity = sessionActivityWork({
    route,
    account_id: original.accountId,
    subject_id: uuid,
    time: timestamp,
    completed: true,
  });
  const gate = sessionShelfWork(route, original.accountId, false);
  if (kind === 'journal') {
    return sumBounds(
      gate,
      lock,
      read,
      statementWork(journalLock.sql, bindBytes, point(journalBytes)),
      statementWork(
        journalUpdate.sql,
        bindBytes,
        point(journalBytes),
        sumBounds(sessionHeapAndIndexes(), sessionTriggers()),
      ),
    );
  }
  const owner = sessionShelfWork(route, original.accountId, true);
  if (kind === 'start') {
    const subjectId = input.subjectId as string;
    const versionId = input.versionSubjectId as string | null;
    const measures = 1 + ((input.additionalMeasures as readonly unknown[] | undefined)?.length ?? 0);
    return sumBounds(
      gate,
      owner,
      head,
      activity,
      repeatBound(sessionSourceWork(subjectId, true), 2),
      ...(versionId !== null && versionId !== subjectId ? [repeatBound(sessionSourceWork(versionId, true), 2)] : []),
      statementWork(
        sessionInsert.sql,
        bindBytes,
        point(sessionBytes),
        sumBounds(sessionHeapAndIndexes(), sessionTriggers()),
      ),
      statementWork(meaningSql, bindBytes + measures * (pinBytes() + size(measure)), {
        keys: measures,
        rows: measures * 2,
        points: measures,
        seeks: measures,
        output: 0,
        rowBytes: 0,
      }),
      statementWork(
        refreshSql,
        size({ route, sessionId: uuid }),
        { keys: 0, rows: 0, points: 0, seeks: 0, output: 1, rowBytes: 4 },
        progressRefresh(),
      ),
    );
  }
  // Record observes original accepted meaning and current Source. Lifecycle
  // operations may have a reviewed binding; retaining that preparation maximum
  // also covers reopen/retire. Clear never reads a new acceptance descriptor.
  const preparation = !preparesSource
    ? sessionBytesWork(0)
    : sumBounds(
        sessionSnapshotWork(original.accountId),
        read,
        repeatBound(sessionSourceWork(uuid, true), 2),
        ...(kind === 'record' && input.clear !== true ? [sessionReleaseWork(pin.releaseDigest)] : []),
      );
  const changes: Bound[] = [];
  if (kind === 'record') {
    if (input.clear === true) {
      changes.push(
        statementWork(
          unitClear.sql,
          size({ route, session_id: uuid }),
          { keys: SESSION_LIMITS.units, rows: 3 * SESSION_LIMITS.units, points: 1, seeks: 1, output: 0, rowBytes: 0 },
          repeatBound(childFence(), SESSION_LIMITS.units),
        ),
      );
    } else {
      const add = (input.add as readonly string[] | undefined)?.length ?? 0;
      const remove = (input.remove as readonly string[] | undefined)?.length ?? 0;
      if (add)
        changes.push(
          statementWork(
            unitAdd.sql,
            size({ route, session_id: uuid, unit_ids: input.add }),
            {
              keys: add,
              rows: 1 + add * 4,
              points: 1 + add * 2,
              seeks: 1 + add,
              output: 1,
              rowBytes: size({ added: 100 }),
            },
            repeatBound(childFence(), add),
          ),
        );
      if (remove)
        changes.push(
          statementWork(
            unitRemove.sql,
            size({ route, session_id: uuid, unit_ids: input.remove }),
            {
              keys: remove,
              rows: remove * 3,
              points: remove,
              seeks: remove,
              output: 1,
              rowBytes: size({ removed: 100 }),
            },
            repeatBound(childFence(), remove),
          ),
        );
    }
  }
  return sumBounds(
    preparation,
    gate,
    owner,
    head,
    activity,
    repeatBound(read, 2),
    lock,
    statementWork(
      sessionUpdate.sql,
      bindBytes,
      point(sessionBytes),
      sumBounds(sessionHeapAndIndexes(), sessionTriggers()),
    ),
    statementWork(changeAppend.sql, bindBytes, { ...point(changeBytes), rows: 3, points: 2 }, childFence()),
    ...changes,
  );
}

export type SessionReadKind =
  | 'read'
  | 'inspect'
  | 'journal-read'
  | 'presentation'
  | 'subject-page'
  | 'owner-page'
  | 'owner-current'
  | 'unit-page'
  | 'change-page';
type ReadInput = Readonly<{ targetId?: string; versionSubjectId?: string | null; limit?: number; cursor?: string }>;
export type SessionReadPlan = Readonly<{
  kind: SessionReadKind;
  original: ReadInput;
  total: Bound;
  run<T>(dispatch: () => Promise<T>): Promise<T>;
}>;

/** The read root includes transaction custody, current owner checks, cursor
 * partition/generation fences, raw sentinels and returned serialization. */
export function sessionReadOperationPlan(kind: SessionReadKind, accountId: string, input: ReadInput): SessionReadPlan {
  const original = retainSessionOperands(input);
  const route = routeOf(accountId)!;
  const targetId = original.targetId ?? uuid;
  const pointInput = size({ route, session_id: targetId });
  const read = statementWork(sessionRead.sql, pointInput, point(factBytes()));
  const legacy = sessionProfileMigrationWork(route, accountId);
  const snapshot = sessionSnapshotWork(accountId);
  const partition = sessionPartitionWork(partitionOf(route));
  const parts: Bound[] = [snapshot, sessionBytesWork(size(original))];
  // seal prefixes two bytes and appends a SHA-256 base64url MAC. All native
  // frontiers fit the timestamp/UUID/unit/generation projection below.
  if (kind.endsWith('page')) {
    const payloadBytes = size({
      e: 2_147_483_647,
      a: [timestamp, uuid, text(128), '-9223372036854775808'],
      t: Number.MAX_SAFE_INTEGER,
    });
    parts.push(sessionBytesWork(4 * Math.ceil((2 + payloadBytes) / 3) + 1 + 43 + size(original)));
  }
  switch (kind) {
    case 'read':
      parts.push(read, legacy, sessionBytesWork(responseSessionBytes));
      break;
    case 'inspect':
      parts.push(read, sessionBytesWork(factBytes()));
      break;
    case 'journal-read':
      parts.push(
        statementWork(
          journalRead.sql,
          size({ route, account_id: accountId, session_id: targetId }),
          point(journalBytes),
        ),
        sessionBytesWork(journalBytes),
      );
      break;
    case 'presentation':
      // The version is read from the original stored fact after the first owner
      // snapshot. Its UUID and native type widths are independent of its value.
      parts.push(
        snapshot,
        repeatBound(read, 2),
        repeatBound(partition, 2),
        repeatBound(sessionReadTimeWork(), 2),
        sessionReleaseWork(pin.releaseDigest),
        repeatBound(sessionSourceWork(uuid, true), 2),
        repeatBound(sessionSourceWork(uuid, false), 2),
        repeatBound(sessionPresentationWork(8), 2),
      );
      break;
    case 'owner-current':
      parts.push(
        partition,
        statementWork(
          discoveryGeneration.sql,
          size({ route, account_id: accountId }),
          point(size({ generation: '-9223372036854775808' })),
        ),
      );
      break;
    case 'owner-page': {
      const limit = original.limit ?? 20;
      parts.push(
        partition,
        legacy,
        statementWork(
          discoveryGeneration.sql,
          size({ route, account_id: accountId }),
          point(size({ generation: '-9223372036854775808' })),
        ),
        statementWork(
          discoveryPage.sql,
          size(original) +
            size({
              route,
              account_id: accountId,
              subject_id: uuid,
              filter_kind: 'subject_profile',
              state_filter: 'completed',
              mode_filter: 'completed_units',
              profile_filter: '',
              after_started_at: timestamp,
              after_session_id: uuid,
              has_cursor: true,
              limit: limit + 1,
            }),
          {
            keys: limit + 1,
            rows: 2 * (limit + 1),
            points: limit + 2,
            seeks: limit + 2,
            output: limit + 1,
            rowBytes: factBytes(),
          },
        ),
        sessionBytesWork(2 + limit * (responseSessionBytes + pinBytes() + 1)),
      );
      break;
    }
    default: {
      const limit = original.limit ?? 20;
      const sent = Math.min(SESSION_LIMITS.page, limit + 1);
      const next = original.cursor !== undefined;
      const binds =
        size(original) +
        size({
          route,
          account_id: accountId,
          subject_id: targetId,
          session_id: targetId,
          after_started_at: timestamp,
          after_session_id: uuid,
          after_unit_id: text(128),
          after_change_no: 2_147_483_647,
          has_cursor: next,
          limit: sent,
        });
      parts.push(partition);
      if (kind === 'subject-page') {
        const ranges = next ? 2 : 1;
        parts.push(
          legacy,
          statementWork(sessionPage.sql, binds, {
            keys: ranges * sent,
            rows: ranges * sent,
            points: ranges,
            seeks: ranges,
            output: sent,
            rowBytes: factBytes(),
          }),
        );
        if (limit === SESSION_LIMITS.page)
          parts.push(
            statementWork(sessionPage.sql, binds, {
              keys: 2,
              rows: 2,
              points: 2,
              seeks: 2,
              output: 1,
              rowBytes: factBytes(),
            }),
          );
        parts.push(sessionBytesWork(2 + limit * (responseSessionBytes + 1)));
      } else {
        const sql = kind === 'unit-page' ? unitPage.sql : changePage.sql;
        const width = kind === 'unit-page' ? unitBytes : changeBytes;
        parts.push(
          read,
          legacy,
          statementWork(sql, binds, { keys: sent, rows: sent, points: 1, seeks: 1, output: sent, rowBytes: width }),
        );
        if (limit === SESSION_LIMITS.page)
          parts.push(statementWork(sql, binds, { keys: 1, rows: 1, points: 1, seeks: 1, output: 1, rowBytes: width }));
        parts.push(sessionBytesWork(2 + limit * (width + 1)));
      }
      break;
    }
  }
  const total = sumBounds(...parts);
  return Object.freeze({
    kind,
    original,
    total,
    run<T>(dispatch: () => Promise<T>) {
      if (enclosingSessionPlan.getStore()) return dispatch();
      return consumeNativeSessionWork(kind, total, () => enclosingSessionPlan.run({ total }, dispatch));
    },
  });
}
