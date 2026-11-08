import { memoizedValue } from '../memoized.ts';
import { BOUND_AXES, declareBound, repeatBound, sumBounds, withinCeiling, type Bound } from '@rezics/bounds';
import type { WorkDimensions } from './contract/work-dimensions.ts';
import { nativeIdentityPartitionQuery, nativeIdentitySourceBasisFootprint } from './identity-native-bounds.ts';
import accountQuery from './native-source-custody-account.sql';
import advanceQuery from './native-source-custody-advance.sql';
import ensureQuery from './native-source-custody-ensure.sql';
import fencesQuery from './native-source-custody-fences.sql';
import finishQuery from './native-source-custody-finish.sql';
import heldQuery from './native-source-custody-held.sql';
import holdQuery from './native-source-custody-hold.sql';
import nextCapture from './native-source-custody-next.sql';
import outputQuery from './native-source-custody-output.sql';
import partitionQuery from './native-source-custody-partition.sql';
import proofQuery from './native-source-custody-proof.sql';
import rawAssignment from './native-source-custody-raw-assignment.sql';
import rawChange from './native-source-custody-raw-change.sql';
import rawCopy from './native-source-custody-raw-copy.sql';
import rawEntryDeleted from './native-source-custody-raw-entry_deleted.sql';
import rawEntry from './native-source-custody-raw-entry.sql';
import rawExplicitOutput from './native-source-custody-raw-explicit-output.sql';
import rawLabel from './native-source-custody-raw-label.sql';
import rawMember from './native-source-custody-raw-member.sql';
import rawOutput from './native-source-custody-raw-output.sql';
import rawSession from './native-source-custody-raw-session.sql';
import rawUnit from './native-source-custody-raw-unit.sql';
import readQuery from './native-source-custody-read.sql';
import releaseQuery from './native-source-custody-release.sql';
import retireActive from './native-source-custody-retire-active.sql';
import retireCapture from './native-source-custody-retire-capture.sql';
import retireChildren from './native-source-custody-retire-children.sql';
import retireHolds from './native-source-custody-retire-holds.sql';
import retireProof from './native-source-custody-retire-proof.sql';
import retireReceipt from './native-source-custody-retire-receipt.sql';
import retireSource from './native-source-custody-retire-source.sql';
import retainedQuery from './native-source-custody-retained.sql';
import sourceQuery from './native-source-custody-source.sql';
import startQuery from './native-source-custody-start.sql';
import identityCapture from './identity-native-planner-source.sql';
import identityRetention from './identity-native-planner-retention.sql';
import terminalScope from './erasure-scope.sql';
import type { NativeSourceDriver } from './native-source-custody.ts';

type Query = Readonly<{ sql: string; params: readonly string[] }>;
type StatementId =
  | 'account'
  | 'advance'
  | 'ensure'
  | 'fences'
  | 'finish'
  | 'held'
  | 'hold'
  | 'identityCapture'
  | 'identityPartition'
  | 'output'
  | 'proof'
  | 'rawAssignment'
  | 'rawChange'
  | 'rawCopy'
  | 'rawEntry'
  | 'rawEntryDeleted'
  | 'rawExplicitOutput'
  | 'rawLabel'
  | 'rawMember'
  | 'rawOutput'
  | 'rawSession'
  | 'rawUnit'
  | 'retireActive'
  | 'retireCaptureRow'
  | 'retireChildren'
  | 'retireHolds'
  | 'retireProofRow'
  | 'retireReceipt'
  | 'retireSource'
  | 'identityRetention'
  | 'nextCapture'
  | 'read'
  | 'release'
  | 'retained'
  | 'source'
  | 'start'
  | 'terminalScope';
type CustodyOperation =
  | 'capturePage'
  | 'finishCapture'
  | 'readAndHold'
  | 'revalidateHold'
  | 'releaseHold'
  | 'retireCapture';
type CostDetail = Readonly<{
  bound: Bound;
  requestBytes: number;
  projectionBytes: number;
}>;
type StatementSpec = Readonly<{
  id: StatementId;
  query: Query;
  rows: number | ((values: readonly unknown[]) => number | undefined);
  points: number;
  metadata: number;
  keys: number | ((values: readonly unknown[]) => number | undefined);
  projectionBytes: number | ((values: readonly unknown[]) => number | undefined);
  maxOverrides?: Readonly<Record<string, unknown>>;
  valid?: (values: Readonly<Record<string, unknown>>) => boolean;
}>;

const maxInt = 2147483647;
const maxBigint = '9223372036854775807';
const maxUuid = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
const maxEscapedText = (octets: number) => String.fromCharCode(1).repeat(octets);
const maxScope = 'active_explicit_output';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const bigintText = /^(0|[1-9][0-9]{0,18})$/;
const positiveBigintText = /^[1-9][0-9]{0,18}$/;
const allowedDrivers = new Set<NativeSourceDriver>([
  'member',
  'entry',
  'entry_deleted',
  'label',
  'assignment',
  'session',
  'unit',
  'change',
  'copy',
  'output',
  'done',
]);

