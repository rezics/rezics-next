import { statementBytes } from '../sql/statement-bytes.ts';
/** Immutable Library plans for the activated public Collection output original command.
 * One closed native descriptor serves composition and adapter execution. Values describe work only;
 * native SQL, evidence, custody and dispatch stay Library-owned. `engineRequests` is zero because
 * every leaf is a SQL adapter; a nonzero value is refused rather than folded into eight-axis receipts.
 */
import { declareBound, repeatBound, sumBounds, withinCeiling, type Bound } from '@rezics/bounds';
import type { WorkDimensions } from './collection-source.ts';
import header from './collection-source-native-header.sql';
import head from './collection-source-output-head.sql';
import page from './collection-source-output-page.sql';
import partition from '../partition/read.sql';
import owner from './native-public-output-owner.sql';
import lifecycle from './native-public-output-lifecycle.sql';
import publication from './native-public-output-publication-lock.sql';
import binding from './native-public-output-binding.sql';
import bindingLock from './native-public-output-binding-lock.sql';
import identity from './native-public-output-identity.sql';
import provenance from './native-public-output-provenance.sql';
import xmin from './native-public-output-binding-xmin.sql';
import bind from './native-public-output-bind.sql';
import receiving from './native-public-output-receiving.sql';
import hold from './native-public-output-hold.sql';
import transitionRead from './native-public-output-transition-read.sql';
import transition from './native-public-output-transition.sql';
import consume from './native-public-output-consume.sql';
import fence from './native-public-output-fence.sql';
import retained from './native-public-output-retained.sql';

export const NATIVE_PUBLIC_OUTPUT_PAGE_LIMIT = 100;
export const PUBLIC_OUTPUT_PARTITION_SIZE_SQL =
  'SELECT octet_length(node)::bigint + COALESCE(octet_length(moved_to),0)::bigint AS bytes FROM core.partition WHERE partition_no=$1';
export const PUBLIC_OUTPUT_REFERENCE_SQL =
  'SELECT collection_id FROM library.builtin_collection_reference WHERE route=$1 AND collection_id=$2';
export const PUBLIC_OUTPUT_XID_SQL = 'SELECT pg_current_xact_id()::text AS xid';
export const PUBLIC_OUTPUT_PARTITION_METADATA_SQL =
  'SELECT partition_no AS "partitionNo", write_state AS "writeState", epoch, position::text AS position FROM core.partition WHERE partition_no=$1';
export const PUBLIC_OUTPUT_BEGIN_SQL = 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY';
export const PUBLIC_OUTPUT_COMMIT_SQL = 'COMMIT';
export const PUBLIC_OUTPUT_ROLLBACK_SQL = 'ROLLBACK';

/** Guard-side SQL for a writer composing this additive retention hook.
 * A rekey/update invokes OLD and NEW; a member change also invokes the header counter guard.
 * These are separate literal operations, not a claim about any writer's complete allowance.
 */
export const nativePublicOutputRetentionSQL = Object.freeze({
  owner: 'SELECT 1 FROM library.collection WHERE route=$1 AND collection_id=$2 FOR UPDATE',
  partition: 'SELECT 1 FROM core.partition WHERE partition_no=$1 FOR SHARE',
  collection:
    'SELECT EXISTS(SELECT 1 FROM library.native_public_output_hold WHERE route=$1 AND collection_id=$2 AND consumed_by IS NULL LIMIT 1)',
  output:
    'SELECT EXISTS(SELECT 1 FROM library.native_public_output_hold WHERE route=$1 AND collection_id=$2 AND output_generation=$3 AND consumed_by IS NULL LIMIT 1)',
});

type SqlModule = Readonly<{ sql: string; params?: readonly string[] }>;
export type PublicOutputSizeAdmission = Readonly<{ resultByteBound(key: string): number | undefined }>;
export type NativePublicOutputHoldRole = 'predecessor' | 'successor';
export type NativePublicOutputStatement = Readonly<{
  name: string;
  sql: string;
  bindCount: number;
  requestBytes: number;
  resultBytes: number;
  resultRows: number;
  bound: Bound;
}>;

