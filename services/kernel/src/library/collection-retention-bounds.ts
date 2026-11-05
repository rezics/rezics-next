import { memoizedValue } from '../memoized.ts';
import { statementBytes } from '../database/statement-bytes.ts';
import { BOUND_AXES, declareBound, repeatBound, sumBounds, withinCeiling, type Bound } from '@rezics/bounds';
import { RELEASE_LIMITS } from '@rezics/definitions';
import accountShare from '../access/account-share.sql';
import commandTime from '../command/time.sql';
import commandFence from '../command/fence.sql';
import commandNoEffectFence from '../command/no-effect-fence.sql';
import readReceipt from '../command/read-receipt.sql';
import { COMMAND_STEP_RETRIES } from '../work/retries.ts';
import { PARTITIONS } from '../route/route.ts';
import { runLibraryBoundedStep } from './command-support.ts';
import { WORK_STEP_DEADLINE_MS } from './work-step-deadline.ts';
import { NATIVE_SOURCE_CUSTODY_RETIREMENT_PAGE_BOUND } from './native-source-custody-bounds.ts';
import collectionRead from './collection-store-collection-read.sql';
import collectionTombstone from './collection-store-collection-tombstone.sql';
import collectionRestoreWindow from './collection-store-collection-restore-window.sql';
import collectionRestore from './collection-store-collection-restore.sql';
import authorizedCollection from './collection-store-collection-authorization.sql';
import collectionDue from './collection-retention-due.sql';
import collectionLock from './collection-retention-lock.sql';
import collectionMembers from './collection-retention-members.sql';
import collectionFacts from './collection-retention-facts.sql';
import collectionState from './collection-retention-state.sql';
import collectionReferences from './collection-retention-references.sql';
import collectionMetadata from './collection-retention-metadata.sql';
import collectionMetadataHistory from './collection-metadata-history-cleanup.sql';
import collectionHead from './collection-retention-head.sql';
import collectionRetireFence from './native-source-custody-retire-fence.sql';
import retentionPartition from './collection-retention-partition.sql';
import terminalScopeQuery from './erasure-scope.sql';
import shelfCounterDelta from './shelf-counter-delta.sql';
import shelfOwnerCollection from './shelf-maintenance-authorized-collection.sql';
import shelfGateEnsure from './shelf-maintenance-gate-ensure.sql';
import shelfGateRead from './shelf-maintenance-gate-read.sql';
import shelfGateLock from './shelf-maintenance-gate-lock.sql';
import shelfGateShare from './shelf-maintenance-gate-share.sql';
import shelfGateSave from './shelf-maintenance-gate-save.sql';
import shelfInputs from './shelf-maintenance-inputs.sql';
import shelfRunCreate from './shelf-maintenance-run-create.sql';
import shelfStepSave from './shelf-maintenance-step-save.sql';
import shelfRunRead from './shelf-maintenance-run-read.sql';
import shelfWriterInitialize from './shelf-counter-owner-initialize.sql';
import shelfWriterRead from './shelf-counter-owner-read.sql';
import shelfWriterComplete from './shelf-counter-owner-complete.sql';
import { PUBLIC_FILTER_COLLECTION_REDUCTION_DECLARATION } from '../semantic/public-filter-collection-reduction-work.ts';
import { shelfMaintenanceStatementPlan } from './shelf-maintenance-bounds.ts';

type Query = Readonly<{ sql: string; params: readonly string[] }>;
type StatementId =
  | 'accountShare'
  | 'commandTime'
  | 'receiptRead'
  | 'commandFence'
  | 'noEffectFence'
  | 'collectionRead'
  | 'authorizedCollection'
  | 'tombstone'
  | 'restoreWindow'
  | 'restore'
  | 'due'
  | 'partition'
  | 'lock'
  | 'members'
  | 'facts'
  | 'state'
  | 'references'
  | 'metadata'
  | 'metadataHistory'
  | 'head'
  | 'retireFence'
  | 'terminalScope';
type SQLShape = Readonly<{
  query: Query;
  maxBinds: Readonly<Record<string, unknown>>;
  candidates: number;
  rows: number;
  points: number;
  emptySeeks: number;
  identityRows?: number;
  witnessKeys?: number;
  projection: Readonly<Record<string, unknown>>;
  projectedRows: number;
  projectionExtraBytes: number;
  bindExtraBytes: number;
}>;

const UUID = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
const ROUTE = 65535;
const INT = 2147483647;
const BIGINT = '9223372036854775807';
const TIMESTAMP = '9999-12-31T23:59:59.999999Z';
const PG_TIMESTAMP = '294276-12-31 23:59:59.999999+00';
const ESCAPED = (characters: number) => '\u0001'.repeat(characters);
const MAX_PAGE = 64;
const MAX_DUE = 8;
const MAX_METADATA_HISTORY = 25;
const MAX_PINS = 100;
const MAX_NATIVE_HOLDS = 80;
const MAX_SEGMENT_ITERATIONS = 32;
const MAX_DURABLE_JSON_BYTES = 4096;
function RETRY_ATTEMPTS() {
  return memoizedValue(RETRY_ATTEMPTS, () => COMMAND_STEP_RETRIES.maxAttempts);
}
const WORKFLOW_NAME = 'library.collectionRetention';
const SEGMENT_WORKFLOW_NAME = 'library.collectionRetention.segment';
const ROW = (row: object, count = 1) => Buffer.byteLength(JSON.stringify(Array.from({ length: count }, () => row)));
const SIZE = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

const collectionRow = Object.freeze({
  id: UUID,
  curatorAccountId: UUID,
  title: ESCAPED(200),
  description: ESCAPED(2000),
  visibility: 'unlisted',
  presentationKind: '',
  coverMediaId: UUID,
  state: 'deleted',
  revision: INT,
  memberCount: INT,
  orderEpoch: INT,
  membershipKind: 'dynamic',
  builtinKind: 'everything',
  hasSavedRule: true,
  createdAt: PG_TIMESTAMP,
  updatedAt: PG_TIMESTAMP,
});
const deletedCollectionRow = Object.freeze({ ...collectionRow, deletionId: UUID });
const dueRow = Object.freeze({
  route: ROUTE,
  collectionId: UUID,
  accountId: UUID,
  deletionId: UUID,
  revision: INT,
  purgeAfter: PG_TIMESTAMP,
});
const lockRow = Object.freeze({
  accountId: UUID,
  revision: INT,
  deletionId: UUID,
  sourceGeneration: BIGINT,
  state: 'deleted',
  deadlineMatches: true,
  due: true,
  sourceCustody: true,
  publicCustody: true,
});
const trueRow = Object.freeze({ removed: true });
const restoreWindowRow = Object.freeze({ revision: INT, deletionId: UUID, deleted: true, expired: true });
const zero = (): Bound =>
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
  });