const captureProjectionBytes = Buffer.byteLength(
  JSON.stringify({
    route: 65535,
    captureId: maxUuid,
    collectionId: maxUuid,
    accountId: maxUuid,
    incarnation: maxEscapedText(128),
    generation: maxBigint,
    scope: maxScope,
    ownerEpoch: maxInt,
    receivingEpoch: maxBigint,
    effectKey: maxEscapedText(256),
    outputGeneration: maxUuid,
    publicationTransactionId: maxUuid,
    publicationPosition: maxBigint,
    collectionFence: maxBigint,
    accountFence: maxBigint,
    driver: 'entry_deleted',
    after: maxEscapedText(512),
    tie: maxEscapedText(64),
    sessionId: maxUuid,
    scanned: maxBigint,
    version: maxInt,
    complete: false,
  }),
);
const dependencyProjectionBytes = Buffer.byteLength(
  JSON.stringify({
    driver: 'entry_deleted',
    key: maxEscapedText(128),
    tie: maxEscapedText(64),
    subjectId: maxUuid,
    transactionId: maxUuid,
  }),
);
const receiptProjectionBytes = Buffer.byteLength(JSON.stringify({ transactionId: maxUuid, position: maxBigint }));
const holdProjectionBytes = Buffer.byteLength(JSON.stringify({ transactionId: maxUuid, released: false }));
const retainedProjectionBytes = Buffer.byteLength(JSON.stringify({ transactionId: maxUuid }));
const terminalProjectionBytes = Buffer.byteLength(JSON.stringify({ version: maxInt, outcome: maxEscapedText(32) }));
const retireSourceProjectionBytes = Buffer.byteLength(
  JSON.stringify([
    {
      accountId: maxUuid,
      incarnation: `${maxUuid}:9223372036854.775807`,
      generation: maxBigint,
      state: 'deleted',
      kind: 'curated',
      builtin: 'everything',
      visibility: 'unlisted',
      deletionId: maxUuid,
      revision: maxInt,
      deadlineMatches: false,
      due: false,
      publicCustody: false,
    },
  ]),
);
const retirementHoldProjectionBytes = Buffer.byteLength(
  JSON.stringify([{ id: maxUuid, transactionId: maxUuid, released: false, committed: false }]),
);
const retirementUuidProjectionBytes = Buffer.byteLength(JSON.stringify([{ capture_id: maxUuid }]));
const retirementPlanKeyProjectionBytes = Buffer.byteLength(JSON.stringify([{ plan_key: '0'.repeat(64) }]));

function rawQueries() {
  return memoizedValue(rawQueries, () =>
    Object.freeze({
      member: rawMember,
      entry: rawEntry,
      entry_deleted: rawEntryDeleted,
      label: rawLabel,
      assignment: rawAssignment,
      session: rawSession,
      unit: rawUnit,
      change: rawChange,
      copy: rawCopy,
      output: rawOutput,
    }),
  );
}

/** Explicit Query names so the producer declaration does not leak pg protocol types. */
type NativeSourceCustodyQueries = Readonly<{
  partition: Query;
  source: Query;
  account: Query;
  output: Query;
  ensure: Query;
  fences: Query;
  read: Query;
  start: Query;
  advance: Query;
  identityCapture: Query;
  proof: Query;
  finish: Query;
  hold: Query;
  held: Query;
  retained: Query;
  release: Query;
  terminalScope: Query;
  raw: Readonly<{
    member: Query;
    entry: Query;
    entry_deleted: Query;
    label: Query;
    assignment: Query;
    session: Query;
    unit: Query;
    change: Query;
    copy: Query;
    output: Query;
  }>;
  rawExplicitOutput: Query;
  retirement: Readonly<{
    partition: Query;
    source: Query;
    receipt: Query;
    active: Query;
    holds: Query;
    children: Query;
    proof: Query;
    capture: Query;
    identityRetention: Query;
    nextCapture: Query;
  }>;
}>;

/** The canonical SQL objects used by the native adapter and the executable plan. */
export function nativeSourceCustodyQueries(): NativeSourceCustodyQueries {
  return memoizedValue(nativeSourceCustodyQueries, () =>
    Object.freeze({
      partition: nativeIdentityPartitionQuery,
      source: sourceQuery,
      account: accountQuery,
      output: outputQuery,
      ensure: ensureQuery,
      fences: fencesQuery,
      read: readQuery,
      start: startQuery,
      advance: advanceQuery,
      identityCapture,
      proof: proofQuery,
      finish: finishQuery,
      hold: holdQuery,
      held: heldQuery,
      retained: retainedQuery,
      release: releaseQuery,
      terminalScope,
      raw: rawQueries(),
      rawExplicitOutput,
      retirement: Object.freeze({
        partition: partitionQuery,
        source: retireSource,
        receipt: retireReceipt,
        active: retireActive,
        holds: retireHolds,
        children: retireChildren,
        proof: retireProof,
        capture: retireCapture,
        identityRetention,
        nextCapture,
      }),
    }),
  );
}

const planLimit = (values: readonly unknown[], query: Query): number | undefined => {
  const index = query.params.indexOf('limit');
  if (index === -1) return query === rawSession ? 1 : undefined;
  const limit = values[index];
  return typeof limit === 'number' && Number.isSafeInteger(limit) && limit >= 1 && limit <= 100 ? limit : undefined;
};

function rawIdByQuery() {
  return memoizedValue(
    rawIdByQuery,
    () =>
      new Map<Query, StatementId>([
        [rawMember, 'rawMember'],
        [rawEntry, 'rawEntry'],
        [rawEntryDeleted, 'rawEntryDeleted'],
        [rawLabel, 'rawLabel'],
        [rawAssignment, 'rawAssignment'],
        [rawSession, 'rawSession'],
        [rawUnit, 'rawUnit'],
        [rawChange, 'rawChange'],
        [rawCopy, 'rawCopy'],
        [rawOutput, 'rawOutput'],
        [rawExplicitOutput, 'rawExplicitOutput'],
      ]),
  );
}

const spec = (
  id: StatementId,
  query: Query,
  rows: StatementSpec['rows'],
  points: number,
  metadata: number,
  keys: StatementSpec['keys'],
  projectionBytes: StatementSpec['projectionBytes'],
  options: Pick<StatementSpec, 'maxOverrides' | 'valid'> = {},
): StatementSpec => Object.freeze({ id, query, rows, points, metadata, keys, projectionBytes, ...options });

