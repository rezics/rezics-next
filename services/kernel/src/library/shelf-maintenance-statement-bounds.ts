import { memoizedValue } from '../memoized.ts';
/** Library-owned declarations. A declaration prices dispatch; it is never run authority. */
import { declareBound, repeatBound, sumBounds, type Bound } from '@rezics/bounds';
import commandTime from '../command/time.sql';
import commandFence from '../command/fence.sql';
import commandNoEffect from '../command/no-effect-fence.sql';
import commandReceipt from '../command/read-receipt.sql';
import type { WorkDimensions } from './contract/work-dimensions.ts';
import sourceSize from './shelf-maintenance-source-size.sql';
import rootSize from './shelf-maintenance-root-size.sql';
import retirementSize from './shelf-maintenance-retirement-size.sql';
import partitionRead from '../partition/read.sql';
import identityRead from '../semantic/read-item-identity-version.sql';
import typesRead from '../semantic/read-item-types.sql';
import counterDelta from './shelf-counter-delta.sql';
import counterInitialize from './shelf-counter-owner-initialize.sql';
import counterRead from './shelf-counter-owner-read.sql';
import counterComplete from './shelf-counter-owner-complete.sql';
import headEnsure from './shelf-head-ensure.sql';
import headTouch from './shelf-head-touch.sql';
import entryRaise from './shelf-entry-raise.sql';
import gateEnsure from './shelf-maintenance-gate-ensure.sql';
import gateRead from './shelf-maintenance-gate-read.sql';
import gateLock from './shelf-maintenance-gate-lock.sql';
import gateShare from './shelf-maintenance-gate-share.sql';
import gateSave from './shelf-maintenance-gate-save.sql';
import inputs from './shelf-maintenance-inputs.sql';
import runRead from './shelf-maintenance-run-read.sql';
import runLock from './shelf-maintenance-run-lock.sql';
import runCreate from './shelf-maintenance-run-create.sql';
import stepRead from './shelf-maintenance-step-read.sql';
import stepSave from './shelf-maintenance-step-save.sql';
import stepBind from './shelf-maintenance-step-bind.sql';
import advance from './shelf-maintenance-advance.sql';
import cancel from './shelf-maintenance-cancel.sql';
import runnable from './shelf-maintenance-runnable.sql';
import ack from './shelf-maintenance-ack.sql';
import authorizedCollection from './shelf-maintenance-authorized-collection.sql';
import entries from './shelf-maintenance-entries.sql';
import entryBackfill from './shelf-maintenance-entry-backfill.sql';
import sessionScratch from './shelf-maintenance-session-scratch.sql';
import sessions from './shelf-maintenance-sessions.sql';
import headInputs from './shelf-maintenance-head-inputs.sql';
import heads from './shelf-maintenance-heads.sql';
import countEntries from './shelf-maintenance-count-entries.sql';
import countCollections from './shelf-maintenance-count-collections.sql';
import validate from './shelf-maintenance-validate.sql';
import retireCounts from './shelf-maintenance-retire-counts.sql';
import retireReservations from './shelf-maintenance-retire-reservations.sql';
import scratchSessions from './shelf-maintenance-scratch-sessions.sql';
import scratchHeads from './shelf-maintenance-scratch-heads.sql';
import scratchSources from './shelf-maintenance-scratch-sources.sql';
import scratchSteps from './shelf-maintenance-scratch-steps.sql';
import sourceRead from './shelf-maintenance-source-read.sql';
import sourceSave from './shelf-maintenance-source-save.sql';
import sourceProgress from './shelf-maintenance-source-progress.sql';
import sourceAttach from './shelf-maintenance-source-attach.sql';
import sourceReset from './shelf-maintenance-source-reset.sql';
import reservationBind from './shelf-maintenance-reservation-bind.sql';
import reservationCheck from './shelf-maintenance-reservation-check.sql';
import stampIncarnation from './entry-legacy-incarnation-stamp.sql';
import sessionPage from './maintenance-session-page.sql';
import historyPage from './maintenance-history-page.sql';
import accountShare from '../access/account-share.sql';
import typeRoot from './shelf-type-key-root.sql';
import typeEdge from './shelf-type-key-edge.sql';
import typeValue from './shelf-type-key-value.sql';
import typeInsertValue from './shelf-type-key-insert-value.sql';
import typeInsertRoot from './shelf-type-key-insert-root.sql';
import typeInsertEdge from './shelf-type-key-insert-edge.sql';
import typeReserve from './shelf-type-key-reserve.sql';
import typeReservation from './shelf-type-key-reservation.sql';
import typeChunk from './shelf-type-key-chunk.sql';
import typeProgress from './shelf-type-key-progress.sql';
import typePublish from './shelf-type-key-publish.sql';
import typeFinish from './shelf-type-key-finish.sql';