const dimensions = (part: Partial<Bound>): Bound => declareBound({ ...zero(), ...part });
const maxBound = (...bounds: readonly Bound[]): Bound =>
  declareBound(Object.fromEntries(BOUND_AXES.map((axis) => [axis, Math.max(...bounds.map((bound) => bound[axis]))])));
const plus = (...bounds: readonly Bound[]): Bound => sumBounds(...bounds);
const repeated = (bound: Bound, count: number): Bound => repeatBound(bound, count);

function valuesFor(query: Query, input: Readonly<Record<string, unknown>>): readonly unknown[] {
  return query.params.map((name) => {
    const value = input[name];
    if (value === undefined) throw new TypeError(`Missing Collection retention bind: ${name}`);
    return value;
  });
}

function sqlBound(
  query: Query,
  values: readonly unknown[],
  work: Partial<Bound>,
  projection: Readonly<Record<string, unknown>>,
  projectedRows: number,
  projectionExtraBytes = 0,
  bindExtraBytes = 0,
): Bound {
  if (values.length !== query.params.length || values.some((value) => value === undefined))
    throw new TypeError('Invalid Collection retention statement binds');
  if (!Number.isSafeInteger(projectedRows) || projectedRows < 0)
    throw new TypeError('Invalid Collection retention result ceiling');
  const requestBytes = statementBytes(query) + Buffer.byteLength(JSON.stringify(values)) + bindExtraBytes;
  const projectionBytes = projectedRows ? ROW(projection, projectedRows) + projectionExtraBytes * projectedRows : 0;
  return dimensions({
    ...work,
    statements: 1,
    bytes: requestBytes + projectionBytes,
    engineRequests: 0,
  });
}

function statement(
  query: Query,
  maxBinds: Readonly<Record<string, unknown>>,
  candidates: number,
  rows: number,
  points: number,
  emptySeeks: number,
  projection: Readonly<Record<string, unknown>>,
  projectedRows = rows,
  identityRows = 0,
  witnessKeys = 0,
  projectionExtraBytes = 0,
  bindExtraBytes = 0,
): SQLShape {
  if (!Number.isSafeInteger(candidates + rows + points + emptySeeks + projectedRows))
    throw new TypeError('Collection retention SQL ceiling overflow');
  const shape = Object.freeze({
    query,
    maxBinds: Object.freeze({ ...maxBinds }),
    candidates,
    rows,
    points,
    emptySeeks,
    identityRows,
    witnessKeys,
    projection: Object.freeze({ ...projection }),
    projectedRows,
    projectionExtraBytes,
    bindExtraBytes,
  });
  const maxValues = valuesFor(query, shape.maxBinds);
  shapeBounds.set(
    shape,
    sqlBound(query, maxValues, shapeWork(shape), projection, projectedRows, projectionExtraBytes, bindExtraBytes),
  );
  return shape;
}

const shapeBounds = new WeakMap<SQLShape, Bound>();
function shapeWork(shape: SQLShape): Partial<Bound> {
  return {
    candidateKeys: shape.candidates,
    nativeRows: shape.rows,
    identityMetadataRows: shape.identityRows ?? 0,
    emptySeeks: shape.emptySeeks,
    nativePoints: shape.points,
    witnessKeys: shape.witnessKeys ?? 0,
    engineRequests: 0,
  };
}