function statementSpecs(): readonly StatementSpec[] {
  return memoizedValue(statementSpecs, () =>
    Object.freeze([
      spec('ensure', ensureQuery, 32, 2, 0, 0, 0),
      spec('start', startQuery, 32, 1, 0, 0, 0),
      spec('advance', advanceQuery, 32, 1, 0, 0, 0),
      spec('read', readQuery, 16, 1, 0, 0, captureProjectionBytes),
      spec('finish', finishQuery, 80, 3, 1, 1, receiptProjectionBytes),
      spec('hold', holdQuery, 48, 1, 0, 0, holdProjectionBytes),
      spec('held', heldQuery, 16, 1, 0, 0, holdProjectionBytes),
      spec('retained', retainedQuery, 16, 1, 0, 0, retainedProjectionBytes),
      spec('release', releaseQuery, 32, 1, 0, 0, 0),
      spec('terminalScope', terminalScope, 48, 3, 0, 0, terminalProjectionBytes),
      spec('retireSource', retireSource, 3, 3, 0, 3, retireSourceProjectionBytes),
      spec('retireReceipt', retireReceipt, 1, 1, 0, 1, receiptProjectionBytes),
      spec('retireActive', retireActive, 1, 1, 0, 1, Buffer.byteLength(JSON.stringify([{ id: maxUuid }]))),
      spec('retireHolds', retireHolds, 80, 1, 0, 80, retirementHoldProjectionBytes * 80),
      spec(
        'retireChildren',
        retireChildren,
        (values) => {
          const ids = values[retireChildren.params.indexOf('hold_ids')];
          return Array.isArray(ids) && ids.length >= 1 && ids.length <= 80 ? ids.length : undefined;
        },
        80,
        0,
        (values) => {
          const ids = values[retireChildren.params.indexOf('hold_ids')];
          return Array.isArray(ids) && ids.length >= 1 && ids.length <= 80 ? ids.length : undefined;
        },
        (values) => {
          const ids = values[retireChildren.params.indexOf('hold_ids')];
          return Array.isArray(ids) && ids.length >= 1 && ids.length <= 80
            ? Buffer.byteLength(JSON.stringify(ids))
            : undefined;
        },
        {
          maxOverrides: { hold_ids: Array.from({ length: 80 }, () => maxUuid) },
          valid: (values) => {
            const ids = values.hold_ids;
            return (
              Array.isArray(ids) &&
              ids.length >= 1 &&
              ids.length <= 80 &&
              ids.every((id) => typeof id === 'string' && uuid.test(id))
            );
          },
        },
      ),
      spec('retireProofRow', retireProof, 1, 2, 0, 1, retirementUuidProjectionBytes),
      spec('retireCaptureRow', retireCapture, 1, 2, 0, 1, retirementUuidProjectionBytes),
      spec('identityRetention', identityRetention, 1, 1, 1, 1, retirementPlanKeyProjectionBytes),
      spec(
        'nextCapture',
        nextCapture,
        1,
        2,
        1,
        1,
        Buffer.byteLength(
          JSON.stringify([
            {
              route: 65535,
              captureId: maxUuid,
              collectionId: maxUuid,
              accountId: maxUuid,
              incarnation: `${maxUuid}:9223372036854.775807`,
              generation: maxBigint,
              scope: maxScope,
              ownerEpoch: maxInt,
              receivingEpoch: maxBigint,
              effectKey: maxEscapedText(256),
              outputGeneration: maxUuid,
              publicationTransactionId: maxUuid,
              publicationPosition: maxBigint,
              sourceGeneration: maxBigint,
            },
          ]),
        ),
      ),
      ...Object.entries(rawQueries()).map(([driver, query]) => {
        const id = rawIdByQuery().get(query)!;
        return spec(
          id,
          query,
          (values) => {
            const limit = planLimit(values, query);
            return limit === undefined ? undefined : 16 * limit + 32;
          },
          1,
          0,
          (values) => planLimit(values, query),
          (values) => {
            const limit = planLimit(values, query);
            return limit === undefined ? undefined : dependencyProjectionBytes * limit;
          },
          {
            maxOverrides:
              driver === 'member'
                ? { after: maxEscapedText(48), tie: maxUuid }
                : driver === 'unit'
                  ? { after: maxEscapedText(128) }
                  : driver === 'change'
                    ? { after: '2147483647', tie: maxUuid }
                    : driver === 'entry'
                      ? { after: maxUuid, tie: maxEscapedText(64) }
                      : driver === 'entry_deleted' || driver === 'label' || driver === 'session' || driver === 'output'
                        ? { after: maxUuid }
                        : driver === 'assignment' || driver === 'copy'
                          ? { after: maxUuid, tie: maxUuid }
                          : {},
            valid: (values) => validRawBinds(id, values),
          },
        );
      }),
      spec(
        'rawExplicitOutput',
        rawExplicitOutput,
        (values) => {
          const limit = planLimit(values, rawExplicitOutput);
          return limit === undefined ? undefined : 16 * limit + 32;
        },
        1,
        0,
        (values) => planLimit(values, rawExplicitOutput),
        (values) => {
          const limit = planLimit(values, rawExplicitOutput);
          return limit === undefined ? undefined : dependencyProjectionBytes * limit;
        },
        { maxOverrides: { after: maxUuid }, valid: (values) => validRawBinds('rawExplicitOutput', values) },
      ),
    ]),
  );
}
function specByQuery() {
  return memoizedValue(specByQuery, () => new Map(statementSpecs().map((value) => [value.query, value])));
}
function specById() {
  return memoizedValue(specById, () => new Map(statementSpecs().map((value) => [value.id, value])));
}

function basisQueries(): readonly Query[] {
  return memoizedValue(basisQueries, () =>
    Object.freeze([
      nativeIdentityPartitionQuery,
      accountQuery,
      sourceQuery,
      outputQuery,
      fencesQuery,
      identityCapture,
      proofQuery,
    ]),
  );
}
function basisQuerySet() {
  return memoizedValue(basisQuerySet, () => new Set(basisQueries()));
}
function queryBySql() {
  return memoizedValue(queryBySql, () =>
    (() => {
      const result = new Map<string, Query>();
      for (const [query] of specByQuery()) result.set(query.sql, query);
      for (const query of basisQueries()) result.set(query.sql, query);
      return result;
    })(),
  );
}

type StatementCounts = Readonly<Partial<Record<StatementId, number>>>;
type OperationDefinition = Readonly<{
  fixed: StatementCounts;
  optional: StatementCounts;
  choices: Readonly<Record<string, Readonly<{ maximum: number; statements: StatementCounts }>>>;
  controls: Readonly<Partial<Record<ControlSQL, number>>>;
  checkout: number;
  frontier?: Readonly<{ minLimit: number; maxLimit: number; sessionLimit: number }>;
}>;