export const SHELF_MAINTENANCE_LIMITS = Object.freeze({
  page: 100,
  segment: 100,
  commandDeadlineMs: 5_000,
  cursorScalars: 8,
  cursorBytes: 2_048,
  workflowBytes: 4_096,
  edgeBytes: 256,
  stagingBytes: 25_600,
});

const P = SHELF_MAINTENANCE_LIMITS.page;
const U = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
const I = -2147483648;
const D = '9223372036854775807';
const T = '\0'.repeat(64);
const json = (value: unknown) => JSON.stringify(value, (_key, v) => (typeof v === 'bigint' ? v.toString() : v));
const size = (value: unknown) => Buffer.byteLength(json(value));
const row = (value: unknown) => size(value) + 1;
const cursorBytes = 6 * SHELF_MAINTENANCE_LIMITS.cursorBytes;
const identity = { sourceId: U, partition: 4095, epoch: I, revision: I, transactionId: U, redirect: U };
const gateRow = { initialized: false, mode: 'rebuilding', ready: false, epoch: D, activeGeneration: U, runId: U };
const runRow = {
  runId: U,
  epoch: D,
  sequence: D,
  segment: I,
  kind: 'backfill',
  phase: 'retire-reservations',
  cursor: [],
  buildGeneration: U,
  enqueuePending: false,
  cancelled: false,
};
const sourceRow = {
  subjectId: U,
  incarnationId: U,
  transactionId: U,
  sourceId: U,
  sourcePartition: 4095,
  sourceEpoch: I,
  sourcePosition: D,
  identity,
  originIdentity: identity,
  reservationId: U,
  typeId: U,
};
const stepRow = { segment: I, phase: 'retire-reservations', cursor: [], buildGeneration: U, inputIdentity: null };
const sessionRow = {
  sessionId: U,
  subjectId: U,
  state: 'abandoned',
  revision: I,
  transactionId: U,
  startedAt: T,
  completedAt: T,
  lastChangedAt: T,
};

export const shelfCost = (part: Partial<Bound> = {}): Bound =>
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
    ...part,
  });
