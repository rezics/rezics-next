import { declareBound, repeatBound, sumBounds, withinCeiling, type Bound } from '@rezics/bounds';
import type { WorkDimensions } from './collection-source.ts';
import type { NativeCollectionWork } from './collection-source-work.ts';
import { libraryIdentitySQL } from './identity-native-planner-statements.ts';
import plan from './identity-native-planner-read.sql';
import job from './identity-native-planner-job.sql';
import seal from './identity-scope-effects-seal.sql';
import time from '../command/time.sql';
import fence from '../command/fence.sql';
import noEffectFence from '../command/no-effect-fence.sql';
import partition from '../partition/read.sql';
import account from '../access/account-share.sql';
import commit from '../semantic/identity-epoch-store-insert-native-commit.sql';
import savedJob from '../semantic/identity-epoch-store-select-job-4.sql';
import libraryTransform from '../semantic/identity-epoch-store-library-transform.sql';
import { identityEpochLibraryInputsSQL } from '../semantic/identity-adapters/identity-epoch-library-inputs.ts';
import inputs from '../semantic/identity-epoch-store-select-input.sql';
import originals from '../semantic/identity-epoch-store-select-original.sql';
import owners from '../semantic/identity-epoch-read-owners.sql';
import sources from '../semantic/identity-epoch-read-sources.sql';
import pending from '../semantic/identity-epoch-read-pending.sql';
import mapping from '../semantic/identity-epoch-read-current.sql';
import facts from './collection-source-native-facts.sql';
import labels from './owner-index-native-label-originals.sql';
import accountQuery from './native-source-custody-account.sql';
import sourceQuery from './native-source-custody-source.sql';
import outputQuery from './native-source-custody-output.sql';
import fencesQuery from './native-source-custody-fences.sql';
import identityCapture from './identity-native-planner-source.sql';
import proofQuery from './native-source-custody-proof.sql';
import {
  LIBRARY_IDENTITY_PLAN_RESULT_BYTES,
  LIBRARY_IDENTITY_SELECTED_STATEMENTS,
  libraryIdentityBoundedPlanSQL,
  libraryIdentitySelectedBindBound,
} from './identity-native-planner-projection.ts';

type LibraryWork = Omit<Bound, 'engineRequests'>;
type Query = Readonly<{ sql: string; params: readonly string[] }>;
type StatementPart = Readonly<{
  work: Bound;
  resultBytes: number;
}>;

const normalize = (sql: string) =>
  sql
    .replace(/--[^\n]*/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/;$/, '')
    .trim();