const rawDriverStatementCounts = Object.freeze({
  rawAssignment: 1,
  rawChange: 1,
  rawCopy: 1,
  rawEntry: 1,
  rawEntryDeleted: 1,
  rawExplicitOutput: 1,
  rawLabel: 1,
  rawMember: 1,
  rawOutput: 1,
  rawSession: 1,
  rawUnit: 1,
});
const operationDefinitions: Readonly<Record<CustodyOperation, OperationDefinition>> = Object.freeze({
  capturePage: Object.freeze({
    fixed: Object.freeze({ identityPartition: 1, account: 1, source: 1, ensure: 1, fences: 1, advance: 1 }),
    optional: Object.freeze({ output: 1 }),
    choices: Object.freeze({
      startOrRead: Object.freeze({ maximum: 1, statements: Object.freeze({ start: 1, read: 1 }) }),
      rawDriver: Object.freeze({ maximum: 1, statements: rawDriverStatementCounts }),
    }),
    controls: Object.freeze({ BEGIN: 1, COMMIT: 1, ROLLBACK: 1 }),
    checkout: 1,
    frontier: Object.freeze({ minLimit: 1, maxLimit: 100, sessionLimit: 1 }),
  }),
  finishCapture: Object.freeze({
    fixed: Object.freeze({ identityPartition: 1, account: 1, source: 1, fences: 1, read: 1 }),
    optional: Object.freeze({ output: 1 }),
    choices: Object.freeze({
      proofOrFinish: Object.freeze({ maximum: 1, statements: Object.freeze({ proof: 1, finish: 1 }) }),
    }),
    controls: Object.freeze({ BEGIN: 1, COMMIT: 1, ROLLBACK: 1 }),
    checkout: 1,
  }),
  readAndHold: Object.freeze({
    fixed: Object.freeze({ identityPartition: 1, account: 1, source: 1, fences: 1, read: 1, proof: 1, hold: 1 }),
    optional: Object.freeze({ output: 1 }),
    choices: Object.freeze({}),
    controls: Object.freeze({}),
    checkout: 0,
  }),
  revalidateHold: Object.freeze({
    fixed: Object.freeze({ identityPartition: 1, account: 1, source: 1, fences: 1, read: 1, proof: 1, retained: 1 }),
    optional: Object.freeze({ terminalScope: 1 }),
    choices: Object.freeze({}),
    controls: Object.freeze({}),
    checkout: 0,
  }),
  releaseHold: Object.freeze({
    fixed: Object.freeze({ identityPartition: 1, account: 1, source: 1, fences: 1, read: 1, proof: 1, held: 1 }),
    optional: Object.freeze({ terminalScope: 1, release: 1 }),
    choices: Object.freeze({}),
    controls: Object.freeze({}),
    checkout: 0,
  }),
  retireCapture: Object.freeze({
    fixed: Object.freeze({
      identityPartition: 1,
      account: 1,
      retireSource: 1,
      fences: 1,
      read: 1,
      retireReceipt: 1,
      identityRetention: 1,
      retireActive: 1,
      retireHolds: 1,
    }),
    optional: Object.freeze({
      terminalScope: 1,
      proof: 1,
      retireChildren: 1,
      retireProofRow: 1,
      retireCaptureRow: 1,
    }),
    choices: Object.freeze({}),
    controls: Object.freeze({}),
    checkout: 0,
  }),
});

const zeroBound = () =>
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

/** Translate the nine-axis public bound to the legacy native receipt axes explicitly. */
export function nativeSourceCustodyWorkDimensions(bound: Bound): WorkDimensions {
  const value = declareBound(bound);
  if (value.engineRequests !== 0) throw new TypeError('Native SQL cannot consume engine requests');
  return Object.freeze({
    candidateKeys: value.candidateKeys,
    nativeRows: value.nativeRows,
    identityMetadataRows: value.identityMetadataRows,
    emptySeeks: value.emptySeeks,
    nativePoints: value.nativePoints,
    witnessKeys: value.witnessKeys,
    statements: value.statements,
    bytes: value.bytes,
  });
}

function boundFromWork(work: WorkDimensions): Bound {
  return declareBound({ ...work, engineRequests: 0 });
}

const requestBytesFor = (sql: string, values: readonly unknown[]) =>
  Buffer.byteLength(sql) + Buffer.byteLength(JSON.stringify(values));

function splitBound(
  requestBytes: number,
  projectionBytes: number,
  work: Omit<WorkDimensions, 'bytes' | 'statements'>,
): Bound {
  const request = declareBound({
    candidateKeys: 0,
    nativeRows: 0,
    identityMetadataRows: 0,
    emptySeeks: 0,
    nativePoints: 0,
    witnessKeys: 0,
    statements: 1,
    bytes: requestBytes,
    engineRequests: 0,
  });
  const projection = declareBound({
    candidateKeys: work.candidateKeys,
    nativeRows: work.nativeRows,
    identityMetadataRows: work.identityMetadataRows,
    emptySeeks: work.emptySeeks,
    nativePoints: work.nativePoints,
    witnessKeys: work.witnessKeys,
    statements: 0,
    bytes: projectionBytes,
    engineRequests: 0,
  });
  return sumBounds(request, projection);
}

function maxValue(name: string, overrides?: Readonly<Record<string, unknown>>): unknown | undefined {
  if (overrides && Object.hasOwn(overrides, name)) return overrides[name];
  const values: Readonly<Record<string, unknown>> = {
    route: 65535,
    account_route: 65535,
    partition_no: 4095,
    collection_id: maxUuid,
    account_id: maxUuid,
    incarnation: maxEscapedText(128),
    generation: maxBigint,
    scope: maxScope,
    owner_epoch: maxInt,
    receiving_epoch: maxBigint,
    effect_key: maxEscapedText(256),
    output_generation: maxUuid,
    publication_transaction_id: maxUuid,
    publication_position: maxBigint,
    collection_fence: maxBigint,
    account_fence: maxBigint,
    capture_id: maxUuid,
    driver: 'entry_deleted',
    after: maxEscapedText(512),
    tie: maxEscapedText(64),
    session_id: maxUuid,
    scanned: maxBigint,
    limit: 100,
    transaction_id: maxUuid,
    hold_id: maxUuid,
    hold_ids: Array.from({ length: 80 }, () => maxUuid),
    purge_after: '9999-12-31T23:59:59.999999Z',
    time: '9999-12-31T23:59:59.999999Z',
  };
  return Object.hasOwn(values, name) ? values[name] : undefined;
}