const point = (projection: unknown, rows = 1, points = 1) => ({
  rows,
  points,
  candidates: 0,
  results: projection === null ? 0 : 1,
  resultBytes: projection === null ? 0 : row(projection),
  seeks: points,
  nested: shelfCost(),
});
type Shape = ReturnType<typeof point>;
const seek = (projection: unknown, n = P, revisits = 2, points = 1): Shape => ({
  rows: revisits * n,
  points,
  candidates: n,
  results: n,
  resultBytes: row(projection),
  seeks: points,
  nested: shelfCost(),
});
const mutate = (indexes = 1): Shape => point(null, 2 + 2 * indexes, 1 + 2 * indexes);
const add = (shape: Shape, work: Bound): Shape => ({ ...shape, nested: sumBounds(shape.nested, work) });
// Per old/new owner: native fence INSERT/conflict UPDATE touches heap and its two indexes.
function nativeFence() {
  return memoizedValue(nativeFence, () =>
    repeatBound(shelfCost({ nativeRows: 6, nativePoints: 5, statements: 1, emptySeeks: 1 }), 2),
  );
}
// Entry's BEFORE profile fence (INSERT/lock/four indexed EOF probes/possible phase UPDATE),
// fact head, title population, score head, score sync (entry + unique vote + eight score indexes).
// Activity refresh runs twice; each reads three entry/head points, one live-session EXISTS and one index UPDATE.
function profileFence() {
  return memoizedValue(profileFence, () =>
    shelfCost({ nativeRows: 16, nativePoints: 14, statements: 7, emptySeeks: 6 }),
  );
}
function activityRefresh() {
  return memoizedValue(activityRefresh, () =>
    repeatBound(shelfCost({ nativeRows: 14, nativePoints: 13, statements: 6, emptySeeks: 5 }), 2),
  );
}
function entryEffects() {
  return memoizedValue(entryEffects, () =>
    sumBounds(
      profileFence(),
      nativeFence(),
      activityRefresh(),
      repeatBound(shelfCost({ nativeRows: 4, nativePoints: 3, statements: 1, emptySeeks: 1 }), 3),
      shelfCost({ nativeRows: 2 + 2 + 2 * 9, nativePoints: 2 + 1 + 2 * 9, statements: 1, emptySeeks: 2 }),
    ),
  );
}
// Session UPDATE fires the statistics old/new deltas even when only last_changed_at changes.
// Current progress has one primary + at most seven additional measures, with old/new projection effects.
function statisticDelta() {
  return memoizedValue(statisticDelta, () =>
    shelfCost({ nativeRows: 20, nativePoints: 17, statements: 6, emptySeeks: 5 }),
  );
}
function progressMeasure() {
  return memoizedValue(progressMeasure, () =>
    shelfCost({ nativeRows: 24, nativePoints: 20, statements: 8, emptySeeks: 6 }),
  );
}
function sessionEffects() {
  return memoizedValue(sessionEffects, () =>
    sumBounds(
      profileFence(),
      nativeFence(),
      repeatBound(statisticDelta(), 2),
      repeatBound(progressMeasure(), 2 * (1 + 7)),
      // Assessment, reported-year and reading-insights initializers: old/new branches and owner revisions.
      repeatBound(shelfCost({ nativeRows: 32, nativePoints: 28, statements: 12, emptySeeks: 8 }), 3),
      shelfCost({ nativeRows: 4, nativePoints: 3, statements: 1, emptySeeks: 1 }),
    ),
  );
}