function shapes(): Readonly<Record<StatementId, SQLShape>> {
  return memoizedValue(shapes, () =>
    Object.freeze({
      accountShare: statement(accountShare, { route: ROUTE, account_id: UUID }, 1, 1, 1, 1, {
        state: 'deleted',
        fenced: true,
      }),
      commandTime: statement(commandTime, { at: TIMESTAMP }, 1, 1, 1, 1, { at: PG_TIMESTAMP }),
      receiptRead: statement(
        readReceipt,
        {
          partition_no: INT,
          principal_kind: 'account',
          principal_id: UUID,
          command_kind: 'library.collection.restore',
          idempotency_keys: ['x'.repeat(255), ...Array.from({ length: 4 }, () => `rk1.255.${'x'.repeat(43)}`)],
        },
        5,
        1,
        1,
        1,
        {
          requestDigest: 'A'.repeat(44),
          epoch: INT,
          position: BIGINT,
          transactionId: UUID,
          response: deletedCollectionRow,
          payloadState: 'complete',
        },
        1,
        0,
        0,
        RELEASE_LIMITS.bytes - 2,
      ),
      commandFence: statement(
        commandFence,
        {
          partition_no: INT,
          events: [
            {
              id: UUID,
              type: ESCAPED(128),
              subject: UUID,
              data: { collectionId: UUID, deletionId: UUID, removed: INT },
            },
            { id: UUID, type: ESCAPED(128), subject: UUID, data: { collectionId: UUID } },
          ],
          transaction_id: UUID,
          basis: { principal: { kind: 'account', id: UUID }, clientId: UUID, requestedBy: UUID },
          receipt: {
            principal: { kind: 'account', id: UUID },
            kind: 'library.collection.delete',
            key: `rk1.255.${'x'.repeat(43)}`,
            digest: 'A'.repeat(44),
            response: deletedCollectionRow,
          },
        },
        2,
        16,
        8,
        8,
        { epoch: INT, position: BIGINT },
        16,
        0,
        0,
        0,
        RELEASE_LIMITS.bytes - 2,
      ),
      noEffectFence: statement(
        commandNoEffectFence,
        {
          partition_no: INT,
          transaction_id: UUID,
          receipt: {
            principal: { kind: 'account', id: UUID },
            kind: 'library.collection.restore',
            key: `rk1.255.${'x'.repeat(43)}`,
            digest: 'A'.repeat(44),
            response: collectionRow,
          },
        },
        2,
        8,
        4,
        4,
        { epoch: INT, position: BIGINT },
        8,
        0,
        0,
        0,
        RELEASE_LIMITS.bytes - 2,
      ),
      collectionRead: statement(
        collectionRead,
        { route: ROUTE, id: UUID },
        1,
        1,
        1,
        1,
        collectionRow,
        1,
        0,
        0,
        RELEASE_LIMITS.bytes - 2,
      ),
      authorizedCollection: statement(authorizedCollection, { route: ROUTE, collection_id: UUID }, 1, 1, 1, 1, {
        curatorAccountId: UUID,
        visibility: 'unlisted',
        state: 'deleted',
        membershipKind: 'curated',
        builtinKind: null,
        hasSavedRule: true,
      }),
      tombstone: statement(
        collectionTombstone,
        { route: ROUTE, id: UUID, transaction_id: UUID, time: TIMESTAMP },
        1,
        1,
        1,
        1,
        collectionRow,
        1,
        0,
        0,
        RELEASE_LIMITS.bytes - 2,
      ),
      restoreWindow: statement(
        collectionRestoreWindow,
        { route: ROUTE, id: UUID, time: TIMESTAMP },
        1,
        1,
        1,
        1,
        restoreWindowRow,
      ),
      restore: statement(
        collectionRestore,
        { route: ROUTE, id: UUID, revision: INT, deletion_id: UUID, transaction_id: UUID, time: TIMESTAMP },
        1,
        1,
        1,
        1,
        collectionRow,
        1,
        0,
        0,
        RELEASE_LIMITS.bytes - 2,
      ),
      due: statement(
        collectionDue,
        { partition_no: INT, cutoff: TIMESTAMP, after_time: TIMESTAMP, after_route: ROUTE, after_id: UUID },
        MAX_DUE,
        MAX_DUE,
        1,
        1,
        dueRow,
        MAX_DUE,
      ),
      partition: statement(retentionPartition, { partition_no: 4095 }, 1, 1, 1, 1, { write_state: 'initializing' }),
      lock: statement(
        collectionLock,
        { route: ROUTE, collection_id: UUID, purge_after: TIMESTAMP, time: TIMESTAMP },
        4,
        4,
        4,
        4,
        lockRow,
      ),
      members: statement(
        collectionMembers,
        { route: ROUTE, collection_id: UUID },
        MAX_PAGE,
        MAX_PAGE,
        1,
        1,
        trueRow,
        MAX_PAGE,
      ),
      facts: statement(
        collectionFacts,
        { route: ROUTE, collection_id: UUID },
        MAX_PAGE,
        MAX_PAGE,
        1,
        1,
        trueRow,
        MAX_PAGE,
      ),
      state: statement(collectionState, { route: ROUTE, collection_id: UUID }, 1, 1, 1, 1, trueRow),
      references: statement(
        collectionReferences,
        { route: ROUTE, collection_id: UUID },
        MAX_PAGE,
        MAX_PAGE,
        1,
        1,
        trueRow,
        MAX_PAGE,
      ),
      metadata: statement(
        collectionMetadata,
        { route: ROUTE, collection_id: UUID, account_id: UUID },
        2,
        2,
        2,
        2,
        trueRow,
        2,
        0,
      ),
      metadataHistory: statement(
        collectionMetadataHistory,
        { route: ROUTE, collection_id: UUID },
        MAX_METADATA_HISTORY + 1,
        MAX_METADATA_HISTORY + 1,
        2,
        2,
        trueRow,
        MAX_METADATA_HISTORY + 1,
      ),
      head: statement(
        collectionHead,
        { route: ROUTE, collection_id: UUID, account_id: UUID, revision: INT, source_generation: BIGINT },
        1,
        1,
        11,
        10,
        trueRow,
        1,
      ),
      retireFence: statement(
        collectionRetireFence,
        { route: ROUTE, collection_id: UUID, account_id: UUID },
        3,
        1,
        3,
        2,
        trueRow,
      ),
      terminalScope: statement(terminalScopeQuery, { route: ROUTE, account_id: UUID }, 1, 1, 1, 1, {
        version: BIGINT,
        outcome: ESCAPED(32),
      }),
    }),
  );
}

function runtimeStatementBound(id: StatementId, input: Readonly<Record<string, unknown>>): Bound {
  const shape = shapes()[id];
  const actual = sqlBound(
    shape.query,
    valuesFor(shape.query, input),
    shapeWork(shape),
    shape.projection,
    shape.projectedRows,
    shape.projectionExtraBytes,
  );
  const bound = plus(actual, statementAdditionalWork(id));
  const ceiling = statementOperationBound(id);
  if (!withinCeiling(bound, ceiling)) throw new TypeError(`Collection retention SQL exceeds its bind ceiling: ${id}`);
  return bound;
}

const control = (sql: string) => sqlBound({ sql, params: [] }, [], { statements: 1, engineRequests: 0 }, {}, 0);
function begin() {
  return memoizedValue(begin, () => control('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'));
}
function commandBegin() {
  return memoizedValue(commandBegin, () => control('BEGIN ISOLATION LEVEL SERIALIZABLE'));
}
function lockTimeout() {
  return memoizedValue(lockTimeout, () => control("SET LOCAL lock_timeout = '200ms'"));
}
function discoveryTimeout() {
  return memoizedValue(discoveryTimeout, () => control("SET LOCAL statement_timeout = '5000ms'"));
}
function commandTimeout() {
  return memoizedValue(commandTimeout, () => control(`SET LOCAL statement_timeout = '${WORK_STEP_DEADLINE_MS}ms'`));
}
function commit() {
  return memoizedValue(commit, () => control('COMMIT'));
}
function rollback() {
  return memoizedValue(rollback, () => control('ROLLBACK'));
}
function checkout() {
  return memoizedValue(checkout, () => dimensions({ nativePoints: 1 }));
}
function nativePage() {
  return memoizedValue(nativePage, () => NATIVE_SOURCE_CUSTODY_RETIREMENT_PAGE_BOUND());
}