function maxValues(query: Query, overrides?: Readonly<Record<string, unknown>>): readonly unknown[] | undefined {
  const values = query.params.map((name) => maxValue(name, overrides));
  return values.some((value) => value === undefined) ? undefined : values;
}

function boundedText(value: unknown, maxBytes: number, allowEmpty = true): value is string {
  return (
    typeof value === 'string' &&
    (allowEmpty || value.length > 0) &&
    !value.includes('\u0000') &&
    Buffer.byteLength(value) <= maxBytes
  );
}

function boundedCharacters(value: unknown, maxCharacters: number): value is string {
  return (
    typeof value === 'string' &&
    Array.from(value).length <= maxCharacters &&
    Buffer.byteLength(value) <= maxCharacters * 4 &&
    !value.includes('\u0000')
  );
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && uuid.test(value);
}

function isNullableUuid(value: unknown): boolean {
  return value === null || isUuid(value);
}

function isBigint(value: unknown, positive = false): value is string {
  return (
    typeof value === 'string' &&
    (positive ? positiveBigintText.test(value) : bigintText.test(value)) &&
    BigInt(value) <= 9223372036854775807n
  );
}

function validParameter(name: string, value: unknown): boolean {
  switch (name) {
    case 'route':
    case 'account_route':
      return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 65535;
    case 'partition_no':
      return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 4095;
    case 'owner_epoch':
      return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= maxInt;
    case 'limit':
      return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= 100;
    case 'collection_id':
    case 'account_id':
    case 'transaction_id':
    case 'hold_id':
      return isUuid(value);
    case 'capture_id':
      return isNullableUuid(value);
    case 'purge_after':
    case 'time':
      return (
        (name === 'purge_after' && value === null) ||
        (typeof value === 'string' && value.length <= 35 && Number.isFinite(Date.parse(value)))
      );
    case 'hold_ids':
      return Array.isArray(value) && value.length <= 80 && value.every(isUuid);
    case 'output_generation':
    case 'publication_transaction_id':
    case 'session_id':
      return isNullableUuid(value);
    case 'incarnation':
      return boundedText(value, 128, false);
    case 'effect_key':
      return boundedText(value, 256, false);
    case 'generation':
    case 'receiving_epoch':
    case 'publication_position':
    case 'collection_fence':
    case 'account_fence':
    case 'scanned':
      return isBigint(value, name === 'receiving_epoch' || name === 'publication_position');
    case 'scope':
      return value === 'curated' || value === 'private_builtin' || value === maxScope;
    case 'driver':
      return typeof value === 'string' && allowedDrivers.has(value as NativeSourceDriver);
    case 'after':
      return value === null || boundedText(value, 512);
    case 'tie':
      return boundedText(value, 64);
    default:
      return false;
  }
}

function validRawBinds(id: StatementId, values: Readonly<Record<string, unknown>>): boolean {
  if (id === 'rawChange') {
    const after = values.after;
    return (
      typeof after === 'string' &&
      /^(0|[1-9][0-9]{0,9})$/.test(after) &&
      Number(after) <= maxInt &&
      isUuid(values.session_id)
    );
  }
  if (id === 'rawUnit') return boundedCharacters(values.after, 128) && isUuid(values.session_id);
  if (id === 'rawMember') return boundedCharacters(values.after, 48) && isUuid(values.tie);
  if (id === 'rawAssignment' || id === 'rawCopy') return isNullableUuid(values.after) && isUuid(values.tie);
  if (id === 'rawEntry') return isNullableUuid(values.after) && boundedText(values.tie, 64);
  if (id === 'rawSession') return isNullableUuid(values.after);
  if (id === 'rawEntryDeleted' || id === 'rawLabel' || id === 'rawOutput' || id === 'rawExplicitOutput')
    return isNullableUuid(values.after);
  return false;
}

function valuesObject(query: Query, values: readonly unknown[]): Readonly<Record<string, unknown>> | undefined {
  if (query.params.length !== values.length || values.some((value) => value === undefined)) return undefined;
  const result = Object.fromEntries(query.params.map((name, index) => [name, values[index]]));
  if (!query.params.every((name, index) => validParameter(name, values[index]))) return undefined;
  return result;
}

function basisCost(query: Query, values: readonly unknown[]): CostDetail | undefined {
  const bindings = valuesObject(query, values);
  if (!bindings) return undefined;
  const native = nativeIdentitySourceBasisFootprint(query.sql, values);
  if (!native) return undefined;
  const requestBytes = requestBytesFor(query.sql, values);
  const projectionBytes = native.bytes - requestBytes;
  if (!Number.isSafeInteger(projectionBytes) || projectionBytes < 0) return undefined;
  return Object.freeze({
    bound: boundFromWork(native),
    requestBytes,
    projectionBytes,
  });
}

function statementCost(specification: StatementSpec, values: readonly unknown[]): CostDetail | undefined {
  const bindings = valuesObject(specification.query, values);
  if (!bindings || (specification.valid && !specification.valid(bindings))) return undefined;
  const rows = typeof specification.rows === 'number' ? specification.rows : specification.rows(values);
  const keys = typeof specification.keys === 'number' ? specification.keys : specification.keys(values);
  const projectionBytes =
    typeof specification.projectionBytes === 'number'
      ? specification.projectionBytes
      : specification.projectionBytes(values);
  if (rows === undefined || keys === undefined || projectionBytes === undefined) return undefined;
  const requestBytes = requestBytesFor(specification.query.sql, values);
  const work = {
    candidateKeys: keys,
    nativeRows: rows,
    identityMetadataRows: specification.metadata,
    emptySeeks: keys > 0 ? 1 : specification.points,
    nativePoints: specification.points,
    witnessKeys: 0,
  } satisfies Omit<WorkDimensions, 'bytes' | 'statements'>;
  return Object.freeze({
    bound: splitBound(requestBytes, projectionBytes, work),
    requestBytes,
    projectionBytes,
  });
}