const id = 'f'.repeat(36);
const hex = 'f'.repeat(64);
const decimal = '9'.repeat(20);
const text = String.fromCharCode(1);
const jsonBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const sqlBytes = statementBytes;
const placeholders = (sql: string) => {
  let count = 0;
  for (const match of sql.matchAll(/\$(\d+)/g)) count = Math.max(count, Number(match[1]));
  return count;
};
const bindCountOf = (source: string | SqlModule) => {
  const sql = typeof source === 'string' ? source : source.sql;
  const named = typeof source === 'string' ? 0 : (source.params?.length ?? 0);
  return Math.max(named, placeholders(sql));
};
const sqlOf = (source: string | SqlModule) => (typeof source === 'string' ? source : source.sql);

const sqlBound = (value: Omit<Bound, 'engineRequests'>): Bound =>
  declareBound(Object.freeze({ ...value, engineRequests: 0 }));

const leaf = (parts: {
  candidateKeys?: number;
  nativeRows: number;
  identityMetadataRows?: number;
  emptySeeks?: number;
  nativePoints: number;
  witnessKeys?: number;
  statements?: number;
  bytes: number;
}): Bound => {
  const statements = parts.statements ?? 1;
  return sqlBound({
    candidateKeys: parts.candidateKeys ?? 0,
    nativeRows: parts.nativeRows,
    identityMetadataRows: parts.identityMetadataRows ?? 0,
    emptySeeks: parts.emptySeeks ?? statements,
    nativePoints: parts.nativePoints,
    witnessKeys: parts.witnessKeys ?? 0,
    statements,
    bytes: parts.bytes,
  });
};

const statement = (
  name: string,
  source: string | SqlModule,
  binds: unknown[],
  result: unknown,
  plan: {
    candidateKeys?: number;
    nativeRows: number;
    identityMetadataRows?: number;
    emptySeeks?: number;
    nativePoints: number;
    witnessKeys?: number;
    statements?: number;
    relationBytes: number;
  },
  resultRows = 1,
): NativePublicOutputStatement => {
  const sql = sqlOf(source);
  const bindCount = bindCountOf(source);
  const requestBytes = sqlBytes(sql) + jsonBytes(binds);
  const resultBytes = Math.max(plan.relationBytes, jsonBytes(result));
  return Object.freeze({
    name,
    sql,
    bindCount,
    requestBytes,
    resultBytes,
    resultRows,
    bound: leaf({
      candidateKeys: plan.candidateKeys ?? 0,
      nativeRows: plan.nativeRows,
      identityMetadataRows: plan.identityMetadataRows ?? 0,
      emptySeeks: plan.emptySeeks ?? plan.statements ?? 1,
      nativePoints: plan.nativePoints,
      witnessKeys: plan.witnessKeys ?? 0,
      statements: plan.statements ?? 1,
      bytes: requestBytes + resultBytes,
    }),
  });
};

const routeBind = 65535;
const partitionBind = 4095;
const epochBind = 2147483647;
const headerBinds = [routeBind, id];
const partitionBinds = [partitionBind];
const captureBinds = [partitionBind, id];
const identityBinds = [routeBind, id, hex];
const holdBinds = (role: NativePublicOutputHoldRole) => [partitionBind, id, id, id, role];
const pageBinds = (limit: number) => [routeBind, id, id, id, limit];
const bindInsertBinds = [
  routeBind,
  id,
  id,
  id,
  text.repeat(128),
  id,
  id,
  decimal,
  decimal,
  epochBind,
  decimal,
  id,
  hex,
  hex,
  hex,
  text.repeat(4096),
];
const transitionBinds = [
  partitionBind,
  id,
  id,
  hex,
  'cancelled',
  null,
  decimal,
  epochBind,
  decimal,
  id,
  'identity-public-output-cancelled',
  text.repeat(8192),
];
const consumeBinds = [partitionBind, id, id];
const fenceBinds = [partitionBind, id, 'cancelled', id, decimal];
const provenanceBinds = [partitionBind, id, epochBind, decimal, 'identity-public-output-capture', decimal, decimal];
const publicationBinds = [routeBind, id, decimal];
const lifecycleBinds = [routeBind, id];
const ownerBinds = [routeBind, id];
const referenceBinds = [routeBind, id];
const retentionOutputBinds = [routeBind, id, id];