const equal = (left: string, right: string) => normalize(left) === normalize(right);
const part = (values: Partial<LibraryWork> = {}): LibraryWork => ({
  candidateKeys: values.candidateKeys ?? 0,
  nativeRows: values.nativeRows ?? 0,
  identityMetadataRows: values.identityMetadataRows ?? 0,
  emptySeeks: values.emptySeeks ?? 0,
  nativePoints: values.nativePoints ?? 0,
  witnessKeys: values.witnessKeys ?? 0,
  statements: values.statements ?? 0,
  bytes: values.bytes ?? 0,
});
/** All planner SQL is local native work; translate the shared nine-axis vocabulary explicitly. */
function bound(values: Partial<LibraryWork> = {}): Bound {
  const work = part(values);
  return declareBound({
    candidateKeys: work.candidateKeys,
    nativeRows: work.nativeRows,
    identityMetadataRows: work.identityMetadataRows,
    emptySeeks: work.emptySeeks,
    nativePoints: work.nativePoints,
    witnessKeys: work.witnessKeys,
    statements: work.statements,
    bytes: work.bytes,
    engineRequests: 0,
  });
}
function workDimensions(value: Bound): WorkDimensions {
  if (value.engineRequests !== 0) throw new TypeError('Library SQL cannot declare engine requests');
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
function bindText(values: readonly unknown[]): string | undefined {
  const text = JSON.stringify(values, (_key, value) => (typeof value === 'bigint' ? value.toString() : value));
  return typeof text === 'string' ? text : undefined;
}
function expectedBindCount(sql: string): number {
  const text = normalize(sql);
  let highest = 0;
  for (const match of text.matchAll(/\$(\d+)/g)) highest = Math.max(highest, Number(match[1]));
  if (highest > 0) return highest;
  return new Set([...text.matchAll(/(?<!:):([a-z_][a-z_0-9]*)/g)].map((match) => match[1])).size;
}
function base(sql: string, values: readonly unknown[]): Bound | undefined {
  const serialized = bindText(values);
  if (serialized === undefined || values.length !== expectedBindCount(sql)) return undefined;
  return bound({
    statements: 1,
    bytes: Buffer.byteLength(sql) + Buffer.byteLength(serialized),
  });
}
function one(
  sql: string,
  values: readonly unknown[],
  nativeRows: number,
  nativePoints: number,
  identityMetadataRows: number,
  resultBytes: number,
  candidateKeys = 0,
  emptySeeks = 0,
): Bound | undefined {
  const query = base(sql, values);
  if (!query) return undefined;
  return sumBounds(
    query,
    bound({
      candidateKeys,
      nativeRows,
      identityMetadataRows,
      nativePoints,
      emptySeeks,
      bytes: resultBytes,
    }),
  );
}
function count(value: unknown, max: number): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= max ? value : undefined;
}
function ranged(
  sql: string,
  values: readonly unknown[],
  limitParameter: number,
  resultBytesPerItem: number,
  candidates: boolean,
  max = 100,
  itemDeclaration?: Bound,
): Bound | undefined {
  const n = count(values[limitParameter - 1], max);
  const query = base(sql, values);
  if (n === undefined || !query) return undefined;
  const item = sumBounds(
    itemDeclaration ?? bound({ candidateKeys: candidates ? 1 : 0, nativeRows: 1 }),
    bound({ bytes: resultBytesPerItem }),
  );
  const tail = bound({ nativeRows: 1, nativePoints: 1, emptySeeks: 1 });
  const actual = sumBounds(query, repeatBound(item, n), tail);
  const ceiling = sumBounds(query, repeatBound(item, max), tail);
  return withinCeiling(actual, ceiling) ? actual : undefined;
}
function repeatedRows(
  sql: string,
  values: readonly unknown[],
  inputIndex: number,
  rowsPerItem: number,
  pointsPerItem: number,
  metadataPerItem: number,
  bytesPerItem: number,
  max = 100,
): Bound | undefined {
  const source = values[inputIndex];
  const n = Array.isArray(source) ? count(source.length, max) : undefined;
  const query = base(sql, values);
  if (n === undefined || !query) return undefined;
  const item = bound({
    nativeRows: rowsPerItem,
    identityMetadataRows: metadataPerItem,
    emptySeeks: 1,
    nativePoints: pointsPerItem,
    bytes: bytesPerItem,
  });
  const actual = sumBounds(query, repeatBound(item, n));
  const ceiling = sumBounds(query, repeatBound(item, max));
  return withinCeiling(actual, ceiling) ? actual : undefined;
}
function declaredPoint(
  sql: string,
  values: readonly unknown[],
  declaration: Readonly<{ work: Bound; resultBytes: number }>,
): Bound | undefined {
  const statement = base(sql, values);
  return statement ? sumBounds(statement, declaration.work, bound({ bytes: declaration.resultBytes })) : undefined;
}
function projected(
  _sql: string,
  _values: readonly unknown[],
  rows: number,
  points: number,
  metadata: number,
  output: number,
  seeks = 0,
  candidates = 0,
): StatementPart {
  return Object.freeze({
    work: bound({
      candidateKeys: candidates,
      nativeRows: rows,
      nativePoints: points,
      identityMetadataRows: metadata,
      emptySeeks: seeks,
    }),
    resultBytes: output,
  });
}