// One member DELETE reaches: retained-parent lookup (1), order guard (parent + repair +
// optionally account and repair update, 4), export fence (account owner write, 1), native
// collection fence (1), history delete (up to 32 rows) and one history-head update for each
// returned collection (up to 32). A member occurrence has at most 16 transaction groups and
// two history rows per group. These are SQL statements inside the trigger, not extra client calls.
function memberTrigger() {
  return memoizedValue(memberTrigger, () =>
    dimensions({
      candidateKeys: 72,
      nativeRows: 72,
      nativePoints: 41,
      emptySeeks: 2,
      statements: 41,
    }),
  );
}
// The final parent delete cascades to at most one order-repair row, one structure-history head
// and the Collection's 1,000 retained structure-history rows.
function structureCascade() {
  return memoizedValue(structureCascade, () =>
    dimensions({ candidateKeys: 1002, nativeRows: 1002, nativePoints: 1, statements: 1 }),
  );
}
// Removing a current pin updates one account row and its native-source trigger advances the
// account fence for both the old and new row versions. Other pin occurrences stay in the array.
function metadataTriggers() {
  return memoizedValue(metadataTriggers, () =>
    dimensions({ candidateKeys: 2, nativeRows: 2, nativePoints: 2, statements: 2 }),
  );
}
function statementAdditionalWork(id: StatementId): Bound {
  switch (id) {
    case 'members':
      return repeated(memberTrigger(), MAX_PAGE);
    case 'metadata':
      return metadataTriggers();
    case 'head':
      return structureCascade();
    case 'tombstone':
      return tombstoneTriggers();
    case 'restore':
      return restoreTriggers();
    default:
      return zero();
  }
}
function statementOperationBound(id: StatementId): Bound {
  return plus(shapeBounds.get(shapes()[id])!, statementAdditionalWork(id));
}
function memberPage() {
  return memoizedValue(memberPage, () => statementOperationBound('members'));
}
function factPage() {
  return memoizedValue(factPage, () => shapeBounds.get(shapes().facts)!);
}
function statePage() {
  return memoizedValue(statePage, () => shapeBounds.get(shapes().state)!);
}
function referencePage() {
  return memoizedValue(referencePage, () => shapeBounds.get(shapes().references)!);
}
function metadataPage() {
  return memoizedValue(metadataPage, () => statementOperationBound('metadata'));
}
function historyPage() {
  return memoizedValue(historyPage, () => shapeBounds.get(shapes().metadataHistory)!);
}
// Every reached probe consumes its immutable SQL/page ceiling before dispatch. An empty result
// retains the same projection ceiling and indexed seek; rowCount cannot refund the declaration.
function memberProbe() {
  return memoizedValue(memberProbe, () => memberPage());
}
function factsProbe() {
  return memoizedValue(factsProbe, () => shapeBounds.get(shapes().facts)!);
}
function stateProbe() {
  return memoizedValue(stateProbe, () => shapeBounds.get(shapes().state)!);
}
function referenceProbe() {
  return memoizedValue(referenceProbe, () => shapeBounds.get(shapes().references)!);
}
function metadataProbe() {
  return memoizedValue(metadataProbe, () => metadataPage());
}
function historyProbe() {
  return memoizedValue(historyProbe, () => shapeBounds.get(shapes().metadataHistory)!);
}
function factProgress() {
  return memoizedValue(factProgress, () => plus(memberProbe(), factPage()));
}
function stateProgress() {
  return memoizedValue(stateProgress, () => plus(memberProbe(), factsProbe(), statePage()));
}
function referenceProgress() {
  return memoizedValue(referenceProgress, () => plus(memberProbe(), factsProbe(), stateProbe(), referencePage()));
}
function metadataProgress() {
  return memoizedValue(metadataProgress, () =>
    plus(memberProbe(), factsProbe(), stateProbe(), referenceProbe(), metadataPage()),
  );
}
function historyProgress() {
  return memoizedValue(historyProgress, () =>
    plus(memberProbe(), factsProbe(), stateProbe(), referenceProbe(), metadataProbe(), historyPage()),
  );
}
function headProgress() {
  return memoizedValue(headProgress, () =>
    plus(
      memberProbe(),
      factsProbe(),
      stateProbe(),
      referenceProbe(),
      metadataProbe(),
      historyProbe(),
      statementOperationBound('head'),
      dimensions({ candidateKeys: 8, nativeRows: 8, nativePoints: 8, emptySeeks: 2, statements: 8 }),
      shapeBounds.get(shapes().retireFence)!,
    ),
  );
}
function childProgress() {
  return memoizedValue(childProgress, () =>
    maxBound(memberPage(), factProgress(), stateProgress(), referenceProgress(), metadataProgress(), historyProgress()),
  );
}
function cleanupPage() {
  return memoizedValue(cleanupPage, () => maxBound(childProgress(), headProgress()));
}
function lockOnce() {
  return memoizedValue(lockOnce, () =>
    plus(
      checkout(),
      commandBegin(),
      lockTimeout(),
      commandTimeout(),
      shapeBounds.get(shapes().commandTime)!,
      shapeBounds.get(shapes().accountShare)!,
      shapeBounds.get(shapes().lock)!,
    ),
  );
}
function finalCommandTimeout() {
  return memoizedValue(finalCommandTimeout, () =>
    control(`SET LOCAL statement_timeout = '${WORK_STEP_DEADLINE_MS}ms'`),
  );
}
function committedEvent() {
  return memoizedValue(committedEvent, () =>
    plus(finalCommandTimeout(), shapeBounds.get(shapes().commandFence)!, commit()),
  );
}
function noEffectCompletion() {
  return memoizedValue(noEffectCompletion, () =>
    plus(finalCommandTimeout(), shapeBounds.get(shapes().noEffectFence)!, commit()),
  );
}
function failedCommand() {
  return memoizedValue(failedCommand, () => plus(rollback()));
}
// Native capture retirement and local child cleanup are sequential alternatives. When a native
// page removes work it returns before the local page; only a retired/empty capture can proceed.
function removeLocalFresh() {
  return memoizedValue(removeLocalFresh, () => plus(lockOnce(), cleanupPage(), committedEvent()));
}
function removeCaptureProgress() {
  return memoizedValue(removeCaptureProgress, () => plus(lockOnce(), nativePage(), committedEvent()));
}
function removeCaptureThenLocal() {
  return memoizedValue(removeCaptureThenLocal, () => plus(lockOnce(), nativePage(), cleanupPage(), committedEvent()));
}
function removeFresh() {
  return memoizedValue(removeFresh, () =>
    maxBound(removeLocalFresh(), removeCaptureProgress(), removeCaptureThenLocal()),
  );
}
function removeNoEffect() {
  return memoizedValue(removeNoEffect, () => plus(lockOnce(), noEffectCompletion()));
}
function removeRetained() {
  return memoizedValue(removeRetained, () =>
    maxBound(removeNoEffect(), plus(lockOnce(), nativePage(), noEffectCompletion())),
  );
}
function removeFailedAfterWork() {
  return memoizedValue(removeFailedAfterWork, () =>
    maxBound(
      plus(lockOnce(), cleanupPage(), rollback()),
      plus(lockOnce(), nativePage(), cleanupPage(), rollback()),
      plus(lockOnce(), cleanupPage(), finalCommandTimeout(), shapeBounds.get(shapes().commandFence)!, rollback()),
      plus(
        lockOnce(),
        nativePage(),
        cleanupPage(),
        finalCommandTimeout(),
        shapeBounds.get(shapes().commandFence)!,
        rollback(),
      ),
      plus(lockOnce(), nativePage(), finalCommandTimeout(), shapeBounds.get(shapes().commandFence)!, rollback()),
    ),
  );
}
function removeCommandAttempt() {
  return memoizedValue(removeCommandAttempt, () =>
    maxBound(removeFresh(), removeNoEffect(), removeRetained(), failedCommand(), removeFailedAfterWork()),
  );
}
function stepHistory() {
  return memoizedValue(stepHistory, () => dimensions({ bytes: 2 * MAX_DURABLE_JSON_BYTES }));
}
function removeDBOSStep() {
  return memoizedValue(removeDBOSStep, () =>
    plus(
      repeated(plus(removeCommandAttempt(), stepHistory()), RETRY_ATTEMPTS()),
      dimensions({ engineRequests: RETRY_ATTEMPTS() }),
    ),
  );
}
function discoveryAvailable() {
  return memoizedValue(discoveryAvailable, () =>
    plus(
      checkout(),
      begin(),
      discoveryTimeout(),
      shapeBounds.get(shapes().partition)!,
      shapeBounds.get(shapes().due)!,
      commit(),
    ),
  );
}
function discoveryEmpty() {
  return memoizedValue(discoveryEmpty, () =>
    plus(
      checkout(),
      begin(),
      discoveryTimeout(),
      shapeBounds.get(shapes().partition)!,
      shapeBounds.get(shapes().due)!,
      commit(),
    ),
  );
}
function discoveryPending() {
  return memoizedValue(discoveryPending, () =>
    plus(checkout(), begin(), discoveryTimeout(), shapeBounds.get(shapes().partition)!, commit()),
  );
}
function discoveryFailed() {
  return memoizedValue(discoveryFailed, () =>
    plus(checkout(), begin(), discoveryTimeout(), shapeBounds.get(shapes().partition)!, rollback()),
  );
}
function discoveryFailedAfterDue() {
  return memoizedValue(discoveryFailedAfterDue, () =>
    plus(
      checkout(),
      begin(),
      discoveryTimeout(),
      shapeBounds.get(shapes().partition)!,
      shapeBounds.get(shapes().due)!,
      rollback(),
    ),
  );
}
function discoveryAttempt() {
  return memoizedValue(discoveryAttempt, () =>
    maxBound(discoveryAvailable(), discoveryPending(), discoveryFailed(), discoveryFailedAfterDue()),
  );
}
function discoveryStep() {
  return memoizedValue(discoveryStep, () =>
    plus(
      repeated(plus(discoveryAttempt(), stepHistory()), RETRY_ATTEMPTS()),
      dimensions({ engineRequests: RETRY_ATTEMPTS() }),
    ),
  );
}
const continueRequestBytes = SIZE({
  workflowName: SEGMENT_WORKFLOW_NAME,
  queueName: 'maintenance',
  workflowID: `${WORKFLOW_NAME}:${UUID}:${INT}`,
  workflowIDReusePolicy: 'return-existing',
});
const segmentPayloadBytes = MAX_DURABLE_JSON_BYTES;
function continuationEnqueue() {
  return memoizedValue(continuationEnqueue, () =>
    dimensions({
      engineRequests: RETRY_ATTEMPTS(),
      bytes: RETRY_ATTEMPTS() * (continueRequestBytes + segmentPayloadBytes),
    }),
  );
}
function continuationStep() {
  return memoizedValue(continuationStep, () =>
    plus(repeated(stepHistory(), RETRY_ATTEMPTS()), dimensions({ engineRequests: RETRY_ATTEMPTS() })),
  );
}
function cutoffStep() {
  return memoizedValue(cutoffStep, () => dimensions({ engineRequests: 1, bytes: SIZE(TIMESTAMP) }));
}
function segmentIteration() {
  return memoizedValue(segmentIteration, () => maxBound(discoveryStep(), removeDBOSStep()));
}
function segment() {
  return memoizedValue(segment, () =>
    plus(
      dimensions({ bytes: segmentPayloadBytes }),
      repeated(segmentIteration(), MAX_SEGMENT_ITERATIONS),
      continuationStep(),
      continuationEnqueue(),
    ),
  );
}
function publicReductionFull() {
  return memoizedValue(publicReductionFull, () => PUBLIC_FILTER_COLLECTION_REDUCTION_DECLARATION().cost);
}
function shelfCounterPlan() {
  return memoizedValue(shelfCounterPlan, () =>
    shelfMaintenanceStatementPlan(shelfCounterDelta.sql, [
      ROUTE,
      UUID,
      UUID,
      [{ bucket: 'collections', type_id: '00000000-0000-0000-0000-000000000000', delta: -1 }],
    ])!,
  );
}
function shelfCounter() {
  return memoizedValue(shelfCounter, () => shelfCounterPlan().total);
}
function shelfStatement(query: Query, values: Readonly<Record<string, unknown>>): Bound {
  const plan = shelfMaintenanceStatementPlan(
    query.sql,
    query.params.map((name) => values[name]),
  );
  if (!plan) throw new TypeError('Collection retention could not compose the existing Shelf SQL owner');
  return plan.total;
}