const headerRow = Object.freeze({
  route: routeBind,
  collectionId: id,
  curatorAccountId: id,
  state: 'deleted',
  visibility: 'unlisted',
  membershipKind: 'dynamic',
  revision: epochBind,
  createdAt: decimal,
  sourceGeneration: decimal,
  builtinKind: 'everything',
  releaseDigest: hex,
  profileId: id,
  stateSetId: id,
  stateId: id,
  ruleRevision: decimal,
  ruleReleaseDigest: hex,
  ruleReady: false,
});
const publicationRow = Object.freeze({
  generation: id,
  transactionId: id,
  position: decimal,
  nativeXid: decimal,
  members: decimal,
  memberFence: decimal,
  sourceGeneration: decimal,
});
const ownerRow = Object.freeze({
  accountId: id,
  incarnation: text.repeat(128),
  epoch: epochBind,
  position: decimal,
});
const partitionMetadataRow = Object.freeze({
  partitionNo: partitionBind,
  writeState: 'active',
  epoch: epochBind,
  position: decimal,
});
const partitionNodeRow = Object.freeze({
  partitionNo: partitionBind,
  node: text.repeat(1),
  writeState: 'active',
  movedTo: text.repeat(1),
  epoch: epochBind,
  position: 0,
});
const bindingRow = Object.freeze({
  payload: text.repeat(4096),
  bindingDigest: hex,
  nativeXid: decimal,
  transactionId: id,
  epoch: epochBind,
  position: decimal,
  receivingEpoch: decimal,
  state: 'cancelled',
  consumedBy: id,
});
const pageRow = Object.freeze({ storedSubjectId: id, factId: id });
const transitionRow = Object.freeze({
  payload: text.repeat(8192),
  transactionId: id,
  nativeXid: decimal,
  xmin: decimal,
  epoch: epochBind,
  position: decimal,
});

