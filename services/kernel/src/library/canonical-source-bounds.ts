import { statementBytes } from '../sql/statement-bytes.ts';
/** Closed Library-owned plan for canonical Collection generation repair, publication and completed-pointer readback.
 * Declarations constrain dispatch; they never fund a ledger or mint native authority.
 */
import { BOUND_AXES, declareBound, repeatBound, sumBounds, withinCeiling, type Bound } from '@rezics/bounds';
import type { IdentityScopeWork } from '../semantic/identity-scope-types.ts';
import ownersSql from '../semantic/identity-epoch-read-owners.sql';
import sourcesSql from '../semantic/identity-epoch-read-sources.sql';
import pendingSql from '../semantic/identity-epoch-read-pending.sql';
import currentSql from '../semantic/identity-terminal-closure-current.sql';
import { OPERATIONAL_WORK_COST } from '../history/operational-work-budget.ts';
import {
  SELECTED_CLEANUP_DECLARATION,
  SELECTED_COST,
  WORK_EXECUTION_ATTEMPT_BOUND,
} from '../work/selected-runtime-cost.ts';
import type { WorkDimensions, WorkReceipt } from './collection-source.ts';
import ownerFactsSql from './collection-source-native-facts.sql';
import labelOriginalsSql from './owner-index-native-label-originals.sql';
import { CANONICAL_SOURCE_RAW_KEY_LIMIT } from './canonical-source-limits.ts';
export { CANONICAL_SOURCE_RAW_KEY_LIMIT } from './canonical-source-limits.ts';

export const CANONICAL_SOURCE_AXES = BOUND_AXES;
export const CANONICAL_SOURCE_ZONE_AGGREGATE = 256;
export const CANONICAL_SOURCE_GENERATION_CAPACITY = 2;
export const CANONICAL_SOURCE_SCOPE_CAPACITY = 2;
export const CANONICAL_SOURCE_ATTEMPTS = WORK_EXECUTION_ATTEMPT_BOUND;
export const CANONICAL_SOURCE_IDENTITY_SWEEP_HOMES = 4096;
export const CANONICAL_SOURCE_IDENTITY_SWEEPS = 2;

const maxUuid = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
const maxRoute = 65535;
const maxInt = 2147483647;
const maxSafe = Number.MAX_SAFE_INTEGER;
const identityJsonCeiling = 4096;
const xidCeiling = 32;

export type CanonicalSourceSqlBound = Bound & Readonly<{ engineRequests: 0 }>;
export type CanonicalSourceStatement = Readonly<{
  name: string;
  sql: string;
  requestBytes: number;
  resultBytes: number;
  rows: number;
  raw: boolean;
  bound: CanonicalSourceSqlBound;
}>;
export type CanonicalSourceRawSplit = Readonly<{
  candidateKeys: number;
  aliasKeys: number;
  duplicateKeys: number;
  lookaheadKeys: number;
  internalDriverKeys: number;
}>;
export type CanonicalSourceRawKey = Readonly<{
  driver: string;
  storedSubjectId: string;
  factId: string;
}>;

const sqlBound = (value: Omit<Bound, 'engineRequests'>): CanonicalSourceSqlBound => {
  const declared = declareBound({ ...value, engineRequests: 0 });
  return Object.freeze({ ...declared, engineRequests: 0 });
};

const jsonBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const bytesOf = (sql: string, values: unknown, resultBytes: number) =>
  statementBytes(sql) + jsonBytes(values) + resultBytes;