const shelfOwnerValues = Object.freeze({
  route: ROUTE,
  account_id: UUID,
  collection_id: UUID,
  run_id: UUID,
  fence_id: UUID,
  epoch: BIGINT,
  kind: 'backfill',
  phase: 'drain',
  build_generation: null,
  mode: 'open',
  ready: true,
  active_generation: UUID,
  sequence: BIGINT,
  segment: INT,
  cursor: [],
  generation_id: UUID,
});
function shelfOwnerAuthority() {
  return memoizedValue(shelfOwnerAuthority, () => shelfStatement(shelfOwnerCollection, shelfOwnerValues));
}
function shelfAccountShare() {
  return memoizedValue(shelfAccountShare, () => shelfStatement(accountShare, shelfOwnerValues));
}
function shelfGateReadCost() {
  return memoizedValue(shelfGateReadCost, () => shelfStatement(shelfGateRead, shelfOwnerValues));
}
function shelfGateEnsureCost() {
  return memoizedValue(shelfGateEnsureCost, () => shelfStatement(shelfGateEnsure, shelfOwnerValues));
}
function shelfGateLockCost() {
  return memoizedValue(shelfGateLockCost, () => shelfStatement(shelfGateLock, shelfOwnerValues));
}
function shelfGateShareCost() {
  return memoizedValue(shelfGateShareCost, () => shelfStatement(shelfGateShare, shelfOwnerValues));
}
function shelfGateSaveCost() {
  return memoizedValue(shelfGateSaveCost, () => shelfStatement(shelfGateSave, shelfOwnerValues));
}
function shelfInputsCost() {
  return memoizedValue(shelfInputsCost, () => shelfStatement(shelfInputs, shelfOwnerValues));
}
function shelfRunCreateCost() {
  return memoizedValue(shelfRunCreateCost, () => shelfStatement(shelfRunCreate, shelfOwnerValues));
}
function shelfStepSaveCost() {
  return memoizedValue(shelfStepSaveCost, () => shelfStatement(shelfStepSave, shelfOwnerValues));
}
function shelfRunReadCost() {
  return memoizedValue(shelfRunReadCost, () => shelfStatement(shelfRunRead, shelfOwnerValues));
}
function shelfWriterInitializeCost() {
  return memoizedValue(shelfWriterInitializeCost, () => shelfStatement(shelfWriterInitialize, shelfOwnerValues));
}
function shelfWriterReadCost() {
  return memoizedValue(shelfWriterReadCost, () => shelfStatement(shelfWriterRead, shelfOwnerValues));
}
function shelfWriterCompleteCost() {
  return memoizedValue(shelfWriterCompleteCost, () => shelfStatement(shelfWriterComplete, shelfOwnerValues));
}
function shelfWriterEntry() {
  return memoizedValue(shelfWriterEntry, () =>
    plus(shelfWriterInitializeCost(), shelfWriterReadCost(), shelfWriterCompleteCost(), shelfWriterReadCost()),
  );
}
function shelfEntryPrefix() {
  return memoizedValue(shelfEntryPrefix, () => plus(shelfOwnerAuthority(), shelfAccountShare()));
}
function shelfEntryStable() {
  return memoizedValue(shelfEntryStable, () =>
    plus(
      shelfEntryPrefix(),
      shelfGateReadCost(),
      shelfGateShareCost(),
      shelfRunReadCost(),
      shelfGateShareCost(),
      shelfWriterEntry(),
    ),
  );
}
function shelfEntryInitializeReady() {
  return memoizedValue(shelfEntryInitializeReady, () =>
    plus(
      shelfEntryPrefix(),
      shelfGateReadCost(),
      shelfGateEnsureCost(),
      shelfGateLockCost(),
      shelfInputsCost(),
      shelfGateSaveCost(),
      shelfGateShareCost(),
      shelfGateShareCost(),
      shelfWriterEntry(),
    ),
  );
}
function shelfEntryInitializeBackfill() {
  return memoizedValue(shelfEntryInitializeBackfill, () =>
    plus(
      shelfEntryPrefix(),
      shelfGateReadCost(),
      shelfGateEnsureCost(),
      shelfGateLockCost(),
      shelfInputsCost(),
      shelfRunCreateCost(),
      shelfGateSaveCost(),
      shelfStepSaveCost(),
      shelfRunReadCost(),
      shelfGateShareCost(),
      shelfRunReadCost(),
      shelfGateShareCost(),
      shelfWriterEntry(),
    ),
  );
}
function shelfEntry() {
  return memoizedValue(shelfEntry, () =>
    maxBound(shelfEntryStable(), shelfEntryInitializeReady(), shelfEntryInitializeBackfill()),
  );
}
// Collection writes also run the installed order, public-output and native-source triggers.
// Tombstoning skips the hold probe on the active->deleted transition; exact Undo performs two
// parent/core/hold checks because deleted->active is the guarded transition.
function tombstoneTriggers() {
  return memoizedValue(tombstoneTriggers, () =>
    dimensions({
      candidateKeys: 11,
      nativeRows: 11,
      nativePoints: 11,
      emptySeeks: 1,
      statements: 11,
    }),
  );
}
function restoreTriggers() {
  return memoizedValue(restoreTriggers, () =>
    dimensions({
      candidateKeys: 13,
      nativeRows: 11,
      nativePoints: 13,
      emptySeeks: 3,
      statements: 13,
    }),
  );
}
function deleteBody() {
  return memoizedValue(deleteBody, () =>
    plus(
      repeated(shapeBounds.get(shapes().collectionRead)!, 2),
      shelfEntry(),
      statementOperationBound('tombstone'),
      shelfEntry(),
      shelfCounter(),
    ),
  );
}
function restoreBody() {
  return memoizedValue(restoreBody, () =>
    plus(shapeBounds.get(shapes().restoreWindow)!, statementOperationBound('restore'), shelfEntry(), shelfCounter()),
  );
}
function actorBase() {
  return memoizedValue(actorBase, () =>
    plus(
      checkout(),
      commandBegin(),
      lockTimeout(),
      commandTimeout(),
      shapeBounds.get(shapes().commandTime)!,
      shapeBounds.get(shapes().accountShare)!,
      shapeBounds.get(shapes().receiptRead)!,
      repeated(shapeBounds.get(shapes().authorizedCollection)!, 2),
    ),
  );
}
function actorDeletePrivateBody() {
  return memoizedValue(actorDeletePrivateBody, () =>
    plus(actorBase(), shapeBounds.get(shapes().authorizedCollection)!, shelfEntry(), deleteBody()),
  );
}
function actorDeleteListedBody() {
  return memoizedValue(actorDeleteListedBody, () => plus(actorDeletePrivateBody(), publicReductionFull()));
}
function actorDeletePrivate() {
  return memoizedValue(actorDeletePrivate, () => plus(actorDeletePrivateBody(), committedEvent()));
}
function actorDeleteListed() {
  return memoizedValue(actorDeleteListed, () => plus(actorDeleteListedBody(), committedEvent()));
}
function actorDeleteReplay() {
  return memoizedValue(actorDeleteReplay, () => plus(actorBase(), commit()));
}
function actorDeleteStale() {
  return memoizedValue(actorDeleteStale, () =>
    plus(
      actorBase(),
      shapeBounds.get(shapes().authorizedCollection)!,
      shelfEntry(),
      shelfEntry(),
      repeated(shapeBounds.get(shapes().collectionRead)!, 2),
      rollback(),
    ),
  );
}
function actorDeleteStaleCas() {
  return memoizedValue(actorDeleteStaleCas, () =>
    plus(
      actorBase(),
      shapeBounds.get(shapes().authorizedCollection)!,
      shelfEntry(),
      repeated(shapeBounds.get(shapes().collectionRead)!, 2),
      shelfEntry(),
      statementOperationBound('tombstone'),
      rollback(),
    ),
  );
}
function actorDeleteRollback() {
  return memoizedValue(actorDeleteRollback, () =>
    maxBound(
      plus(actorDeletePrivateBody(), rollback()),
      plus(actorDeleteListedBody(), rollback()),
      plus(actorDeleteListedBody(), finalCommandTimeout(), shapeBounds.get(shapes().commandFence)!, rollback()),
    ),
  );
}
function actorDelete() {
  return memoizedValue(actorDelete, () =>
    maxBound(
      actorDeletePrivate(),
      actorDeleteListed(),
      actorDeleteReplay(),
      actorDeleteStale(),
      actorDeleteStaleCas(),
      actorDeleteRollback(),
      plus(actorBase(), rollback()),
    ),
  );
}
function actorUndoFreshBody() {
  return memoizedValue(actorUndoFreshBody, () =>
    plus(actorBase(), shapeBounds.get(shapes().authorizedCollection)!, shelfEntry(), restoreBody()),
  );
}
function actorUndoFresh() {
  return memoizedValue(actorUndoFresh, () => plus(actorUndoFreshBody(), committedEvent()));
}
function actorUndoReplay() {
  return memoizedValue(actorUndoReplay, () => plus(actorBase(), commit()));
}
function actorUndoStaleOrExpired() {
  return memoizedValue(actorUndoStaleOrExpired, () =>
    plus(
      actorBase(),
      shapeBounds.get(shapes().authorizedCollection)!,
      shelfEntry(),
      shapeBounds.get(shapes().restoreWindow)!,
      rollback(),
    ),
  );
}
function actorUndoStaleCas() {
  return memoizedValue(actorUndoStaleCas, () =>
    plus(
      actorBase(),
      shapeBounds.get(shapes().authorizedCollection)!,
      shelfEntry(),
      shapeBounds.get(shapes().restoreWindow)!,
      statementOperationBound('restore'),
      rollback(),
    ),
  );
}
function actorUndoRollback() {
  return memoizedValue(actorUndoRollback, () =>
    maxBound(
      plus(actorUndoFreshBody(), rollback()),
      plus(actorUndoFreshBody(), finalCommandTimeout(), shapeBounds.get(shapes().commandFence)!, rollback()),
    ),
  );
}
function actorUndo() {
  return memoizedValue(actorUndo, () =>
    maxBound(
      actorUndoFresh(),
      actorUndoReplay(),
      actorUndoStaleOrExpired(),
      actorUndoStaleCas(),
      actorUndoRollback(),
      plus(actorBase(), rollback()),
    ),
  );
}
function mountedDelete() {
  return memoizedValue(mountedDelete, () =>
    dimensions({
      bytes: SIZE({ status: 204, cacheControl: 'private, no-store', deletionId: UUID, revision: INT }),
    }),
  );
}
const mountedRestoreCollection = Object.freeze({
  id: UUID,
  curatorAccountId: UUID,
  title: ESCAPED(200),
  description: ESCAPED(2000),
  visibility: 'unlisted',
  membershipKind: 'curated',
  revision: INT,
  memberCount: INT,
  orderEpoch: INT,
  createdAt: PG_TIMESTAMP,
  updatedAt: PG_TIMESTAMP,
  presentationKind: '',
  presentationKindSource: 'owner',
  cover: {
    media: UUID,
    width: INT,
    height: INT,
    placeholder: { thumbhash: 'x'.repeat(44), color: '#ffffff' },
    variants: Array.from({ length: 12 }, () => ({ format: 'webp', width: INT })),
    focalPoint: { x: 1, y: 1 },
    credit: null,
  },
  coverSource: 'owner',
  coverMediaId: UUID,
});
// Content admits at most 12 variants and validates serialized cover credit to 8192 bytes.
// The empty Definition key and null credit reserve their exact replaced JSON-token sizes.
function mountedRestore() {
  return memoizedValue(mountedRestore, () =>
    dimensions({
      bytes: SIZE({ collection: mountedRestoreCollection }) + RELEASE_LIMITS.bytes - 2 + 8192 - SIZE(null),
    }),
  );
}
function terminal() {
  return memoizedValue(terminal, () => maxBound(cleanupPage(), plus(nativePage(), cleanupPage())));
}