const headerStatement = statement('header', header, headerBinds, headerRow, {
  nativeRows: 4,
  nativePoints: 1,
  relationBytes: 2048,
});
const headStatement = statement('publication-head', head, publicationBinds, publicationRow, {
  nativeRows: 48,
  nativePoints: 7,
  relationBytes: 1024,
});
const publicationStatement = statement('publication-lock', publication, publicationBinds, publicationRow, {
  nativeRows: 48,
  nativePoints: 7,
  relationBytes: 1024,
});
const ownerStatement = statement('owner', owner, ownerBinds, ownerRow, {
  nativeRows: 16,
  nativePoints: 3,
  relationBytes: 512,
});
const lifecycleStatement = statement(
  'lifecycle',
  lifecycle,
  lifecycleBinds,
  { present: 1 },
  { nativeRows: 4, nativePoints: 1, relationBytes: 64 },
);
const partitionSizeStatement = statement(
  'partition-size',
  PUBLIC_OUTPUT_PARTITION_SIZE_SQL,
  partitionBinds,
  { bytes: decimal },
  { nativeRows: 4, nativePoints: 1, relationBytes: 128 },
);
const referenceStatement = statement(
  'reference',
  PUBLIC_OUTPUT_REFERENCE_SQL,
  referenceBinds,
  { collection_id: id },
  { nativeRows: 4, nativePoints: 1, relationBytes: 64 },
);
const xidStatement = statement(
  'xid',
  PUBLIC_OUTPUT_XID_SQL,
  [],
  { xid: decimal },
  { nativeRows: 1, nativePoints: 0, emptySeeks: 1, relationBytes: 64 },
);
const partitionMetadataStatement = statement(
  'partition-metadata',
  PUBLIC_OUTPUT_PARTITION_METADATA_SQL,
  partitionBinds,
  partitionMetadataRow,
  { nativeRows: 4, nativePoints: 1, relationBytes: 128 },
);
const bindingStatement = statement('binding', binding, captureBinds, bindingRow, {
  nativeRows: 16,
  nativePoints: 3,
  relationBytes: 6144,
});
const bindingLockStatement = statement('binding-lock', bindingLock, captureBinds, bindingRow, {
  nativeRows: 16,
  nativePoints: 3,
  relationBytes: 6144,
});
const identityStatement = statement(
  'identity',
  identity,
  identityBinds,
  { captureId: id },
  { nativeRows: 4, nativePoints: 1, relationBytes: 64 },
);
const xminStatement = statement(
  'xmin',
  xmin,
  captureBinds,
  { xmin: decimal },
  { nativeRows: 4, nativePoints: 1, relationBytes: 64 },
);
const provenanceStatement = statement(
  'provenance',
  provenance,
  provenanceBinds,
  { present: 1 },
  { nativeRows: 16, nativePoints: 3, relationBytes: 64 },
);
const retainedStatement = statement(
  'retained',
  retained,
  captureBinds,
  { present: 1 },
  { nativeRows: 24, nativePoints: 5, relationBytes: 64 },
);
const bindStatement = statement(
  'bind',
  bind,
  bindInsertBinds,
  { native_xid: decimal },
  { nativeRows: 160, nativePoints: 32, statements: 3, relationBytes: 32768 },
);
const receivingStatement = statement(
  'receiving',
  receiving,
  captureBinds,
  { present: 1 },
  { nativeRows: 12, nativePoints: 3, relationBytes: 128 },
);
const holdPredecessorStatement = statement(
  'hold-predecessor',
  hold,
  holdBinds('predecessor'),
  { present: 1 },
  { nativeRows: 96, nativePoints: 20, statements: 2, relationBytes: 4096 },
);
const holdSuccessorStatement = statement(
  'hold-successor',
  hold,
  holdBinds('successor'),
  { present: 1 },
  { nativeRows: 96, nativePoints: 20, statements: 4, relationBytes: 4096 },
);
const transitionReadStatement = statement('transition-read', transitionRead, [partitionBind, id], transitionRow, {
  nativeRows: 4,
  nativePoints: 1,
  relationBytes: 9216,
});
const transitionStatement = statement(
  'transition',
  transition,
  transitionBinds,
  { present: 1 },
  { nativeRows: 144, nativePoints: 29, statements: 3, relationBytes: 16384 },
);
const consumeStatement = statement(
  'consume',
  consume,
  consumeBinds,
  { present: 1 },
  { nativeRows: 96, nativePoints: 22, statements: 2, relationBytes: 4096 },
);
const fenceStatement = statement(
  'fence',
  fence,
  fenceBinds,
  { present: 1 },
  { nativeRows: 96, nativePoints: 22, statements: 2, relationBytes: 4096 },
);
const retentionOwnerStatement = statement(
  'retention-owner',
  nativePublicOutputRetentionSQL.owner,
  ownerBinds,
  { present: 1 },
  { nativeRows: 4, nativePoints: 1, relationBytes: 64 },
);
const retentionPartitionStatement = statement(
  'retention-partition',
  nativePublicOutputRetentionSQL.partition,
  partitionBinds,
  { present: 1 },
  { nativeRows: 4, nativePoints: 1, relationBytes: 64 },
);
const retentionCollectionStatement = statement(
  'retention-collection',
  nativePublicOutputRetentionSQL.collection,
  ownerBinds,
  { exists: true },
  { nativeRows: 4, nativePoints: 1, relationBytes: 64 },
);
const retentionOutputStatement = statement(
  'retention-output',
  nativePublicOutputRetentionSQL.output,
  retentionOutputBinds,
  { exists: true },
  { nativeRows: 4, nativePoints: 1, relationBytes: 64 },
);