export const libraryIdentityJobSizeSQL =
  'SELECT octet_length(intent::text) AS bytes FROM semantic.identity_epoch_job WHERE partition_no=$1 AND job_id=$2 AND epoch=$3';

export const nativeIdentityPartitionQuery: Query = Object.freeze({
  sql: `SELECT epoch, position::text AS position, write_state AS "writeState",
    CASE WHEN moved_to IS NULL THEN NULL ELSE '' END AS "movedTo"
    FROM core.partition WHERE partition_no=$1 FOR SHARE`,
  params: Object.freeze(['partition_no']),
});
const boundId = 'f'.repeat(36);
const boundDecimal = '9'.repeat(20);
const boundText = String.fromCharCode(1);
const basisBindings: Readonly<Record<string, unknown>> = Object.freeze({
  route: 65535,
  account_route: 65535,
  partition_no: 4095,
  owner_epoch: 2147483647,
  collection_id: boundId,
  account_id: boundId,
  capture_id: boundId,
  output_generation: boundId,
  publication_transaction_id: boundId,
  publication_position: boundDecimal,
  incarnation: boundText.repeat(128),
  generation: boundDecimal,
  scope: 'active_explicit_output',
  receiving_epoch: boundDecimal,
  effect_key: boundText.repeat(256),
  collection_fence: boundDecimal,
  account_fence: boundDecimal,
});
const basisQueries = Object.freeze(
  [nativeIdentityPartitionQuery, accountQuery, sourceQuery, outputQuery, fencesQuery, identityCapture, proofQuery].map(
    (query) => Object.freeze({ sql: query.sql, params: Object.freeze([...query.params]) }),
  ) satisfies readonly Query[],
);
const currentCaptureProjectionBytes = Buffer.byteLength(
  JSON.stringify({
    captureId: boundId,
    collectionFence: boundDecimal,
    accountFence: boundDecimal,
    complete: false,
    driver: 'entry_deleted',
    after: boundText.repeat(512),
    tie: boundText.repeat(64),
    sessionId: boundId,
    scanned: boundDecimal,
    version: 2147483647,
  }),
);
const basisProjectionBytes = new Map<Query, number>([
  [
    nativeIdentityPartitionQuery,
    Buffer.byteLength(
      JSON.stringify({ epoch: 2147483647, position: boundDecimal, writeState: 'active', movedTo: null }),
    ),
  ],
  [accountQuery, Buffer.byteLength(JSON.stringify({ state: 'suspended', fenced: false, epoch: boundDecimal }))],
  [
    sourceQuery,
    Buffer.byteLength(
      JSON.stringify({
        accountId: boundId,
        incarnation: boundText.repeat(128),
        generation: boundDecimal,
        state: 'deleted',
        kind: 'dynamic',
        builtin: 'everything',
        visibility: 'unlisted',
        ruleReady: false,
      }),
    ),
  ],
  [
    outputQuery,
    Buffer.byteLength(
      JSON.stringify({
        generation: boundId,
        transactionId: boundId,
        position: boundDecimal,
        nativeXid: boundDecimal,
        members: boundDecimal,
        memberFence: boundDecimal,
        sourceGeneration: boundDecimal,
      }),
    ),
  ],
  [
    fencesQuery,
    Buffer.byteLength(
      JSON.stringify([
        { kind: 'collection', generation: boundDecimal },
        { kind: 'account', generation: boundDecimal },
      ]),
    ),
  ],
  [identityCapture, currentCaptureProjectionBytes],
  [proofQuery, Buffer.byteLength(JSON.stringify({ transactionId: boundId, position: boundDecimal }))],
]);
const basisWork = new Map<Query, Bound>([
  [nativeIdentityPartitionQuery, bound({ nativeRows: 16, nativePoints: 1, identityMetadataRows: 1, emptySeeks: 1 })],
  [accountQuery, bound({ nativeRows: 16, nativePoints: 1 })],
  [sourceQuery, bound({ nativeRows: 16, nativePoints: 1 })],
  [outputQuery, bound({ nativeRows: 56, nativePoints: 7, identityMetadataRows: 1, emptySeeks: 1 })],
  [fencesQuery, bound({ nativeRows: 32, nativePoints: 2 })],
  [identityCapture, bound({ nativeRows: 32, nativePoints: 1 })],
  [proofQuery, bound({ nativeRows: 64, nativePoints: 3, identityMetadataRows: 1, emptySeeks: 1 })],
]);
const basisBindBounds = new Map(
  basisQueries.map((query) => [
    normalize(query.sql),
    Buffer.byteLength(JSON.stringify(query.params.map((name) => basisBindings[name]))),
  ]),
);