const controlSQL = Object.freeze(['BEGIN', 'COMMIT', 'ROLLBACK'] as const);
type ControlSQL = (typeof controlSQL)[number];
function controlCost(sql: string, values: readonly unknown[]): CostDetail | undefined {
  if (!controlSQL.includes(sql as ControlSQL) || values.length !== 0) return undefined;
  const requestBytes = Buffer.byteLength(sql);
  return Object.freeze({
    requestBytes,
    projectionBytes: 0,
    bound: splitBound(requestBytes, 0, {
      candidateKeys: 0,
      nativeRows: 0,
      identityMetadataRows: 0,
      emptySeeks: 0,
      nativePoints: 0,
      witnessKeys: 0,
    }),
  });
}

function maximumCostFor(specification: StatementSpec): CostDetail {
  const values = maxValues(specification.query, specification.maxOverrides);
  if (!values) throw new TypeError(`Unbounded native source custody binds: ${specification.id}`);
  const cost = statementCost(specification, values);
  if (!cost) throw new TypeError(`Unproved native source custody statement: ${specification.id}`);
  return cost;
}

function basisMaximumByQuery() {
  return memoizedValue(basisMaximumByQuery, () =>
    (() => {
      const result = new Map<Query, CostDetail>();
      for (const query of basisQueries()) {
        const values = maxValues(query);
        if (!values) throw new TypeError(`Unbounded native source custody basis binds: ${query.sql}`);
        const cost = basisCost(query, values);
        if (!cost) throw new TypeError(`Unproved native source custody basis: ${query.sql}`);
        result.set(query, cost);
      }
      return result;
    })(),
  );
}
function statementMaximumByQuery() {
  return memoizedValue(
    statementMaximumByQuery,
    () => new Map(statementSpecs().map((specification) => [specification.query, maximumCostFor(specification).bound])),
  );
}

function maximumCost(...costs: readonly CostDetail[]): CostDetail {
  return costs.reduce((largest, candidate) => (candidate.bound.bytes > largest.bound.bytes ? candidate : largest));
}

function sumCostDetails(...costs: readonly CostDetail[]): Readonly<{
  bound: Bound;
  requestBytes: number;
  projectionBytes: number;
}> {
  const bound = sumBounds(...costs.map((cost) => cost.bound));
  const requestBytes = costs.reduce((total, cost) => total + cost.requestBytes, 0);
  const projectionBytes = costs.reduce((total, cost) => total + cost.projectionBytes, 0);
  if (!Number.isSafeInteger(requestBytes) || !Number.isSafeInteger(projectionBytes))
    throw new TypeError('Native source custody byte breakdown overflow');
  return Object.freeze({ bound, requestBytes, projectionBytes });
}

function basisStatementQueries(): Readonly<Record<string, Query>> {
  return memoizedValue(basisStatementQueries, () =>
    Object.freeze({
      identityPartition: nativeIdentityPartitionQuery,
      account: accountQuery,
      source: sourceQuery,
      output: outputQuery,
      fences: fencesQuery,
      identityCapture,
      proof: proofQuery,
    }),
  );
}
const maximumStatementCost = (id: StatementId): CostDetail => {
  const basisQuery = basisStatementQueries()[id];
  if (basisQuery) return basisMaximumByQuery().get(basisQuery)!;
  const specification = specById().get(id);
  if (!specification) throw new TypeError(`Missing native source custody cost: ${id}`);
  return maximumCostFor(specification);
};
const maximumStatement = (id: StatementId) => maximumStatementCost(id).bound;

function checkoutBound() {
  return memoizedValue(checkoutBound, () =>
    declareBound({
      candidateKeys: 0,
      nativeRows: 0,
      identityMetadataRows: 0,
      emptySeeks: 0,
      nativePoints: 1,
      witnessKeys: 0,
      statements: 0,
      bytes: 0,
      engineRequests: 0,
    }),
  );
}

function maximumBound(...bounds: readonly Bound[]): Bound {
  if (!bounds.length) return zeroBound();
  const values = BOUND_AXES.map((axis) => Math.max(...bounds.map((bound) => bound[axis])));
  return declareBound(Object.fromEntries(BOUND_AXES.map((axis, index) => [axis, values[index]])));
}

function repeatCost(cost: CostDetail, multiplicity: number): CostDetail {
  if (!Number.isSafeInteger(multiplicity) || multiplicity < 0)
    throw new TypeError('Invalid native source custody multiplicity');
  const requestBytes = cost.requestBytes * multiplicity;
  const projectionBytes = cost.projectionBytes * multiplicity;
  if (!Number.isSafeInteger(requestBytes) || !Number.isSafeInteger(projectionBytes))
    throw new TypeError('Native source custody byte multiplication overflow');
  return Object.freeze({
    bound: repeatBound(cost.bound, multiplicity),
    requestBytes,
    projectionBytes,
  });
}

function choiceCost(statements: StatementCounts, maximum: number): CostDetail {
  const alternatives = Object.entries(statements).map(([id, multiplicity]) =>
    repeatCost(maximumStatementCost(id as StatementId), maximum * multiplicity!),
  );
  const largest = maximumCost(...alternatives);
  return Object.freeze({
    bound: maximumBound(...alternatives.map((alternative) => alternative.bound)),
    requestBytes: largest.requestBytes,
    projectionBytes: largest.projectionBytes,
  });
}

/** Maximum caller cost for one operation. Runtime dispatch consumes the same statement
 * multiplicities and literal maxima on the caller's live ledger, including held controls.
 */
function operationCost(definition: OperationDefinition): CostDetail {
  const costs: CostDetail[] = [];
  if (definition.checkout)
    costs.push(repeatCost({ bound: checkoutBound(), requestBytes: 0, projectionBytes: 0 }, definition.checkout));
  for (const [id, multiplicity] of Object.entries(definition.fixed))
    costs.push(repeatCost(maximumStatementCost(id as StatementId), multiplicity!));
  for (const [id, multiplicity] of Object.entries(definition.optional))
    costs.push(repeatCost(maximumStatementCost(id as StatementId), multiplicity!));
  for (const choice of Object.values(definition.choices)) costs.push(choiceCost(choice.statements, choice.maximum));
  for (const [sql, multiplicity] of Object.entries(definition.controls))
    costs.push(repeatCost(controlCost(sql, [])!, multiplicity!));
  return sumCostDetails(...costs);
}