function definitions() {
  return memoizedValue(
    definitions,
    () =>
      [
        // A transition has four old and four new contributions before aggregation. Never price only
        // distinct returned counters: every discarded contribution and index probe still belongs here.
        [counterDelta, { ...point(null, 8 * (2 + 2 + 4), 8 * (1 + 4)), candidates: 8 }],
        [counterInitialize, mutate()],
        [counterRead, point({ fenceId: U, epoch: D, state: 'initializing', ready: false, generationId: U })],
        [counterComplete, mutate()],
        [
          headEnsure,
          {
            ...add(mutate(), activityRefresh()),
            results: 1,
            resultBytes: row({ lastChangedAt: T, lastCompletedAt: T }),
          },
        ],
        [headTouch, add(mutate(), activityRefresh())],
        [entryRaise, add(mutate(20), entryEffects())],
        [gateEnsure, mutate()],
        [gateRead, point(gateRow)],
        [gateLock, point(gateRow)],
        [gateShare, point(gateRow)],
        [gateSave, mutate()],
        [inputs, point({ entries: false, collections: false, sessions: false }, 6, 3)],
        [runRead, { ...point(runRow), resultBytes: row(runRow) + cursorBytes }],
        [runLock, { ...point(runRow), resultBytes: row(runRow) + cursorBytes }],
        [runCreate, mutate(2)],
        [stepRead, { ...point(stepRow), resultBytes: row(stepRow) + 2 * cursorBytes }],
        [stepSave, add(mutate(2), shelfCost({ nativeRows: 1, nativePoints: 1, emptySeeks: 1 }))],
        [stepBind, mutate(2)],
        [advance, { ...mutate(2), results: 1, resultBytes: row({ sequence: D }) }],
        [cancel, mutate(2)],
        [ack, mutate(2)],
        [
          runnable,
          seek({
            route: 65535,
            accountId: U,
            runId: U,
            epoch: D,
            sequence: D,
            segment: I,
            kind: 'backfill',
            attempt: D,
          }),
        ],
        [authorizedCollection, point({ id: U })],
        [entries, { ...point({ subjectId: U, incarnationId: U, transactionId: U, typeId: U }, 2), candidates: 1 }],
        [sessionScratch, mutate()],
        [
          sessions,
          add(
            seek({ id: U }, P, 2 + 2 + 2 * 21, 1 + P * 3),
            sumBounds(repeatBound(sessionEffects(), P), shelfCost({ nativeRows: 4 * P, statements: 1 })),
          ),
        ],
        [headInputs, seek({ id: U }, P, 2 + 4, 1 + P * 3)],
        [heads, add(seek({ id: U }, P, 2 + 4, 1 + P * 3), repeatBound(activityRefresh(), P))],
        [
          entryBackfill,
          add(
            seek(
              { subjectId: U, incarnationId: U, revision: I, transactionId: U },
              P,
              2 + 1 + 2 + 2 * 20,
              1 + P * (1 + 2 * 20),
            ),
            repeatBound(entryEffects(), P),
          ),
        ],
        [stampIncarnation, { ...add(mutate(20), entryEffects()), results: 1, resultBytes: row({ incarnationId: U }) }],
        [sourceAttach, { ...add(mutate(20), entryEffects()), results: 1, resultBytes: row({ subject_id: U }) }],
        // Four contributions per Entry, including discarded duplicates before GROUP BY, and conflict writes.
        [countEntries, { ...seek({ id: U }, P, 2 + 4 + 4 * 4 + 1, 1 + 4 * P * (1 + 2 * 2)), candidates: P + 4 * P }],
        [countCollections, add(seek({ id: U }, P, 2, 1), shelfCost({ nativeRows: 4, nativePoints: 3, emptySeeks: 1 }))],
        [validate, { ...point({ id: U, valid: false }, 3, 2), candidates: 1 }],
        [retireCounts, seek({ removed: false }, P, 2 + 3, 1 + P * 3)],
        [retireReservations, seek({ removed: false }, P, 2 + 4, 1 + P * 3)],
        [scratchSessions, seek({ removed: false }, P, 2 + 3, 1 + P * 2)],
        [scratchHeads, seek({ removed: false }, P, 2 + 3, 1 + P * 2)],
        [scratchSources, seek({ removed: false }, P, 2 + 3, 1 + P * 2)],
        [scratchSteps, seek({ removed: false }, P, 2 + 2 + 2 * 2, 1 + P * 5)],
        [sourceRead, point(sourceRow)],
        [sourceSave, mutate()],
        [sourceProgress, mutate()],
        [sourceReset, { ...mutate(2), rows: 10, points: 8 }],
        [reservationBind, { ...mutate(2), results: 1, resultBytes: row({ reservation_id: U }) }],
        [reservationCheck, point({ reservation_id: U })],
        [accountShare, point({ state: 'active', fenced: false })],
        [sessionPage, seek(sessionRow)],
        // owned point + child seek/LIMIT + materialization/aggregate; one logical result, never one examined row.
        [
          historyPage,
          {
            ...seek(null, P, 3, 2),
            results: 1,
            resultBytes: row({ owned: false, count: P, after: D, lastChangedAt: T }),
          },
        ],
        [typeRoot, { ...point({ nodeId: U, typeId: U, equal: false }, 3, 2), candidates: 1 }],
        [typeEdge, { ...point({ nodeId: U, typeId: U }, 2), candidates: 1 }],
        [typeValue, point({ typeId: U })],
        [typeInsertValue, { ...mutate(), results: 1, resultBytes: row({ typeId: U }) }],
        // NOT EXISTS, unique conflicts and deferred node/value FK probes.
        [typeInsertRoot, { ...point({ root_node_id: U }, 12, 10), candidates: 1 }],
        [typeInsertEdge, point(null, 12, 10)],
        [typeReserve, point(null, 12, 10)],
        [
          typeReservation,
          point({ reservationId: U, nodeId: U, offset: D, length: D, candidateId: U, fenceId: U, generationId: U }),
        ],
        // pg bytea JSON representation is at most four characters per byte plus its fixed framing.
        [
          typeChunk,
          { ...point(null), results: 1, resultBytes: row({ chunk: '' }) + 4 * SHELF_MAINTENANCE_LIMITS.stagingBytes },
        ],
        [typeProgress, { ...mutate(2), results: 1, resultBytes: row({ reservation_id: U }) }],
        [rootSize, point({ bytes: D }, 2, 2)],
        [retirementSize, { ...seek(null, P, 1), results: 1, resultBytes: row({ bytes: D }) }],
        [typePublish, point({ typeId: U }, 24, 20)],
        [typeFinish, mutate(2)],
      ] as const,
  );
}
const normalize = (sql: string) => sql.replace(/\s+/g, ' ').trim();
function shapes() {
  return memoizedValue(shapes, () => new Map(definitions().map(([query, shape]) => [normalize(query.sql), shape])));
}
const controls = new Set([
  'BEGIN',
  'BEGIN ISOLATION LEVEL SERIALIZABLE',
  'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY',
  'COMMIT',
  'ROLLBACK',
  "SET LOCAL lock_timeout = '200ms'",
]);