function paths() {
  return memoizedValue(paths, () =>
    Object.freeze({
      deleteCommand: actorDelete(),
      restoreCommand: actorUndo(),
      deleteResponse: mountedDelete(),
      restoreResponse: mountedRestore(),
      shelfEntry: shelfEntry(),
      shelfCounter: shelfCounter(),
      duePage: shapeBounds.get(shapes().due)!,
      cleanupPage: cleanupPage(),
      removeCommand: removeCommandAttempt(),
      discoveryStep: discoveryStep(),
      removeStep: removeDBOSStep(),
      retainedStep: repeated(removeRetained(), RETRY_ATTEMPTS()),
      emptyDiscoveryStep: plus(
        repeated(plus(discoveryEmpty(), stepHistory()), RETRY_ATTEMPTS()),
        dimensions({ engineRequests: RETRY_ATTEMPTS() }),
      ),
      segment: segment(),
      continuationStep: continuationStep(),
      continuationEnqueue: continuationEnqueue(),
      terminalSharedCleanup: terminal(),
      publicReduction: publicReductionFull(),
      cutoffStep: cutoffStep(),
    }),
  );
}

function deepFreeze<T extends Record<string, unknown>>(value: T): Readonly<T> {
  for (const child of Object.values(value))
    if (child && typeof child === 'object' && !Object.isFrozen(child)) deepFreeze(child as Record<string, unknown>);
  return Object.freeze(value);
}