const nativeSQLParts: Readonly<Record<keyof typeof libraryIdentitySQL, StatementPart>> = Object.freeze({
  oldFacts: projected(libraryIdentitySQL.oldFacts, [], 0, 1, 0, 256, 1),
  oldReferences: projected(libraryIdentitySQL.oldReferences, [], 0, 1, 0, 256, 1),
  invalidateKey: projected(libraryIdentitySQL.invalidateKey, [], 1, 1, 0, 64, 1),
  invalidateKeyInline: projected(libraryIdentitySQL.invalidateKeyInline, [], 1, 1, 0, 64, 1),
  retainedGenerations: projected(libraryIdentitySQL.retainedGenerations, [], 3, 1, 0, 256, 1),
  oldHead: projected(libraryIdentitySQL.oldHead, [], 1, 1, 0, 128, 1),
  oldState: projected(libraryIdentitySQL.oldState, [], 1, 1, 0, 1024, 1),
  invalidateGeneration: projected(libraryIdentitySQL.invalidateGeneration, [], 1, 1, 0, 64, 1),
  abandonWorking: projected(libraryIdentitySQL.abandonWorking, [], 1, 1, 0, 64, 1),
  insertGeneration: projected(libraryIdentitySQL.insertGeneration, [], 2, 2, 0, 64, 1),
  insertPlan: projected(libraryIdentitySQL.insertPlan, [], 4, 4, 0, 64, 1),
  advanceCapture: projected(libraryIdentitySQL.advanceCapture, [], 1, 1, 0, 64, 1),
  mappingClaim: projected(libraryIdentitySQL.mappingClaim, [], 2, 2, 2, 256, 1),
  insertEffect: projected(libraryIdentitySQL.insertEffect, [], 2, 2, 0, 64, 1),
  readEffect: projected(libraryIdentitySQL.readEffect, [], 1, 1, 0, 4608, 1),
  insertReference: projected(libraryIdentitySQL.insertReference, [], 2, 2, 0, 64, 1),
  advanceGeneration: projected(libraryIdentitySQL.advanceGeneration, [], 1, 1, 0, 64, 1),
  advancePlan: projected(libraryIdentitySQL.advancePlan, [], 1, 1, 0, 64, 1),
  detachHead: projected(libraryIdentitySQL.detachHead, [], 2, 2, 0, 64, 1),
  detachState: projected(libraryIdentitySQL.detachState, [], 2, 2, 0, 64, 1),
  insertSeal: projected(libraryIdentitySQL.insertSeal, [], 2, 2, 0, 64, 1),
  sealPlan: projected(libraryIdentitySQL.sealPlan, [], 1, 1, 0, 64, 1),
  nextPlan: projected(libraryIdentitySQL.nextPlan, [], 2, 1, 0, 2304, 1),
  effectPage: projected(libraryIdentitySQL.effectPage, [], 0, 1, 0, 512, 1),
});
type SQLDeclarations = Readonly<
  Record<keyof typeof libraryIdentitySQL, Readonly<{ sql: string; work: Bound; resultBytes: number }>>