const maxIdentityObject = JSON.parse(`{"k":"${'a'.repeat(identityJsonCeiling - 8)}"}`);
const maxScopeRow = jsonBytes([
  {
    identity: maxIdentityObject,
    frontier: {
      captureId: maxUuid,
      driver: 'entry_deleted',
      after: '\u0001'.repeat(512),
      tie: '\u0001'.repeat(64),
      sessionId: maxUuid,
      scanned: '9'.repeat(20),
      version: maxInt,
    },
    capture: maxUuid,
    revision: String(maxSafe),
  },
]);
const maxGenerationRow = jsonBytes([
  {
    generation: maxUuid,
    basis: {
      digest: 'f'.repeat(64),
      incarnation: `${maxUuid}:${'9'.repeat(20)}`,
      authority: { kind: 'private_builtin', curatorAccountId: maxUuid },
      sourceFence: 'f'.repeat(64),
      identity: { digest: 'f'.repeat(64) },
      meaning: 'f'.repeat(64),
      originalCoverage: 'owner-facts-v1',
    },
    driver: 'member',
    after_subject: maxUuid,
    after_fact: maxUuid,
    source_exhausted: true,
    state: 'abandoned',
    version: String(maxSafe),
  },
]);
const maxHeadRow = jsonBytes([{ generation: maxUuid }]);
const maxSeekRow = jsonBytes([{ subject: maxUuid }]);
const maxReferenceRow = jsonBytes([{ original: maxUuid, driver: 5, fact: maxUuid }]);
const maxLockRow = jsonBytes([{ generation: maxUuid }]);
const maxRetainedRow = jsonBytes([{ generation: maxUuid }]);
const maxScopeFenceRow = jsonBytes([{ source_fence: 'f'.repeat(64) }]);
const maxMappingSourceRow = jsonBytes({
  subject_id: maxUuid,
  route: maxRoute,
  original: maxUuid,
  terminal: maxUuid,
  epoch: maxSafe,
  origin: 'published',
  recorded_transaction_id: maxUuid,
  control_partition: 4095,
  control_group: maxUuid,
  source_revision: maxSafe,
  owner_epoch: maxInt,
  erasure_key: maxSafe,
  closure_state: 'withdrawn',
  closure_enrollment: maxUuid,
  closure_generation: maxUuid,
  closure_incarnation: maxUuid,
  closure_immediate: maxUuid,
  closure_export_transaction: maxUuid,
  closure_hold_transaction: maxUuid,
  closure_hold_xid: 'x'.repeat(xidCeiling),
  closure_registration_transaction: maxUuid,
  closure_install_transaction: maxUuid,
  closure_install_xid: 'x'.repeat(xidCeiling),
  closure_ack_transaction: maxUuid,
  closure_ack_xid: 'x'.repeat(xidCeiling),
  closure_source_reservation: maxUuid,
  closure_claim: maxUuid,
  closure_withdraw_transaction: maxUuid,
  closure_withdraw_xid: 'x'.repeat(xidCeiling),
  closure_successor_ticket: maxUuid,
  closure_successor_original: maxUuid,
  closure_ticket_reservation: maxUuid,
  closure_mutation_xid: 'x'.repeat(xidCeiling),
  closure_cancelled_successor: true,
  dirty_revision: maxSafe,
  captured_revision: maxSafe,
  current_target: maxUuid,
});
const maxPartitionRow = jsonBytes({
  partition_no: 4095,
  epoch: maxInt,
  position: String(maxSafe),
  write_state: 'frozen',
});
const maxPendingRow = jsonBytes({
  partition_no: 4095,
  terminal: maxUuid,
  pending_job: maxUuid,
  pending_epoch: maxSafe,
});
const maxCurrentRow = jsonBytes({
  partition_no: 4095,
  terminal: maxUuid,
  published_epoch: maxSafe,
  owner_epoch: maxInt,
  generation: maxUuid,
  closure_state: 'withdrawn',
  closure_incarnation: maxUuid,
  requested_original: maxUuid,
  directory_state: 'withdrawn',
  directory_enrollment: maxUuid,
  directory_incarnation: maxUuid,
  directory_install: maxUuid,
  directory_export: maxUuid,
  directory_revision: String(maxSafe),
  directory_owner: maxInt,
  registration_transaction: maxUuid,
  redirected: true,
});
const maxOwnerFactRow = jsonBytes({ storedSubjectId: maxUuid, factId: maxUuid });
const maxInsertValues = [maxRoute, maxUuid, maxUuid, maxUuid, maxUuid, 5, maxUuid];
const maxGroupValues = [maxRoute, maxUuid, maxUuid, maxUuid, maxUuid, 5, maxUuid, CANONICAL_SOURCE_RAW_KEY_LIMIT];
const maxScopeValues = [maxRoute, maxUuid, 'f'.repeat(64)];
const maxGenerationValues = [maxRoute, maxUuid, maxUuid];
const maxPointValues = [maxRoute, maxUuid];
const maxWorkingValues = [maxRoute, maxUuid];
const maxSourceLockValues = [maxRoute, maxUuid, maxUuid, `${maxUuid}:${'9'.repeat(20)}`];
const maxFactLockValues = [maxRoute, maxUuid];
const maxOwnerFactValues = {
  route: maxRoute,
  account_id: maxUuid,
  driver: 'session',
  after_subject: maxUuid,
  after_fact: maxUuid,
  limit: CANONICAL_SOURCE_RAW_KEY_LIMIT,
};
const maxOwnersValues = [[4095]];
const maxSourcesValues = [[maxUuid], [maxRoute]];
const maxPendingValues = [[4095], [maxUuid]];
const maxCurrentValues = [[4095], [maxUuid], [maxUuid]];

const point = (sql: string, values: unknown, resultBytes: number, rows = 1, nativeRows = 4): CanonicalSourceSqlBound =>
  sqlBound({
    candidateKeys: 0,
    nativeRows,
    identityMetadataRows: 0,
    emptySeeks: 1,
    nativePoints: 1,
    witnessKeys: 0,
    statements: 1,
    bytes: bytesOf(sql, values, resultBytes),
  });