export function COLLECTION_RETENTION_OPERATION_PLAN() {
  return memoizedValue(COLLECTION_RETENTION_OPERATION_PLAN, () =>
    deepFreeze({
      version: 1 as const,
      owner: 'Library' as const,
      axes: BOUND_AXES,
      limits: Object.freeze({
        dueKeys: MAX_DUE,
        childRows: MAX_PAGE,
        metadataHistoryRows: MAX_METADATA_HISTORY,
        pinRows: MAX_PINS,
        nativeHoldRows: MAX_NATIVE_HOLDS,
        segmentIterations: MAX_SEGMENT_ITERATIONS,
        segmentPartitions: PARTITIONS,
        durableJsonBytes: MAX_DURABLE_JSON_BYTES,
        dbosAttempts: RETRY_ATTEMPTS(),
        restoreWindowHours: 720,
        maintenanceSchedule: '*/10 * * * *',
      }),
      declarations: Object.freeze({
        statements: Object.fromEntries(Object.entries(shapes()).map(([id, shape]) => [id, shapeBounds.get(shape)])),
        nestedOwners: Object.freeze({
          publicFilterCollectionReduction: PUBLIC_FILTER_COLLECTION_REDUCTION_DECLARATION(),
          shelf: Object.freeze({
            entry: shelfEntry(),
            counterDelta: shelfCounterPlan(),
            statementOwner: 'shelfMaintenanceStatementPlan',
          }),
        }),
        paths: paths(),
      }),
      ceilings: Object.freeze({
        deleteCommand: actorDelete(),
        restoreCommand: actorUndo(),
        deleteResponse: mountedDelete(),
        restoreResponse: mountedRestore(),
        discoveryStep: discoveryStep(),
        removeStep: removeDBOSStep(),
        segment: segment(),
        continuationStep: continuationStep(),
        continuationEnqueue: continuationEnqueue(),
        terminalSharedCleanup: terminal(),
        cutoffStep: cutoffStep(),
        perCleanupPage: cleanupPage(),
        perNativeRetirementPage: nativePage(),
      }),
      branches: Object.freeze({
        freshDelete: actorDeletePrivate(),
        listedDelete: actorDeleteListed(),
        replayDelete: actorDeleteReplay(),
        exactUndo: actorUndoFresh(),
        replayUndo: actorUndoReplay(),
        staleDelete: actorDeleteStale(),
        staleDeleteCAS: actorDeleteStaleCas(),
        staleOrExpiredUndo: actorUndoStaleOrExpired(),
        staleUndoCAS: actorUndoStaleCas(),
        failedDeleteRollback: actorDeleteRollback(),
        failedUndoRollback: actorUndoRollback(),
        staleOrNotDue: removeNoEffect(),
        memberProgress: memberPage(),
        factProgress: factProgress(),
        canonicalStateProgress: stateProgress(),
        referenceProgress: referenceProgress(),
        metadataProgress: metadataProgress(),
        metadataHistoryProgress: historyProgress(),
        headPurged: headProgress(),
        pendingDiscovery: discoveryPending(),
        emptyDiscovery: discoveryEmpty(),
        failedDiscoveryRollback: discoveryFailed(),
        staleRemoval: removeNoEffect(),
        notDueRemoval: removeNoEffect(),
        retained: removeRetained(),
        purged: removeLocalFresh(),
        nativeCaptureProgress: removeCaptureProgress(),
        failedRemovalRollback: removeFailedAfterWork(),
        continuationEnqueue: continuationEnqueue(),
      }),
    }),
  );
}