>;
const sqlDeclarations = Object.freeze(
  Object.fromEntries(
    Object.entries(nativeSQLParts).map(([name, value]) => [
      name,
      Object.freeze({
        sql: libraryIdentitySQL[name as keyof typeof libraryIdentitySQL],
        work: Object.freeze(value.work),
        resultBytes: value.resultBytes,
      }),
    ]),
  ) as SQLDeclarations,
);

const selectedParts: Readonly<Record<keyof typeof LIBRARY_IDENTITY_SELECTED_STATEMENTS, StatementPart>> = Object.freeze(
  {
    plan: projected(
      LIBRARY_IDENTITY_SELECTED_STATEMENTS.plan.sql,
      LIBRARY_IDENTITY_SELECTED_STATEMENTS.plan.values,
      1,
      1,
      0,
      LIBRARY_IDENTITY_PLAN_RESULT_BYTES,
      1,
    ),
    current: projected(
      LIBRARY_IDENTITY_SELECTED_STATEMENTS.current.sql,
      LIBRARY_IDENTITY_SELECTED_STATEMENTS.current.values,
      7,
      7,
      1,
      64,
      1,
    ),
    job: projected(
      LIBRARY_IDENTITY_SELECTED_STATEMENTS.job.sql,
      LIBRARY_IDENTITY_SELECTED_STATEMENTS.job.values,
      16,
      13,
      16,
      2048,
      4,
    ),
    seal: projected(
      LIBRARY_IDENTITY_SELECTED_STATEMENTS.seal.sql,
      LIBRARY_IDENTITY_SELECTED_STATEMENTS.seal.values,
      5,
      5,
      2,
      256,
      1,
    ),
    // The selected page's declaration is one item; its native EOF term is composed separately.
    page: projected(
      LIBRARY_IDENTITY_SELECTED_STATEMENTS.page.sql,
      LIBRARY_IDENTITY_SELECTED_STATEMENTS.page.values,
      1,
      0,
      0,
      512,
      0,
      1,
    ),
  },
);
type SelectedDeclarations = Readonly<
  Record<
    keyof typeof LIBRARY_IDENTITY_SELECTED_STATEMENTS,
    Readonly<{ sql: string; values: readonly unknown[]; work: Bound; resultBytes: number }>
  >
>;
const selectedDeclarations = Object.freeze(
  Object.fromEntries(
    Object.entries(LIBRARY_IDENTITY_SELECTED_STATEMENTS).map(([name, statement]) => [
      name,
      Object.freeze({ ...statement, ...selectedParts[name as keyof typeof selectedParts] }),
    ]),
  ) as SelectedDeclarations,
);

/** Immutable Library-owned declarations. Each result projection remains beside its exact SQL identity. */
export const LIBRARY_IDENTITY_NATIVE_OPERATION_DECLARATIONS = Object.freeze({
  sql: sqlDeclarations,
  selected: selectedDeclarations,
  sourceBasis: Object.freeze(
    basisQueries.map((query) => {
      const values = Object.freeze(query.params.map((name) => basisBindings[name]));
      return Object.freeze({
        sql: query.sql,
        values,
        work: nativeIdentitySourceBasisBound(query.sql, values)!,
      });
    }),
  ),
});

export function isNativeIdentitySourceBasisSQL(sql: string): boolean {
  return basisBindBounds.has(normalize(sql));
}
export function isLibraryIdentityFullPartitionSQL(sql: string): boolean {
  return equal(sql, partition.sql);
}