const control = (name: string, sql: string): NativePublicOutputStatement =>
  Object.freeze({
    name,
    sql,
    bindCount: 0,
    requestBytes: sqlBytes(sql) + jsonBytes([]),
    resultBytes: 0,
    resultRows: 0,
    bound: sqlBound({
      candidateKeys: 0,
      nativeRows: 0,
      identityMetadataRows: 0,
      emptySeeks: 0,
      nativePoints: 0,
      witnessKeys: 0,
      statements: 1,
      bytes: sqlBytes(sql) + jsonBytes([]),
    }),
  });

const beginStatement = control('begin', PUBLIC_OUTPUT_BEGIN_SQL);
const commitStatement = control('commit', PUBLIC_OUTPUT_COMMIT_SQL);
const rollbackStatement = control('rollback', PUBLIC_OUTPUT_ROLLBACK_SQL);

const pageSql = sqlOf(page);
const pageBindCount = bindCountOf(page);
const pageRequestBytes = (limit: number) => sqlBytes(pageSql) + jsonBytes(pageBinds(limit));
const pageResultBytes = (limit: number) => jsonBytes(Array.from({ length: limit }, () => pageRow));
const pageKeyWork = sqlBound({
  candidateKeys: 1,
  nativeRows: 4,
  identityMetadataRows: 0,
  emptySeeks: 0,
  nativePoints: 0,
  witnessKeys: 0,
  statements: 0,
  bytes: Math.max(256, jsonBytes(pageRow)),
});
const pagePlan = (limit: number): Bound => {
  const request = pageRequestBytes(limit);
  return sumBounds(
    leaf({ nativeRows: 4, nativePoints: 1, statements: 1, bytes: request }),
    repeatBound(pageKeyWork, limit),
  );
};

export function nativePublicOutputPageStatement(limit: number): NativePublicOutputStatement | undefined {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > NATIVE_PUBLIC_OUTPUT_PAGE_LIMIT) return undefined;
  return Object.freeze({
    name: 'page',
    sql: pageSql,
    bindCount: pageBindCount,
    requestBytes: pageRequestBytes(limit),
    resultBytes: pageResultBytes(limit),
    resultRows: limit,
    bound: pagePlan(limit),
  });
}

export function nativePublicOutputHoldStatement(role: unknown): NativePublicOutputStatement | undefined {
  if (role !== 'predecessor' && role !== 'successor') return undefined;
  return role === 'successor' ? holdSuccessorStatement : holdPredecessorStatement;
}

const partitionSql = sqlOf(partition);
const partitionBindCount = bindCountOf(partition);
const partitionRequestBytes = sqlBytes(partitionSql) + jsonBytes(partitionBinds);

/** Same-snapshot size admission for the current partition node/moved_to projection. No fixed guess. */
export function nativePublicOutputPartitionStatement(bytes: number): NativePublicOutputStatement | undefined {
  if (!Number.isSafeInteger(bytes) || bytes < 0) return undefined;
  const resultBytes = Math.max(
    bytes,
    jsonBytes({ ...partitionNodeRow, node: text.repeat(1), movedTo: text.repeat(1) }),
  );
  return Object.freeze({
    name: 'partition',
    sql: partitionSql,
    bindCount: partitionBindCount,
    requestBytes: partitionRequestBytes,
    resultBytes,
    resultRows: 1,
    bound: leaf({
      nativeRows: 4,
      nativePoints: 1,
      bytes: partitionRequestBytes + bytes,
    }),
  });
}

export const NATIVE_PUBLIC_OUTPUT_CHECKOUT = sqlBound({
  candidateKeys: 0,
  nativeRows: 0,
  identityMetadataRows: 0,
  emptySeeks: 0,
  nativePoints: 1,
  witnessKeys: 0,
  statements: 0,
  bytes: 0,
});