export type CollectionRetentionPath = keyof ReturnType<typeof paths>;

/** Check the immutable owner ceiling before the existing execution begins. No authority or allowance is added. */
export function withCollectionRetentionDeclaration<T>(path: CollectionRetentionPath, dispatch: () => T): T {
  const cost = paths()[path];
  if (!withinCeiling(cost, cost)) throw new TypeError('Invalid Collection retention plan');
  return dispatch();
}

/** Bind a durable DBOS step/enqueue call to its existing engine-request ceiling. */
export function withCollectionRetentionEngineRequest<T>(path: CollectionRetentionPath, dispatch: () => T): T {
  const cost = paths()[path];
  if (cost.engineRequests < 1 || !withinCeiling(cost, cost))
    throw new TypeError('Collection retention engine request exceeds its owner declaration');
  return dispatch();
}

/** Bind the actual occurrence's SQL, ordered serialized operands, schema projection and result cap. */
export function executeCollectionRetentionQuery<Client, Input extends object, Result>(
  id: StatementId,
  query: Readonly<{ sql: string; params: readonly string[]; run(client: Client, input: Input): Promise<Result> }>,
  client: Client,
  input: Input,
): Promise<Result> {
  const shape = shapes()[id];
  if (shape.query.sql !== query.sql) throw new TypeError(`Collection retention owner/query mismatch: ${id}`);
  const bound = runtimeStatementBound(id, input as Readonly<Record<string, unknown>>);
  if (bound.engineRequests !== 0) throw new TypeError('Collection retention SQL cannot consume engine requests');
  return runLibraryBoundedStep(`library.collection-retention.${id}`, bound, () => query.run(client, input));
}

/** Bind BEGIN/COMMIT/ROLLBACK and fixed SET controls with their actual SQL bytes. */
export function executeCollectionRetentionControl<T>(
  operation: 'discover.begin' | 'discover.timeout' | 'discover.commit' | 'discover.rollback',
  dispatch: (sql: string) => Promise<T>,
): Promise<T> {
  const sql = {
    'discover.begin': 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY',
    'discover.timeout': "SET LOCAL statement_timeout = '5000ms'",
    'discover.commit': 'COMMIT',
    'discover.rollback': 'ROLLBACK',
  }[operation];
  const bound = control(sql);
  if (bound.engineRequests !== 0) throw new TypeError('Collection retention SQL cannot consume engine requests');
  return runLibraryBoundedStep(`library.collection-retention.${operation}`, bound, () => dispatch(sql));
}

/** Export the pure arithmetic projection for tests and owner composition. */
export function collectionRetentionMaximumStatement(id: StatementId): Bound {
  return shapeBounds.get(shapes()[id])!;
}

export function COLLECTION_RETENTION_DBOS_ATTEMPTS() {
  return memoizedValue(COLLECTION_RETENTION_DBOS_ATTEMPTS, () => RETRY_ATTEMPTS());
}
export function COLLECTION_RETENTION_SEGMENT_BOUND() {
  return memoizedValue(COLLECTION_RETENTION_SEGMENT_BOUND, () => segment());
}
export function COLLECTION_RETENTION_SQL_AXES() {
  return memoizedValue(COLLECTION_RETENTION_SQL_AXES, () => BOUND_AXES);
}