/** Exact shared native-basis declaration used by planner execution, custody and original composition. */
export function nativeIdentitySourceBasisBound(sql: string, values: readonly unknown[]): Bound | undefined {
  const query = basisQueries.find((item) => equal(item.sql, sql));
  if (!query || values.length !== query.params.length) return undefined;
  const serialized = bindText(values);
  if (serialized === undefined || Buffer.byteLength(serialized) > basisBindBounds.get(normalize(sql))!)
    return undefined;
  const queryBound = base(sql, values);
  if (!queryBound) return undefined;
  // basisQueries holds frozen copies; the work and projection tables are keyed by the original queries.
  const original = [...basisWork.keys()].find((item) => item.sql === query.sql)!;
  return sumBounds(queryBound, basisWork.get(original)!, bound({ bytes: basisProjectionBytes.get(original)! }));
}
export function nativeIdentitySourceBasisFootprint(
  sql: string,
  values: readonly unknown[],
): WorkDimensions | undefined {
  const value = nativeIdentitySourceBasisBound(sql, values);
  return value ? workDimensions(value) : undefined;
}
export function declareNativeIdentitySourceBasisStatements(): readonly Readonly<{
  sql: string;
  work: WorkDimensions;
  engineRequests: 0;
}>[] {
  return Object.freeze(
    basisQueries.map((query) => {
      const values = query.params.map((name) => basisBindings[name]);
      const value = nativeIdentitySourceBasisBound(query.sql, values)!;
      return Object.freeze({ sql: query.sql, work: workDimensions(value), engineRequests: 0 as const });
    }),
  );
}