function operationDeclaration(definition: OperationDefinition) {
  const bindings = new Set<string>([
    ...Object.keys(definition.fixed),
    ...Object.keys(definition.optional),
    ...Object.values(definition.choices).flatMap((choice) => Object.keys(choice.statements)),
  ]);
  if (Object.keys(definition.controls).length) bindings.add('control');
  return Object.freeze({
    bindings: Object.freeze([...bindings].sort()),
    fixed: definition.fixed,
    optional: definition.optional,
    choices: definition.choices,
    controls: definition.controls,
    checkout: definition.checkout,
    ...(definition.frontier ? { frontier: definition.frontier } : {}),
  });
}

const operationDeclarations = Object.freeze(
  Object.fromEntries(
    Object.entries(operationDefinitions).map(([operation, definition]) => [
      operation,
      operationDeclaration(definition),
    ]),
  ) as Record<CustodyOperation, ReturnType<typeof operationDeclaration>>,
);
function operationCompositions() {
  return memoizedValue(operationCompositions, () =>
    Object.freeze(
      Object.fromEntries(
        Object.entries(operationDefinitions).map(([operation, definition]) => [operation, operationCost(definition)]),
      ) as Record<CustodyOperation, CostDetail>,
    ),
  );
}
function operationCosts() {
  return memoizedValue(operationCosts, () =>
    Object.freeze(
      Object.fromEntries(
        Object.entries(operationCompositions()).map(([operation, cost]) => [
          operation,
          Object.freeze({ requestBytes: cost.requestBytes, projectionBytes: cost.projectionBytes }),
        ]),
      ) as Record<CustodyOperation, Readonly<{ requestBytes: number; projectionBytes: number }>>,
    ),
  );
}
function operationBounds() {
  return memoizedValue(operationBounds, () =>
    Object.freeze(
      Object.fromEntries(
        Object.entries(operationCompositions()).map(([operation, cost]) => [operation, cost.bound]),
      ) as Record<CustodyOperation, Bound>,
    ),
  );
}
function retirementPageBound() {
  return memoizedValue(retirementPageBound, () =>
    sumBounds(maximumStatement('nextCapture'), operationBounds().retireCapture),
  );
}

function deepFreezeOperation<T extends Record<string, unknown>>(value: T): Readonly<T> {
  for (const child of Object.values(value)) {
    if (child && typeof child === 'object' && !Object.isFrozen(child))
      deepFreezeOperation(child as Record<string, unknown>);
  }
  return Object.freeze(value);
}

/** Closed operation-to-statement bindings and finite maxima for the actual custody adapter. */
export function NATIVE_SOURCE_CUSTODY_OPERATION_PLAN() {
  return memoizedValue(NATIVE_SOURCE_CUSTODY_OPERATION_PLAN, () =>
    deepFreezeOperation({
      version: 1 as const,
      owner: 'Library' as const,
      operations: {
        capturePage: {
          declaration: operationDeclarations.capturePage,
          ceiling: operationBounds().capturePage,
          cost: operationCosts().capturePage,
        },
        finishCapture: {
          declaration: operationDeclarations.finishCapture,
          ceiling: operationBounds().finishCapture,
          cost: operationCosts().finishCapture,
        },
        readAndHold: {
          declaration: operationDeclarations.readAndHold,
          ceiling: operationBounds().readAndHold,
          cost: operationCosts().readAndHold,
        },
        revalidateHold: {
          declaration: operationDeclarations.revalidateHold,
          ceiling: operationBounds().revalidateHold,
          cost: operationCosts().revalidateHold,
        },
        releaseHold: {
          declaration: operationDeclarations.releaseHold,
          ceiling: operationBounds().releaseHold,
          cost: operationCosts().releaseHold,
        },
        retireCapture: {
          declaration: operationDeclarations.retireCapture,
          ceiling: operationBounds().retireCapture,
          cost: operationCosts().retireCapture,
        },
      },
      captureStepCeiling: maximumBound(operationBounds().capturePage, operationBounds().finishCapture),
      retirementPageCeiling: retirementPageBound(),
      statementAxes: BOUND_AXES,
      compatibilityReceiptAxes: Object.freeze([
        'candidateKeys',
        'nativeRows',
        'identityMetadataRows',
        'emptySeeks',
        'nativePoints',
        'witnessKeys',
        'statements',
        'bytes',
      ] as const),
      projections: {
        captureRecordBytes: captureProjectionBytes,
        rawDependencyBytes: dependencyProjectionBytes,
        receiptBytes: receiptProjectionBytes,
        holdBytes: holdProjectionBytes,
        retainedHoldBytes: retainedProjectionBytes,
        terminalOwnerBytes: terminalProjectionBytes,
        retirementSourceBytes: retireSourceProjectionBytes,
        retirementHoldBytes: retirementHoldProjectionBytes,
        retirementPlanKeyBytes: retirementPlanKeyProjectionBytes,
      },
      nonSql: Object.freeze({
        authorization: 'Existing native command and Source/Accounts admission remain authoritative.',
        currentness: 'Current command resources, exact owner and immutable deadline are revalidated before dispatch.',
        timeout: 'Checkout and query timeout use the current deadline; they add no SQL or result projection.',
        engineRequests: 'Zero: every declared statement dispatches native SQL.',
      }),
    }),
  );
}

export type NativeSourceCustodyOperation = CustodyOperation;
export function NATIVE_SOURCE_CUSTODY_RETIREMENT_PAGE_BOUND() {
  return memoizedValue(NATIVE_SOURCE_CUSTODY_RETIREMENT_PAGE_BOUND, () => retirementPageBound());
}