const staticStatements = Object.freeze([
  headerStatement,
  headStatement,
  publicationStatement,
  ownerStatement,
  lifecycleStatement,
  partitionSizeStatement,
  referenceStatement,
  xidStatement,
  partitionMetadataStatement,
  bindingStatement,
  bindingLockStatement,
  identityStatement,
  xminStatement,
  provenanceStatement,
  retainedStatement,
  bindStatement,
  receivingStatement,
  holdPredecessorStatement,
  holdSuccessorStatement,
  transitionReadStatement,
  transitionStatement,
  consumeStatement,
  fenceStatement,
  retentionOwnerStatement,
  retentionPartitionStatement,
  retentionCollectionStatement,
  retentionOutputStatement,
  beginStatement,
  commitStatement,
  rollbackStatement,
]);

export const NATIVE_PUBLIC_OUTPUT_STATEMENTS = Object.freeze(
  Object.fromEntries(staticStatements.map((entry) => [entry.name, entry])) as Record<
    string,
    NativePublicOutputStatement
  >,
);

const normal = (sql: string) =>
  sql
    .replace(/--[^\n]*/g, '')
    .replace(/\s+/g, ' ')
    .trim();

const staticBySql = new Map<string, NativePublicOutputStatement>();
for (const entry of staticStatements) {
  const key = normal(entry.sql);
  if (key === normal(sqlOf(hold))) continue;
  staticBySql.set(key, entry);
}

const pageKey = normal(pageSql);
const holdKey = normal(sqlOf(hold));
const partitionKey = normal(partitionSql);

function requestFits(entry: NativePublicOutputStatement, sql: string, values: readonly unknown[]): boolean {
  if (values.length !== entry.bindCount) return false;
  let encoded: number;
  try {
    encoded = sqlBytes(sql) + jsonBytes(values);
  } catch {
    return false;
  }
  return encoded <= entry.requestBytes;
}

/** Closed lookup used by composition and the SQL adapter. Unknown statement or bind shapes refuse. */
export function nativePublicOutputStatement(
  sql: string,
  values: readonly unknown[],
  work?: PublicOutputSizeAdmission,
): NativePublicOutputStatement | undefined {
  const key = normal(sql);
  if (key === pageKey) {
    const limit = values[4];
    const entry = typeof limit === 'number' ? nativePublicOutputPageStatement(limit) : undefined;
    return entry && requestFits(entry, sql, values) ? entry : undefined;
  }
  if (key === holdKey) {
    const entry = nativePublicOutputHoldStatement(values[4]);
    return entry && requestFits(entry, sql, values) ? entry : undefined;
  }
  if (key === partitionKey) {
    const admitted = work?.resultByteBound(`partition:${values[0]}`);
    if (admitted === undefined) return undefined;
    const entry = nativePublicOutputPartitionStatement(admitted);
    return entry && requestFits(entry, sql, values) ? entry : undefined;
  }
  const entry = staticBySql.get(key);
  return entry && requestFits(entry, sql, values) ? entry : undefined;
}

export function nativePublicOutputPlan(
  sql: string,
  values: readonly unknown[],
  work?: PublicOutputSizeAdmission,
): Bound | undefined {
  return nativePublicOutputStatement(sql, values, work)?.bound;
}

/** Explicit translation of the nine-axis SQL plan into the older eight-axis native receipt. */
export function nativePublicOutputWorkDimensions(bound: Bound): WorkDimensions {
  const declared = declareBound(bound);
  if (declared.engineRequests !== 0)
    throw new TypeError('Public output SQL adapter cannot map engine requests to the native SQL observer');
  return Object.freeze({
    candidateKeys: declared.candidateKeys,
    nativeRows: declared.nativeRows,
    identityMetadataRows: declared.identityMetadataRows,
    emptySeeks: declared.emptySeeks,
    nativePoints: declared.nativePoints,
    witnessKeys: declared.witnessKeys,
    statements: declared.statements,
    bytes: declared.bytes,
  });
}

const observeCurrent = sumBounds(headerStatement.bound, partitionMetadataStatement.bound, headStatement.bound);
const committedProof = sumBounds(xminStatement.bound, provenanceStatement.bound);
const byIdentity = (locked: boolean) =>
  sumBounds(identityStatement.bound, locked ? bindingLockStatement.bound : bindingStatement.bound);