export interface ShelfMaintenanceStatementPlan {
  readonly kind: 'shelf-maintenance.sql';
  readonly sql: string;
  readonly serializedBinds: string;
  readonly logicalResultLimit: number;
  readonly total: Bound;
}

/** Literal SQL and original operands, fixed before dispatch. No result/rowCount enters this calculation. */
export function shelfMaintenanceStatementPlan(
  sql: string,
  values: readonly unknown[],
  valueBytes = 0,
): ShelfMaintenanceStatementPlan | undefined {
  const shape = shapes().get(normalize(sql));
  const control = controls.has(sql.trim()) || /^SET LOCAL statement_timeout = '[0-9]+ms'$/.test(sql);
  if (!shape && !control) return undefined;
  const serializedBinds = json(values);
  return Object.freeze({
    kind: 'shelf-maintenance.sql',
    sql,
    serializedBinds,
    logicalResultLimit: shape?.results ?? 0,
    total: sumBounds(
      shape?.nested ?? shelfCost(),
      shelfCost({
        nativeRows: shape?.rows ?? 0,
        nativePoints: shape?.points ?? 0,
        candidateKeys: shape?.candidates ?? 0,
        emptySeeks: shape?.seeks ?? 0,
        statements: 1,
        bytes:
          valueBytes +
          Buffer.byteLength(sql) +
          Buffer.byteLength(serializedBinds) +
          2 +
          (shape ? shape.results * shape.resultBytes : 0),
      }),
    ),
  });
}

/** Explicit nine/eight-axis boundary. Every declared body above issues SQL only, with no engine producer. */
export function shelfMaintenanceWorkDimensions(bound: Bound): WorkDimensions {
  return Object.freeze({
    candidateKeys: bound.candidateKeys,
    nativeRows: bound.nativeRows,
    identityMetadataRows: bound.identityMetadataRows,
    emptySeeks: bound.emptySeeks,
    nativePoints: bound.nativePoints,
    witnessKeys: bound.witnessKeys,
    statements: bound.statements,
    bytes: bound.bytes,
  });
}

/** Shared serialization maxima for the native command descriptor. */
export const shelfMaintenanceBoundValues = { P, U, I, D, T, json, size, row, normalize };