function operationBindings() {
  return memoizedValue(
    operationBindings,
    () =>
      new Map<Query, StatementId | 'identityPartition' | 'control'>([
        [nativeIdentityPartitionQuery, 'identityPartition'],
        [partitionQuery, 'identityPartition'],
        [accountQuery, 'account'],
        [sourceQuery, 'source'],
        [outputQuery, 'output'],
        [ensureQuery, 'ensure'],
        [fencesQuery, 'fences'],
        [readQuery, 'read'],
        [startQuery, 'start'],
        [advanceQuery, 'advance'],
        [finishQuery, 'finish'],
        [proofQuery, 'proof'],
        [holdQuery, 'hold'],
        [heldQuery, 'held'],
        [retainedQuery, 'retained'],
        [releaseQuery, 'release'],
        [retireSource, 'retireSource'],
        [retireReceipt, 'retireReceipt'],
        [retireActive, 'retireActive'],
        [retireHolds, 'retireHolds'],
        [retireChildren, 'retireChildren'],
        [retireProof, 'retireProofRow'],
        [retireCapture, 'retireCaptureRow'],
        [identityRetention, 'identityRetention'],
        [nextCapture, 'nextCapture'],
        [terminalScope, 'terminalScope'],
        [rawAssignment, 'rawAssignment'],
        [rawChange, 'rawChange'],
        [rawCopy, 'rawCopy'],
        [rawEntry, 'rawEntry'],
        [rawEntryDeleted, 'rawEntryDeleted'],
        [rawExplicitOutput, 'rawExplicitOutput'],
        [rawLabel, 'rawLabel'],
        [rawMember, 'rawMember'],
        [rawOutput, 'rawOutput'],
        [rawSession, 'rawSession'],
        [rawUnit, 'rawUnit'],
      ]),
  );
}

/** Rejects a recognized statement when it is not bound to this native operation. */
export function nativeSourceCustodyOperationAllows(operation: CustodyOperation, query: Query): boolean {
  const statement = controlSQL.includes(query.sql as ControlSQL) ? 'control' : operationBindings().get(query);
  return (
    statement !== undefined &&
    NATIVE_SOURCE_CUSTODY_OPERATION_PLAN().operations[operation].declaration.bindings.includes(statement)
  );
}

export type NativeSourceCustodyOperationUse = Readonly<{
  statement(query: Query): boolean;
  checkout(): boolean;
}>;

/** Runtime finite multiplicities from the operation declaration used to compose its ceiling. */
export function createNativeSourceCustodyOperationUse(operation: CustodyOperation): NativeSourceCustodyOperationUse {
  const definition = operationDefinitions[operation];
  const statementCounts = new Map<string, number>();
  const choiceCounts = new Map<string, number>();
  let checkouts = 0;
  const consume = (key: string, maximum: number): boolean => {
    const used = statementCounts.get(key) ?? 0;
    if (used >= maximum) return false;
    statementCounts.set(key, used + 1);
    return true;
  };
  return Object.freeze({
    statement(query: Query) {
      if (!nativeSourceCustodyOperationAllows(operation, query)) return false;
      if (controlSQL.includes(query.sql as ControlSQL)) {
        const sql = query.sql as ControlSQL;
        return consume(`control:${sql}`, definition.controls[sql] ?? 0);
      }
      const id = operationBindings().get(query);
      if (!id || id === 'control') return false;
      const fixed = definition.fixed[id];
      if (fixed !== undefined) return consume(`statement:${id}`, fixed);
      const optional = definition.optional[id];
      if (optional !== undefined) return consume(`statement:${id}`, optional);
      for (const [name, choice] of Object.entries(definition.choices)) {
        const maximumForStatement = choice.statements[id as StatementId];
        if (maximumForStatement === undefined) continue;
        const count = choiceCounts.get(name) ?? 0;
        if (count >= choice.maximum || !consume(`choice:${name}:${id}`, maximumForStatement)) return false;
        choiceCounts.set(name, count + 1);
        return true;
      }
      return false;
    },
    checkout() {
      if (checkouts >= definition.checkout) return false;
      checkouts++;
      return true;
    },
  });
}

export function nativeSourceCustodyOperationBound(operation: CustodyOperation): Bound {
  return NATIVE_SOURCE_CUSTODY_OPERATION_PLAN().operations[operation].ceiling;
}

/** The Source-selected effect step invokes one raw page or its terminal finish path. */
export function NATIVE_SOURCE_CUSTODY_CAPTURE_STEP_BOUND() {
  return memoizedValue(
    NATIVE_SOURCE_CUSTODY_CAPTURE_STEP_BOUND,
    () => NATIVE_SOURCE_CUSTODY_OPERATION_PLAN().captureStepCeiling,
  );
}

function convertedCost(query: Query, values: readonly unknown[]): CostDetail | undefined {
  if (basisQuerySet().has(query)) {
    const cost = basisCost(query, values);
    const ceiling = basisMaximumByQuery().get(query)?.bound;
    return cost && ceiling && withinCeiling(cost.bound, ceiling) ? cost : undefined;
  }
  const specification = specByQuery().get(query);
  if (!specification) return undefined;
  const cost = statementCost(specification, values);
  const ceiling = statementMaximumByQuery().get(query);
  return cost && ceiling && withinCeiling(cost.bound, ceiling) ? cost : undefined;
}

/** Exact runtime query-object pricing. Unknown SQL has no compatibility estimate. */
export function nativeSourceCustodyExecutionBound(query: Query, values: readonly unknown[]): Bound | undefined {
  if (basisQuerySet().has(query) || specByQuery().has(query)) return convertedCost(query, values)?.bound;
  const control = controlCost(query.sql, values);
  return control?.bound;
}

/** Nine-axis declaration for original-work composition and SQL-backed dispatch. */
export function nativeSourceCustodyStatementBound(sql: string, values: readonly unknown[]): Bound | undefined {
  const control = controlCost(sql, values);
  if (control) return control.bound;
  const query = queryBySql().get(sql);
  return query ? convertedCost(query, values)?.bound : undefined;
}

/** Lookup-only eight-axis receipt adapter for callers not yet using operation objects. */
export function nativeSourceCustodyFootprint(sql: string, values: readonly unknown[]): WorkDimensions | undefined {
  const bound = nativeSourceCustodyStatementBound(sql, values);
  return bound ? nativeSourceCustodyWorkDimensions(bound) : undefined;
}