const statement = (
  name: string,
  sql: string,
  values: unknown,
  resultBytes: number,
  rows: number,
  bound: CanonicalSourceSqlBound,
  raw = false,
): CanonicalSourceStatement => {
  const requestBytes = statementBytes(sql) + jsonBytes(values);
  if (requestBytes + resultBytes !== bound.bytes) {
    const proved = sqlBound({ ...bound, bytes: requestBytes + resultBytes });
    return Object.freeze({ name, sql, requestBytes, resultBytes, rows, raw, bound: proved });
  }
  return Object.freeze({ name, sql, requestBytes, resultBytes, rows, raw, bound });
};

export const CANONICAL_SOURCE_SQL = Object.freeze({
  scope: `SELECT identity,frontier,capture_id::text AS capture,committed_revision::text AS revision
  FROM library.canonical_source_scope WHERE route=$1 AND collection_id=$2 AND source_fence=$3`,
  head: 'SELECT generation::text FROM library.canonical_source_head WHERE route=$1 AND collection_id=$2',
  generation: `SELECT generation::text,basis,driver,after_subject::text,after_fact::text,source_exhausted,state,version::text
  FROM library.canonical_source_generation WHERE route=$1 AND collection_id=$2 AND generation=$3`,
  workingGeneration: `SELECT generation::text,basis,driver,after_subject::text,after_fact::text,source_exhausted,state,version::text
  FROM library.canonical_source_generation WHERE route=$1 AND collection_id=$2 AND state='working' FOR UPDATE`,
  generationLock: `SELECT generation::text,basis,driver,after_subject::text,after_fact::text,source_exhausted,state,version::text
  FROM library.canonical_source_generation WHERE route=$1 AND collection_id=$2 AND generation=$3 FOR UPDATE`,
  sourceLock: `SELECT source_generation::text AS generation FROM library.collection WHERE route=$1 AND collection_id=$2 AND state='active' AND curator_account_id=$3 AND collection_id::text || ':' || extract(epoch FROM created_at)::text=$4 FOR UPDATE`,
  factLock: 'SELECT generation::text FROM library.fact_source_head WHERE route=$1 AND account_id=$2 FOR SHARE',
  abandon: `UPDATE library.canonical_source_generation SET state='abandoned' WHERE route=$1 AND collection_id=$2 AND generation=$3`,
  retainedGenerations: `SELECT generation FROM library.canonical_source_generation WHERE route=$1 AND collection_id=$2 ORDER BY generation LIMIT 2`,
  insertGeneration: `INSERT INTO library.canonical_source_generation(route,collection_id,generation,basis,driver) VALUES($1,$2,$3,$4::jsonb,$5)`,
  seek: `SELECT canonical_subject_id::text AS subject FROM library.canonical_source_reference
     WHERE route=$1 AND collection_id=$2 AND generation=$3 AND canonical_subject_id>COALESCE($4::uuid,'00000000-0000-0000-0000-000000000000')
     ORDER BY canonical_subject_id,stored_subject_id,driver,fact_id LIMIT 1`,
  group: `SELECT stored_subject_id::text AS original,driver,fact_id::text AS fact FROM library.canonical_source_reference
     WHERE route=$1 AND collection_id=$2 AND generation=$3 AND canonical_subject_id=$4
       AND (stored_subject_id,driver,fact_id)>(COALESCE($5::uuid,'00000000-0000-0000-0000-000000000000'),COALESCE($6::smallint,-1),COALESCE($7::uuid,'00000000-0000-0000-0000-000000000000'))
     ORDER BY stored_subject_id,driver,fact_id LIMIT $8`,
  insertReference: `INSERT INTO library.canonical_source_reference(route,collection_id,generation,canonical_subject_id,stored_subject_id,driver,fact_id)
        VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
  updateFrontier: `UPDATE library.canonical_source_generation SET driver=$4,after_subject=$5,after_fact=$6,source_exhausted=$7,version=version+1
      WHERE route=$1 AND collection_id=$2 AND generation=$3`,
  completeGeneration: `UPDATE library.canonical_source_generation SET state='complete' WHERE route=$1 AND collection_id=$2 AND generation=$3`,
  publishHead: `INSERT INTO library.canonical_source_head(route,collection_id,generation) VALUES($1,$2,$3)
      ON CONFLICT(route,collection_id) DO UPDATE SET generation=EXCLUDED.generation`,
  retainedScopes: `SELECT source_fence FROM library.canonical_source_scope WHERE route=$1 AND collection_id=$2 ORDER BY source_fence LIMIT 2`,
  insertScope: `INSERT INTO library.canonical_source_scope(route,collection_id,source_fence,identity) VALUES($1,$2,$3,$4::jsonb) ON CONFLICT DO NOTHING`,
  updateScopeFrontier: `UPDATE library.canonical_source_scope SET frontier=$4::jsonb
        WHERE route=$1 AND collection_id=$2 AND source_fence=$3 AND frontier IS NOT DISTINCT FROM $5::jsonb RETURNING collection_id`,
  commitScopeCapture: `UPDATE library.canonical_source_scope s
        SET frontier=i.frontier,capture_id=i.capture_id,committed_revision=i.revision
        FROM semantic.identity_scope_summary i
        WHERE s.route=$1 AND s.collection_id=$2 AND s.source_fence=$3
          AND i.partition_no=$6 AND i.source_key=$7 AND i.scope_id=$8
          AND i.capture_id=$4 AND i.revision=$5 AND i.state='ready' AND i.active=0 AND i.scan_complete
          AND i.source=jsonb_build_object('kind','library','identity',s.identity)
          AND i.frontier->>'driver'='done' AND (i.frontier->>'captureId')::uuid=i.capture_id`,
});

const seekValues = [maxRoute, maxUuid, maxUuid, maxUuid];
const maxBasisJson = JSON.stringify({
  digest: 'f'.repeat(64),
  incarnation: `${maxUuid}:${'9'.repeat(20)}`,
  authority: { kind: 'private_builtin', curatorAccountId: maxUuid },
  sourceFence: 'f'.repeat(64),
  identity: { digest: 'f'.repeat(64) },
  meaning: 'f'.repeat(64),
  originalCoverage: 'owner-facts-v1',
});
const maxFrontierString = JSON.stringify({
  captureId: maxUuid,
  driver: 'entry_deleted',
  after: '\u0001'.repeat(512),
  tie: '\u0001'.repeat(64),
  sessionId: maxUuid,
  scanned: '9'.repeat(20),
  version: maxInt,
});
const insertGenerationValues = [maxRoute, maxUuid, maxUuid, maxBasisJson, 'member'];
const updateFrontierValues = [maxRoute, maxUuid, maxUuid, 'session', maxUuid, maxUuid, true];
const updateScopeFrontierValues = [maxRoute, maxUuid, 'f'.repeat(64), maxFrontierString, maxFrontierString];
const commitScopeValues = [
  maxRoute,
  maxUuid,
  'f'.repeat(64),
  maxUuid,
  String(maxSafe),
  4095,
  '\u0001'.repeat(4096),
  'collection-source',
];
const insertScopeValues = [maxRoute, maxUuid, 'f'.repeat(64), 'a'.repeat(identityJsonCeiling)];

export const CANONICAL_SOURCE_STATEMENTS = Object.freeze({
  scope: statement(
    'canonical-source-scope',
    CANONICAL_SOURCE_SQL.scope,
    maxScopeValues,
    maxScopeRow,
    1,
    point(CANONICAL_SOURCE_SQL.scope, maxScopeValues, maxScopeRow, 1, 4),
  ),
  head: statement(
    'canonical-source-head',
    CANONICAL_SOURCE_SQL.head,
    maxPointValues,
    maxHeadRow,
    1,
    point(CANONICAL_SOURCE_SQL.head, maxPointValues, maxHeadRow),
  ),
  generation: statement(
    'canonical-source-generation',
    CANONICAL_SOURCE_SQL.generation,
    maxGenerationValues,
    maxGenerationRow,
    1,
    point(CANONICAL_SOURCE_SQL.generation, maxGenerationValues, maxGenerationRow, 1, 8),
  ),
  workingGeneration: statement(
    'canonical-source-working-generation',
    CANONICAL_SOURCE_SQL.workingGeneration,
    maxWorkingValues,
    maxGenerationRow,
    1,
    point(CANONICAL_SOURCE_SQL.workingGeneration, maxWorkingValues, maxGenerationRow, 1, 8),
  ),
  generationLock: statement(
    'canonical-source-generation-lock',
    CANONICAL_SOURCE_SQL.generationLock,
    maxGenerationValues,
    maxGenerationRow,
    1,
    point(CANONICAL_SOURCE_SQL.generationLock, maxGenerationValues, maxGenerationRow, 1, 8),
  ),
  sourceLock: statement(
    'canonical-source-collection-lock',
    CANONICAL_SOURCE_SQL.sourceLock,
    maxSourceLockValues,
    maxLockRow,
    1,
    point(CANONICAL_SOURCE_SQL.sourceLock, maxSourceLockValues, maxLockRow),
  ),
  factLock: statement(
    'canonical-source-fact-lock',
    CANONICAL_SOURCE_SQL.factLock,
    maxFactLockValues,
    maxLockRow,
    1,
    point(CANONICAL_SOURCE_SQL.factLock, maxFactLockValues, maxLockRow),
  ),
  abandon: statement(
    'canonical-source-abandon',
    CANONICAL_SOURCE_SQL.abandon,
    maxGenerationValues,
    0,
    0,
    point(CANONICAL_SOURCE_SQL.abandon, maxGenerationValues, 0),
  ),
  retainedGenerations: statement(
    'canonical-source-retained-generations',
    CANONICAL_SOURCE_SQL.retainedGenerations,
    maxPointValues,
    maxRetainedRow * CANONICAL_SOURCE_GENERATION_CAPACITY,
    CANONICAL_SOURCE_GENERATION_CAPACITY,
    point(
      CANONICAL_SOURCE_SQL.retainedGenerations,
      maxPointValues,
      maxRetainedRow * CANONICAL_SOURCE_GENERATION_CAPACITY,
      CANONICAL_SOURCE_GENERATION_CAPACITY,
      8,
    ),
  ),
  insertGeneration: statement(
    'canonical-source-insert-generation',
    CANONICAL_SOURCE_SQL.insertGeneration,
    insertGenerationValues,
    0,
    0,
    point(CANONICAL_SOURCE_SQL.insertGeneration, insertGenerationValues, 0, 0, 6),
  ),
  seek: statement(
    'canonical-group-seek',
    CANONICAL_SOURCE_SQL.seek,
    seekValues,
    maxSeekRow,
    1,
    sqlBound({
      candidateKeys: 1,
      nativeRows: 8,
      identityMetadataRows: 0,
      emptySeeks: 1,
      nativePoints: 1,
      witnessKeys: 0,
      statements: 1,
      bytes: bytesOf(CANONICAL_SOURCE_SQL.seek, seekValues, maxSeekRow),
    }),
    true,
  ),
  insertReference: statement(
    'canonical-source-insert-reference',
    CANONICAL_SOURCE_SQL.insertReference,
    maxInsertValues,
    0,
    0,
    point(CANONICAL_SOURCE_SQL.insertReference, maxInsertValues, 0, 0, 4),
  ),
  updateFrontier: statement(
    'canonical-source-update-frontier',
    CANONICAL_SOURCE_SQL.updateFrontier,
    updateFrontierValues,
    0,
    0,
    point(CANONICAL_SOURCE_SQL.updateFrontier, updateFrontierValues, 0, 0, 6),
  ),
  completeGeneration: statement(
    'canonical-source-complete-generation',
    CANONICAL_SOURCE_SQL.completeGeneration,
    maxGenerationValues,
    0,
    0,
    point(CANONICAL_SOURCE_SQL.completeGeneration, maxGenerationValues, 0),
  ),
  publishHead: statement(
    'canonical-source-publish-head',
    CANONICAL_SOURCE_SQL.publishHead,
    [maxRoute, maxUuid, maxUuid],
    0,
    0,
    point(CANONICAL_SOURCE_SQL.publishHead, [maxRoute, maxUuid, maxUuid], 0, 0, 6),
  ),
  retainedScopes: statement(
    'canonical-source-retained-scopes',
    CANONICAL_SOURCE_SQL.retainedScopes,
    maxPointValues,
    maxScopeFenceRow * CANONICAL_SOURCE_SCOPE_CAPACITY,
    CANONICAL_SOURCE_SCOPE_CAPACITY,
    point(
      CANONICAL_SOURCE_SQL.retainedScopes,
      maxPointValues,
      maxScopeFenceRow * CANONICAL_SOURCE_SCOPE_CAPACITY,
      CANONICAL_SOURCE_SCOPE_CAPACITY,
      8,
    ),
  ),
  insertScope: statement(
    'canonical-source-insert-scope',
    CANONICAL_SOURCE_SQL.insertScope,
    insertScopeValues,
    0,
    0,
    point(CANONICAL_SOURCE_SQL.insertScope, insertScopeValues, 0, 0, 6),
  ),
  updateScopeFrontier: statement(
    'canonical-source-update-scope-frontier',
    CANONICAL_SOURCE_SQL.updateScopeFrontier,
    updateScopeFrontierValues,
    jsonBytes([{ collection_id: maxUuid }]),
    1,
    point(CANONICAL_SOURCE_SQL.updateScopeFrontier, updateScopeFrontierValues, jsonBytes([{ collection_id: maxUuid }])),
  ),
  commitScopeCapture: statement(
    'canonical-source-commit-scope-capture',
    CANONICAL_SOURCE_SQL.commitScopeCapture,
    commitScopeValues,
    0,
    0,
    point(CANONICAL_SOURCE_SQL.commitScopeCapture, commitScopeValues, 0, 0, 12),
  ),
});

export function canonicalSourceGroupStatement(limit: number): CanonicalSourceStatement {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > CANONICAL_SOURCE_RAW_KEY_LIMIT)
    throw new RangeError('Canonical Source group limit must be 1..100');
  const resultBytes = maxReferenceRow * limit;
  const bound = sqlBound({
    candidateKeys: limit,
    nativeRows: 8 * limit + 8,
    identityMetadataRows: 0,
    emptySeeks: 1,
    nativePoints: 1,
    witnessKeys: 0,
    statements: 1,
    bytes: bytesOf(CANONICAL_SOURCE_SQL.group, maxGroupValues, resultBytes),
  });
  return statement('canonical-group-page', CANONICAL_SOURCE_SQL.group, maxGroupValues, resultBytes, limit, bound, true);
}

const metadataBound = sqlBound({
  candidateKeys: 0,
  nativeRows: 24,
  identityMetadataRows: 0,
  emptySeeks: 5,
  nativePoints: 5,
  witnessKeys: 0,
  statements: 5,
  bytes: 2_097_152,
});
const identitySweepBound = sqlBound({
  candidateKeys: 0,
  nativeRows: CANONICAL_SOURCE_IDENTITY_SWEEP_HOMES * CANONICAL_SOURCE_IDENTITY_SWEEPS,
  identityMetadataRows: CANONICAL_SOURCE_IDENTITY_SWEEP_HOMES * CANONICAL_SOURCE_IDENTITY_SWEEPS,
  emptySeeks: CANONICAL_SOURCE_IDENTITY_SWEEPS,
  nativePoints: CANONICAL_SOURCE_IDENTITY_SWEEPS,
  witnessKeys: 0,
  statements: CANONICAL_SOURCE_IDENTITY_SWEEPS,
  bytes: identityJsonCeiling * CANONICAL_SOURCE_IDENTITY_SWEEPS,
});

const mappingOwners = sqlBound({
  candidateKeys: 0,
  nativeRows: 2,
  identityMetadataRows: 0,
  emptySeeks: 1,
  nativePoints: 1,
  witnessKeys: 0,
  statements: 1,
  bytes: bytesOf(ownersSql.sql, maxOwnersValues, maxPartitionRow),
});
const mappingSources = sqlBound({
  candidateKeys: 0,
  nativeRows: 8,
  identityMetadataRows: 0,
  emptySeeks: 1,
  nativePoints: 4,
  witnessKeys: 0,
  statements: 1,
  bytes: bytesOf(sourcesSql.sql, maxSourcesValues, maxMappingSourceRow),
});
const mappingPending = sqlBound({
  candidateKeys: 0,
  nativeRows: 2,
  identityMetadataRows: 0,
  emptySeeks: 1,
  nativePoints: 1,
  witnessKeys: 0,
  statements: 1,
  bytes: bytesOf(pendingSql.sql, maxPendingValues, maxPendingRow),
});
const mappingCurrent = sqlBound({
  candidateKeys: 0,
  nativeRows: 6,
  identityMetadataRows: 0,
  emptySeeks: 1,
  nativePoints: 4,
  witnessKeys: 0,
  statements: 1,
  bytes: bytesOf(currentSql.sql, maxCurrentValues, maxCurrentRow),
});
const mappingCollect = sumBounds(mappingOwners, mappingSources, mappingOwners, mappingPending, mappingCurrent);
const mappingOriginal = sumBounds(mappingCollect, mappingCollect);

export function canonicalSourceMappingBound(originalCount: number): CanonicalSourceSqlBound {
  if (!Number.isSafeInteger(originalCount) || originalCount < 0 || originalCount > CANONICAL_SOURCE_RAW_KEY_LIMIT)
    throw new RangeError('Canonical Source mapping page must contain at most 100 originals');
  const total = repeatBound(mappingOriginal, originalCount);
  if (total.engineRequests !== 0) throw new TypeError('Canonical Source mapping cannot issue engine requests');
  return Object.freeze({ ...total, engineRequests: 0 });
}

const ownerFactsCeiling = Math.max(
  bytesOf(ownerFactsSql.sql, maxOwnerFactValues, maxOwnerFactRow * CANONICAL_SOURCE_RAW_KEY_LIMIT),
  bytesOf(labelOriginalsSql.sql, maxOwnerFactValues, maxOwnerFactRow * CANONICAL_SOURCE_RAW_KEY_LIMIT),
);

export function canonicalSourceOwnerFactBound(limit: number): CanonicalSourceSqlBound {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > CANONICAL_SOURCE_RAW_KEY_LIMIT)
    throw new RangeError('Owner fact limit must be 1..100');
  const sqlBytes = Math.max(statementBytes(ownerFactsSql), statementBytes(labelOriginalsSql));
  const requestBytes = sqlBytes + jsonBytes(maxOwnerFactValues);
  const resultBytes = maxOwnerFactRow * limit;
  return sqlBound({
    candidateKeys: limit,
    nativeRows: 8 * limit + 8,
    identityMetadataRows: 0,
    emptySeeks: 1,
    nativePoints: 1,
    witnessKeys: 0,
    statements: 1,
    bytes: requestBytes + resultBytes,
  });
}

export function canonicalSourceRawWindowBound(limit: number): CanonicalSourceSqlBound {
  const owner = canonicalSourceOwnerFactBound(limit);
  const collection = sqlBound({
    candidateKeys: limit,
    nativeRows: 8 * limit + 8,
    identityMetadataRows: 0,
    emptySeeks: 1,
    nativePoints: 1,
    witnessKeys: 0,
    statements: 1,
    bytes: Math.max(owner.bytes, ownerFactsCeiling),
  });
  return owner.bytes >= collection.bytes ? owner : collection;
}

export const CANONICAL_SOURCE_RECEIVING_COST = Object.freeze({
  metadata: metadataBound,
  sourceScope: CANONICAL_SOURCE_STATEMENTS.scope.bound,
  sourceHead: CANONICAL_SOURCE_STATEMENTS.head.bound,
  sourceGeneration: CANONICAL_SOURCE_STATEMENTS.generation.bound,
  seek: CANONICAL_SOURCE_STATEMENTS.seek.bound,
  group(limit: number): CanonicalSourceSqlBound {
    return canonicalSourceGroupStatement(limit).bound;
  },
  state: sumBounds(
    metadataBound,
    CANONICAL_SOURCE_STATEMENTS.scope.bound,
    CANONICAL_SOURCE_STATEMENTS.head.bound,
    CANONICAL_SOURCE_STATEMENTS.generation.bound,
  ),
});

const observation = sumBounds(metadataBound, CANONICAL_SOURCE_STATEMENTS.scope.bound, identitySweepBound);
const begin = sumBounds(
  CANONICAL_SOURCE_STATEMENTS.sourceLock.bound,
  CANONICAL_SOURCE_STATEMENTS.factLock.bound,
  CANONICAL_SOURCE_STATEMENTS.workingGeneration.bound,
  CANONICAL_SOURCE_STATEMENTS.abandon.bound,
  CANONICAL_SOURCE_STATEMENTS.retainedGenerations.bound,
  CANONICAL_SOURCE_STATEMENTS.insertGeneration.bound,
  SELECTED_COST.enqueue,
);
const repairWrite = (limit: number) =>
  sumBounds(
    CANONICAL_SOURCE_STATEMENTS.sourceLock.bound,
    CANONICAL_SOURCE_STATEMENTS.factLock.bound,
    CANONICAL_SOURCE_STATEMENTS.generationLock.bound,
    repeatBound(CANONICAL_SOURCE_STATEMENTS.insertReference.bound, limit),
    CANONICAL_SOURCE_STATEMENTS.updateFrontier.bound,
    SELECTED_COST.enqueue,
  );
const publish = sumBounds(
  CANONICAL_SOURCE_STATEMENTS.sourceLock.bound,
  CANONICAL_SOURCE_STATEMENTS.factLock.bound,
  CANONICAL_SOURCE_STATEMENTS.generationLock.bound,
  CANONICAL_SOURCE_STATEMENTS.completeGeneration.bound,
  CANONICAL_SOURCE_STATEMENTS.publishHead.bound,
);
const readback = sumBounds(
  observation,
  CANONICAL_SOURCE_STATEMENTS.head.bound,
  CANONICAL_SOURCE_STATEMENTS.generation.bound,
);
const executionAttempt = sumBounds(OPERATIONAL_WORK_COST.attempt, SELECTED_COST.enqueue, SELECTED_COST.rollback);
const executionEnvelope = sumBounds(
  SELECTED_COST.consume,
  repeatBound(executionAttempt, CANONICAL_SOURCE_ATTEMPTS),
  SELECTED_CLEANUP_DECLARATION,
);

export const CANONICAL_SOURCE_TERMS = Object.freeze({
  observation,
  begin,
  rawWindow: canonicalSourceRawWindowBound(CANONICAL_SOURCE_RAW_KEY_LIMIT),
  mapping: canonicalSourceMappingBound(CANONICAL_SOURCE_RAW_KEY_LIMIT),
  repairWrite: repairWrite(CANONICAL_SOURCE_RAW_KEY_LIMIT),
  publish,
  readback,
  seek: CANONICAL_SOURCE_STATEMENTS.seek.bound,
  group: canonicalSourceGroupStatement(CANONICAL_SOURCE_RAW_KEY_LIMIT).bound,
  executionEnvelope,
});

export const CANONICAL_SOURCE_REPAIR_STEP = sumBounds(
  observation,
  observation,
  CANONICAL_SOURCE_TERMS.rawWindow,
  CANONICAL_SOURCE_TERMS.mapping,
  CANONICAL_SOURCE_TERMS.repairWrite,
  executionEnvelope,
);
export const CANONICAL_SOURCE_PUBLICATION_STEP = sumBounds(observation, publish, executionEnvelope);
export const CANONICAL_SOURCE_COMPLETED_READBACK = readback;

if (CANONICAL_SOURCE_REPAIR_STEP.candidateKeys > CANONICAL_SOURCE_RAW_KEY_LIMIT)
  throw new TypeError('Canonical Source repair step exceeds the native 100 raw ceiling');
if (CANONICAL_SOURCE_REPAIR_STEP.engineRequests !== 0)
  throw new TypeError('Canonical Source repair cannot issue engine requests');

export const CANONICAL_SOURCE_DECLARATION = Object.freeze({
  status: 'complete' as const,
  axes: CANONICAL_SOURCE_AXES,
  limits: Object.freeze({
    rawKeys: CANONICAL_SOURCE_RAW_KEY_LIMIT,
    zoneAggregate: CANONICAL_SOURCE_ZONE_AGGREGATE,
    generations: CANONICAL_SOURCE_GENERATION_CAPACITY,
    scopes: CANONICAL_SOURCE_SCOPE_CAPACITY,
    attempts: CANONICAL_SOURCE_ATTEMPTS,
    identitySweepHomes: CANONICAL_SOURCE_IDENTITY_SWEEP_HOMES,
    identitySweeps: CANONICAL_SOURCE_IDENTITY_SWEEPS,
  }),
  statements: CANONICAL_SOURCE_STATEMENTS,
  terms: CANONICAL_SOURCE_TERMS,
  repair: CANONICAL_SOURCE_REPAIR_STEP,
  publication: CANONICAL_SOURCE_PUBLICATION_STEP,
  readback: CANONICAL_SOURCE_COMPLETED_READBACK,
  receiving: CANONICAL_SOURCE_RECEIVING_COST,
});

/** Adapter edge for the existing eight-axis native observer. Canonical SQL declares zero engine requests. */
export function canonicalSourceWorkDimensions(bound: Bound): WorkDimensions {
  const declared = declareBound(bound);
  if (declared.engineRequests !== 0)
    throw new TypeError('Canonical Source cannot map engine requests to the native SQL observer');
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

export function canonicalSourceCallAllowance(bound: Bound = CANONICAL_SOURCE_REPAIR_STEP): Readonly<{
  rawKeys: number;
  nativeRows: number;
  nativePoints: number;
  emptySeeks: number;
  statements: number;
  bytes: number;
  identityMetadataRows: number;
}> {
  const declared = canonicalSourceWorkDimensions(bound);
  if (declared.candidateKeys > CANONICAL_SOURCE_RAW_KEY_LIMIT)
    throw new TypeError('Canonical Source step exceeds the native 100 raw ceiling');
  return Object.freeze({
    rawKeys: CANONICAL_SOURCE_RAW_KEY_LIMIT,
    nativeRows: declared.nativeRows,
    nativePoints: declared.nativePoints,
    emptySeeks: declared.emptySeeks,
    statements: declared.statements,
    bytes: declared.bytes,
    identityMetadataRows: declared.identityMetadataRows,
  });
}

export function identityScopeWorkBound(work: IdentityScopeWork): CanonicalSourceSqlBound {
  if (work.outputWork) {
    const used = canonicalSourceWorkDimensions({ ...work.outputWork.used, engineRequests: 0 });
    return sqlBound(used);
  }
  return sqlBound({
    candidateKeys: 0,
    nativeRows: work.rows,
    identityMetadataRows: 0,
    emptySeeks: 0,
    nativePoints: work.points,
    witnessKeys: 0,
    statements: work.statements,
    bytes: work.bytes,
  });
}

export function identityScopeWorkReceipt(work: IdentityScopeWork, reservationId: string): WorkReceipt {
  return Object.freeze({
    reservationId,
    used: canonicalSourceWorkDimensions(identityScopeWorkBound(work)),
  });
}

export function assertCanonicalSourceStatement(
  statement: CanonicalSourceStatement,
  values: readonly unknown[],
): CanonicalSourceSqlBound {
  const requestBytes = statementBytes(statement) + jsonBytes(values);
  if (requestBytes > statement.requestBytes)
    throw new TypeError('Canonical Source statement exceeds its request bound');
  if (statement.bound.engineRequests !== 0)
    throw new TypeError('Canonical Source statement cannot issue engine requests');
  if (!withinCeiling(statement.bound, statement.bound)) throw new TypeError('Canonical Source statement is unbounded');
  return statement.bound;
}

export function canonicalSourceRawSplit(
  keys: readonly CanonicalSourceRawKey[],
  canonicalSubjectId?: string | null,
): CanonicalSourceRawSplit {
  const seen = new Set<string>();
  let candidateKeys = 0,
    duplicateKeys = 0,
    aliasKeys = 0;
  for (const key of keys) {
    if (seen.has(key.storedSubjectId)) {
      duplicateKeys += 1;
      continue;
    }
    seen.add(key.storedSubjectId);
    if (canonicalSubjectId && key.storedSubjectId !== canonicalSubjectId) aliasKeys += 1;
    else candidateKeys += 1;
  }
  return Object.freeze({
    candidateKeys,
    aliasKeys,
    duplicateKeys,
    lookaheadKeys: 0,
    internalDriverKeys: 0,
  });
}

export function canonicalSourceRawTotal(split: CanonicalSourceRawSplit): number {
  const total =
    split.candidateKeys + split.aliasKeys + split.duplicateKeys + split.lookaheadKeys + split.internalDriverKeys;
  if (!Number.isSafeInteger(total) || total < 0) throw new TypeError('Canonical Source raw split overflow');
  if (total > CANONICAL_SOURCE_RAW_KEY_LIMIT)
    throw new TypeError('Canonical Source raw split exceeds the native 100 ceiling');
  return total;
}