const currentTuple = (locked: boolean) =>
  locked
    ? sumBounds(observeCurrent, lifecycleStatement.bound, publicationStatement.bound)
    : sumBounds(observeCurrent, lifecycleStatement.bound);
const controls = sumBounds(beginStatement.bound, commitStatement.bound, rollbackStatement.bound);

export const NATIVE_PUBLIC_OUTPUT_JOURNEYS = Object.freeze({
  observe: observeCurrent,
  committed: committedProof,
  read: sumBounds(
    NATIVE_PUBLIC_OUTPUT_CHECKOUT,
    controls,
    byIdentity(false),
    committedProof,
    currentTuple(false),
    pagePlan(NATIVE_PUBLIC_OUTPUT_PAGE_LIMIT),
  ),
  lock: sumBounds(ownerStatement.bound, byIdentity(true), committedProof, currentTuple(true)),
  bindExisting: sumBounds(
    ownerStatement.bound,
    bindingLockStatement.bound,
    xidStatement.bound,
    committedProof,
    currentTuple(true),
  ),
  bindNew: sumBounds(
    ownerStatement.bound,
    bindingLockStatement.bound,
    lifecycleStatement.bound,
    observeCurrent,
    publicationStatement.bound,
    bindStatement.bound,
    receivingStatement.bound,
    holdPredecessorStatement.bound,
  ),
  revalidate: sumBounds(ownerStatement.bound, bindingLockStatement.bound, committedProof, currentTuple(true)),
  transfer: sumBounds(
    bindingStatement.bound,
    ownerStatement.bound,
    bindingLockStatement.bound,
    committedProof,
    transitionReadStatement.bound,
    retainedStatement.bound,
    transitionStatement.bound,
    holdSuccessorStatement.bound,
    consumeStatement.bound,
    fenceStatement.bound,
  ),
  release: sumBounds(
    bindingStatement.bound,
    ownerStatement.bound,
    bindingLockStatement.bound,
    committedProof,
    transitionReadStatement.bound,
    retainedStatement.bound,
    transitionStatement.bound,
    consumeStatement.bound,
    fenceStatement.bound,
  ),
  retention: sumBounds(
    retentionOwnerStatement.bound,
    retentionPartitionStatement.bound,
    retentionCollectionStatement.bound,
    retentionOutputStatement.bound,
  ),
});

export const NATIVE_PUBLIC_OUTPUT_COMMAND_CEILING = sumBounds(
  NATIVE_PUBLIC_OUTPUT_JOURNEYS.read,
  NATIVE_PUBLIC_OUTPUT_JOURNEYS.lock,
  NATIVE_PUBLIC_OUTPUT_JOURNEYS.bindNew,
  NATIVE_PUBLIC_OUTPUT_JOURNEYS.revalidate,
  NATIVE_PUBLIC_OUTPUT_JOURNEYS.transfer,
  NATIVE_PUBLIC_OUTPUT_JOURNEYS.release,
  NATIVE_PUBLIC_OUTPUT_JOURNEYS.retention,
);

if (!withinCeiling(pagePlan(1), pagePlan(NATIVE_PUBLIC_OUTPUT_PAGE_LIMIT)))
  throw new TypeError('Public output page plan is not monotone in its admitted limit');
for (const bound of Object.values(NATIVE_PUBLIC_OUTPUT_JOURNEYS))
  if (!withinCeiling(bound, NATIVE_PUBLIC_OUTPUT_COMMAND_CEILING))
    throw new TypeError('Public output journey exceeds its static ceiling');

export const NATIVE_PUBLIC_OUTPUT_DESCRIPTOR = Object.freeze({
  pageLimit: NATIVE_PUBLIC_OUTPUT_PAGE_LIMIT,
  engineRequests: 0 as const,
  statements: NATIVE_PUBLIC_OUTPUT_STATEMENTS,
  journeys: NATIVE_PUBLIC_OUTPUT_JOURNEYS,
  ceiling: NATIVE_PUBLIC_OUTPUT_COMMAND_CEILING,
  checkout: NATIVE_PUBLIC_OUTPUT_CHECKOUT,
});