/** The one executable planner declaration shared with the original invocation composer. */
export function libraryIdentityNativeOperationBound(
  sql: string,
  values: readonly unknown[],
  work?: NativeCollectionWork,
): Bound | undefined {
  if (!Array.isArray(values)) return undefined;
  if (isNativeIdentitySourceBasisSQL(sql)) return nativeIdentitySourceBasisBound(sql, values);
  if (!libraryIdentitySelectedBindBound(sql, values)) return undefined;
  const text = normalize(sql);
  const selected = LIBRARY_IDENTITY_NATIVE_OPERATION_DECLARATIONS.selected;
  const point = (rows: number, points: number, metadata: number, output: number, candidates = 0, seeks = 0) =>
    one(sql, values, rows, points, metadata, output, candidates, seeks);
  if (
    [
      'BEGIN ISOLATION LEVEL SERIALIZABLE',
      'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY',
      'BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY',
      'COMMIT',
      'ROLLBACK',
      "SET LOCAL lock_timeout = '200ms'",
    ].includes(text) ||
    /^SET LOCAL statement_timeout = '[1-9][0-9]*ms'$/.test(text)
  )
    return point(0, 0, 0, 0);
  if (equal(sql, time.sql)) return point(0, 0, 0, 128);
  if (equal(sql, partition.sql)) {
    // The full Core projection is retained for standalone compatibility. The work adapter
    // refuses it on a selected prepaid original without same-snapshot size evidence.
    return point(1, 1, 1, 256, 0, 1);
  }
  if (equal(sql, account.sql)) return point(1, 1, 0, 64, 0, 1);
  if (equal(sql, noEffectFence.sql) && values[2] === null) return point(1, 1, 1, 64, 0, 1);
  if (equal(sql, fence.sql) && values[3] === null && values[4] === null) {
    if (values.length !== expectedBindCount(sql)) return undefined;
    const events = typeof values[1] === 'string' ? JSON.parse(values[1]) : values[1];
    if (
      !Array.isArray(events) ||
      events.length !== 1 ||
      events[0]?.type !== 'com.rezics.semantic.identity-epoch.admitted.v1'
    )
      return undefined;
    return point(2, 2, 1, 64);
  }
  if (equal(sql, commit.sql) && values[2] === 'library-private-follow-counts') return point(2, 2, 1, 64);
  if (equal(sql, selected.plan.sql) || equal(sql, libraryIdentityBoundedPlanSQL))
    return declaredPoint(sql, values, selected.plan);
  if (equal(sql, plan.sql) || equal(sql, plan.sql.replace(/;\s*$/, ' FOR UPDATE')))
    return point(1, 1, 0, LIBRARY_IDENTITY_PLAN_RESULT_BYTES, 0, 1);
  if (equal(sql, selected.current.sql)) return declaredPoint(sql, values, selected.current);
  if (equal(sql, selected.job.sql)) return declaredPoint(sql, values, selected.job);
  if (equal(sql, job.sql)) return point(16, 13, 16, 2048, 0, 4);
  if (equal(sql, selected.page.sql))
    return ranged(sql, values, 6, selected.page.resultBytes, true, 100, selected.page.work);
  if (equal(sql, selected.seal.sql)) return declaredPoint(sql, values, selected.seal);
  if (equal(sql, libraryIdentityJobSizeSQL)) return point(1, 1, 1, 32, 0, 1);
  if (equal(sql, libraryTransform.sql)) return point(3, 3, 2, 256, 0, 3);
  if (equal(sql, identityEpochLibraryInputsSQL)) return point(3, 1, 3, 512, 0, 1);
  if (equal(sql, savedJob.sql)) {
    if (values.length !== expectedBindCount(sql) || bindText(values) === undefined) return undefined;
    const resultBound = work?.resultByteBound(`library-job:${values[1]}:${values[2]}`);
    if (
      resultBound === undefined ||
      !Number.isSafeInteger(resultBound) ||
      resultBound < 0 ||
      resultBound > Number.MAX_SAFE_INTEGER - 256
    )
      return undefined;
    return point(1, 1, 1, resultBound + 256, 0, 1);
  }
  if (equal(sql, inputs.sql)) return point(3, 1, 3, 512, 0, 1);
  if (equal(sql, originals.sql)) {
    const n = count(values[2], 100);
    if (n === undefined) return undefined;
    return point(n + 1, 1, n + 1, n * 256, 0, 1);
  }
  for (const [statement, rows, points, metadata, output] of [
    [owners.sql, 1, 1, 1, 256],
    [sources.sql, 4, 4, 4, 1024],
    [pending.sql, 1, 1, 1, 256],
    [mapping.sql, 2, 2, 2, 256],
  ] as const) {
    if (!equal(sql, statement)) continue;
    return repeatedRows(sql, values, 0, rows, points, metadata, output);
  }
  if (equal(sql, facts.sql) || equal(sql, labels.sql)) return ranged(sql, values, 5, 256, true);
  for (const [name, declaration] of Object.entries(LIBRARY_IDENTITY_NATIVE_OPERATION_DECLARATIONS.sql)) {
    if (!equal(sql, declaration.sql)) continue;
    if (name === 'oldFacts') return ranged(sql, values, 8, declaration.resultBytes, true);
    if (name === 'oldReferences') return ranged(sql, values, 7, declaration.resultBytes, true);
    if (name === 'effectPage') return ranged(sql, values, 6, declaration.resultBytes, true);
    const statement = base(sql, values);
    if (!statement) return undefined;
    return sumBounds(statement, declaration.work, bound({ bytes: declaration.resultBytes }));
  }
  return undefined;
}

export function libraryIdentitySelectedOperationBound(sql: string, values: readonly unknown[]): Bound | undefined {
  if (!libraryIdentitySelectedBindBound(sql, values)) return undefined;
  const selected = Object.values(LIBRARY_IDENTITY_NATIVE_OPERATION_DECLARATIONS.selected).some(
    (item) =>
      equal(item.sql, sql) ||
      (item === LIBRARY_IDENTITY_NATIVE_OPERATION_DECLARATIONS.selected.plan &&
        equal(libraryIdentityBoundedPlanSQL, sql)),
  );
  if (!selected) return undefined;
  return libraryIdentityNativeOperationBound(sql, values);
}
export function libraryIdentityNativeOperationFootprint(
  sql: string,
  values: readonly unknown[],
  work?: NativeCollectionWork,
): WorkDimensions | undefined {
  const value = libraryIdentityNativeOperationBound(sql, values, work);
  return value ? workDimensions(value) : undefined;
}
export function libraryIdentitySelectedFootprint(sql: string, values: readonly unknown[]): WorkDimensions | undefined {
  const value = libraryIdentitySelectedOperationBound(sql, values);
  return value ? workDimensions(value) : undefined;
}
