import { memoizedValue } from '../memoized.ts';
import { statementBytes } from '../database/statement-bytes.ts';
/** Closed Library-owned plan for canonical Collection generation repair, publication and completed-pointer readback.
 * Declarations constrain dispatch; they never fund a ledger or mint native authority.
 */
import { BOUND_AXES, declareBound, repeatBound, sumBounds, withinCeiling, type Bound } from '@rezics/bounds';
import {
  SELECTED_CLEANUP_DECLARATION,
  SELECTED_COST,
  WORK_EXECUTION_ATTEMPT_BOUND,
} from '../work/selected-runtime-cost.ts';
import type { WorkDimensions } from './contract/work-dimensions.ts';
import { librarySemanticObservations } from './semantic-observation.ts';
import type { LibrarySemanticObservationCapability } from './contract/semantic-observation.ts';
import ownerFactsSql from './collection-source-native-facts.sql';
import labelOriginalsSql from './owner-index-native-label-originals.sql';
import { CANONICAL_SOURCE_RAW_KEY_LIMIT } from './canonical-source-limits.ts';
import { OPERATIONAL_WORK_COST } from '../history/core/operational-work-budget.ts';
export { CANONICAL_SOURCE_RAW_KEY_LIMIT } from './canonical-source-limits.ts';

export function CANONICAL_SOURCE_AXES() {
  return memoizedValue(CANONICAL_SOURCE_AXES, () => BOUND_AXES);
}
export const CANONICAL_SOURCE_ZONE_AGGREGATE = 256;
export const CANONICAL_SOURCE_GENERATION_CAPACITY = 2;
export const CANONICAL_SOURCE_SCOPE_CAPACITY = 2;
export function CANONICAL_SOURCE_ATTEMPTS() {
  return memoizedValue(CANONICAL_SOURCE_ATTEMPTS, () => WORK_EXECUTION_ATTEMPT_BOUND);
}
export const CANONICAL_SOURCE_IDENTITY_SWEEP_HOMES = 4096;
export const CANONICAL_SOURCE_IDENTITY_SWEEPS = 2;

const maxUuid = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
const maxRoutedUuid = 'ffffffff-ffff-8fff-bfff-ffffffffffff';
const maxRoute = 65535;
const maxInt = 2147483647;
const maxSafe = Number.MAX_SAFE_INTEGER;
const identityJsonCeiling = 4096;

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
  predecessorScope: `SELECT identity,frontier,capture_id::text AS capture,committed_revision::text AS revision
  FROM library.canonical_source_scope WHERE route=$1 AND collection_id=$2 AND source_fence<>$3 ORDER BY source_fence LIMIT 1`,
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
const insertScopeValues = [maxRoute, maxUuid, 'f'.repeat(64), 'a'.repeat(identityJsonCeiling)];

export function CANONICAL_SOURCE_STATEMENTS() {
  return memoizedValue(CANONICAL_SOURCE_STATEMENTS, () =>
    Object.freeze({
      scope: statement(
        'canonical-source-scope',
        CANONICAL_SOURCE_SQL.scope,
        maxScopeValues,
        maxScopeRow,
        1,
        point(CANONICAL_SOURCE_SQL.scope, maxScopeValues, maxScopeRow, 1, 4),
      ),
      predecessorScope: statement(
        'canonical-source-predecessor-scope',
        CANONICAL_SOURCE_SQL.predecessorScope,
        maxScopeValues,
        maxScopeRow,
        1,
        point(CANONICAL_SOURCE_SQL.predecessorScope, maxScopeValues, maxScopeRow, 1, 8),
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
        point(
          CANONICAL_SOURCE_SQL.updateScopeFrontier,
          updateScopeFrontierValues,
          jsonBytes([{ collection_id: maxUuid }]),
        ),
      ),
    }),
  );
}

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

function metadataBound() {
  return memoizedValue(metadataBound, () =>
    sqlBound({
      candidateKeys: 0,
      nativeRows: 24,
      identityMetadataRows: 0,
      emptySeeks: 5,
      nativePoints: 5,
      witnessKeys: 0,
      statements: 5,
      bytes: 2_097_152,
    }),
  );
}
function identitySweepBound() {
  return memoizedValue(identitySweepBound, () =>
    sqlBound({
      candidateKeys: 0,
      nativeRows: CANONICAL_SOURCE_IDENTITY_SWEEP_HOMES * CANONICAL_SOURCE_IDENTITY_SWEEPS,
      identityMetadataRows: CANONICAL_SOURCE_IDENTITY_SWEEP_HOMES * CANONICAL_SOURCE_IDENTITY_SWEEPS,
      emptySeeks: CANONICAL_SOURCE_IDENTITY_SWEEPS,
      nativePoints: CANONICAL_SOURCE_IDENTITY_SWEEPS,
      witnessKeys: 0,
      statements: CANONICAL_SOURCE_IDENTITY_SWEEPS,
      bytes: identityJsonCeiling * CANONICAL_SOURCE_IDENTITY_SWEEPS,
    }),
  );
}

const mappingUnitBounds = new WeakMap<LibrarySemanticObservationCapability, CanonicalSourceSqlBound>();
export function canonicalSourceMappingBound(
  originalCount: number,
  observations?: LibrarySemanticObservationCapability,
): CanonicalSourceSqlBound {
  if (!Number.isSafeInteger(originalCount) || originalCount < 0 || originalCount > CANONICAL_SOURCE_RAW_KEY_LIMIT)
    throw new RangeError('Canonical Source mapping page must contain at most 100 originals');
  if (originalCount === 0)
    return sqlBound({
      candidateKeys: 0,
      nativeRows: 0,
      identityMetadataRows: 0,
      emptySeeks: 0,
      nativePoints: 0,
      witnessKeys: 0,
      statements: 0,
      bytes: 0,
    });
  const owner = observations ?? librarySemanticObservations();
  let unit = mappingUnitBounds.get(owner);
  if (!unit) {
    unit = sqlBound(owner.canonical.mappingWork([maxRoutedUuid]));
    mappingUnitBounds.set(owner, unit);
  }
  const total = repeatBound(unit, originalCount);
  if (total.engineRequests !== 0) throw new TypeError('Canonical Source mapping cannot issue engine requests');
  return Object.freeze({ ...total, engineRequests: 0 });
}

function ownerFactsCeiling() {
  return memoizedValue(ownerFactsCeiling, () =>
    Math.max(
      bytesOf(ownerFactsSql.sql, maxOwnerFactValues, maxOwnerFactRow * CANONICAL_SOURCE_RAW_KEY_LIMIT),
      bytesOf(labelOriginalsSql.sql, maxOwnerFactValues, maxOwnerFactRow * CANONICAL_SOURCE_RAW_KEY_LIMIT),
    ),
  );
}

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
    bytes: Math.max(owner.bytes, ownerFactsCeiling()),
  });
  return owner.bytes >= collection.bytes ? owner : collection;
}

export function CANONICAL_SOURCE_RECEIVING_COST() {
  return memoizedValue(CANONICAL_SOURCE_RECEIVING_COST, () =>
    Object.freeze({
      metadata: metadataBound(),
      sourceScope: CANONICAL_SOURCE_STATEMENTS().scope.bound,
      sourceHead: CANONICAL_SOURCE_STATEMENTS().head.bound,
      sourceGeneration: CANONICAL_SOURCE_STATEMENTS().generation.bound,
      seek: CANONICAL_SOURCE_STATEMENTS().seek.bound,
      group(limit: number): CanonicalSourceSqlBound {
        return canonicalSourceGroupStatement(limit).bound;
      },
      state: sumBounds(
        metadataBound(),
        CANONICAL_SOURCE_STATEMENTS().scope.bound,
        CANONICAL_SOURCE_STATEMENTS().head.bound,
        CANONICAL_SOURCE_STATEMENTS().generation.bound,
      ),
    }),
  );
}

function observation() {
  return memoizedValue(observation, () =>
    sumBounds(metadataBound(), CANONICAL_SOURCE_STATEMENTS().scope.bound, identitySweepBound()),
  );
}
function begin() {
  return memoizedValue(begin, () =>
    sumBounds(
      CANONICAL_SOURCE_STATEMENTS().sourceLock.bound,
      CANONICAL_SOURCE_STATEMENTS().factLock.bound,
      CANONICAL_SOURCE_STATEMENTS().workingGeneration.bound,
      CANONICAL_SOURCE_STATEMENTS().abandon.bound,
      CANONICAL_SOURCE_STATEMENTS().retainedGenerations.bound,
      CANONICAL_SOURCE_STATEMENTS().insertGeneration.bound,
      SELECTED_COST().enqueue,
    ),
  );
}
const repairWrite = (limit: number) =>
  sumBounds(
    CANONICAL_SOURCE_STATEMENTS().sourceLock.bound,
    CANONICAL_SOURCE_STATEMENTS().factLock.bound,
    CANONICAL_SOURCE_STATEMENTS().generationLock.bound,
    repeatBound(CANONICAL_SOURCE_STATEMENTS().insertReference.bound, limit),
    CANONICAL_SOURCE_STATEMENTS().updateFrontier.bound,
    SELECTED_COST().enqueue,
  );
function publish() {
  return memoizedValue(publish, () =>
    sumBounds(
      CANONICAL_SOURCE_STATEMENTS().sourceLock.bound,
      CANONICAL_SOURCE_STATEMENTS().factLock.bound,
      CANONICAL_SOURCE_STATEMENTS().generationLock.bound,
      CANONICAL_SOURCE_STATEMENTS().completeGeneration.bound,
      CANONICAL_SOURCE_STATEMENTS().publishHead.bound,
    ),
  );
}
function readback() {
  return memoizedValue(readback, () =>
    sumBounds(observation(), CANONICAL_SOURCE_STATEMENTS().head.bound, CANONICAL_SOURCE_STATEMENTS().generation.bound),
  );
}
function executionAttempt() {
  return memoizedValue(executionAttempt, () =>
    sumBounds(OPERATIONAL_WORK_COST().attempt, SELECTED_COST().enqueue, SELECTED_COST().rollback),
  );
}
function executionEnvelope() {
  return memoizedValue(executionEnvelope, () =>
    sumBounds(
      SELECTED_COST().consume,
      repeatBound(executionAttempt(), CANONICAL_SOURCE_ATTEMPTS()),
      SELECTED_CLEANUP_DECLARATION(),
    ),
  );
}

const termsByObservation = new WeakMap<
  LibrarySemanticObservationCapability,
  ReturnType<typeof buildCanonicalSourceTerms>
>();
function buildCanonicalSourceTerms(observations: LibrarySemanticObservationCapability) {
  return Object.freeze({
    observation: observation(),
    begin: begin(),
    rawWindow: canonicalSourceRawWindowBound(CANONICAL_SOURCE_RAW_KEY_LIMIT),
    mapping: canonicalSourceMappingBound(CANONICAL_SOURCE_RAW_KEY_LIMIT, observations),
    repairWrite: repairWrite(CANONICAL_SOURCE_RAW_KEY_LIMIT),
    publish: publish(),
    readback: readback(),
    seek: CANONICAL_SOURCE_STATEMENTS().seek.bound,
    group: canonicalSourceGroupStatement(CANONICAL_SOURCE_RAW_KEY_LIMIT).bound,
    executionEnvelope: executionEnvelope(),
  });
}
export function CANONICAL_SOURCE_TERMS(
  observations: LibrarySemanticObservationCapability = librarySemanticObservations(),
) {
  let terms = termsByObservation.get(observations);
  if (!terms) {
    terms = buildCanonicalSourceTerms(observations);
    termsByObservation.set(observations, terms);
  }
  return terms;
}

const repairByObservation = new WeakMap<LibrarySemanticObservationCapability, Bound>();
export function CANONICAL_SOURCE_REPAIR_STEP(
  observations: LibrarySemanticObservationCapability = librarySemanticObservations(),
) {
  let repair = repairByObservation.get(observations);
  if (!repair) {
    repair = sumBounds(
      observation(),
      observation(),
      CANONICAL_SOURCE_STATEMENTS().predecessorScope.bound,
      CANONICAL_SOURCE_TERMS(observations).rawWindow,
      CANONICAL_SOURCE_TERMS(observations).mapping,
      CANONICAL_SOURCE_TERMS(observations).repairWrite,
      executionEnvelope(),
    );
    repairByObservation.set(observations, repair);
  }
  return repair;
}
export function CANONICAL_SOURCE_PUBLICATION_STEP() {
  return memoizedValue(CANONICAL_SOURCE_PUBLICATION_STEP, () =>
    sumBounds(observation(), publish(), executionEnvelope()),
  );
}
export function CANONICAL_SOURCE_COMPLETED_READBACK() {
  return memoizedValue(CANONICAL_SOURCE_COMPLETED_READBACK, () => readback());
}

const declarationByObservation = new WeakMap<
  LibrarySemanticObservationCapability,
  ReturnType<typeof buildCanonicalSourceDeclaration>
>();
function buildCanonicalSourceDeclaration(observations: LibrarySemanticObservationCapability) {
  return Object.freeze({
    status: 'complete' as const,
    axes: CANONICAL_SOURCE_AXES(),
    limits: Object.freeze({
      rawKeys: CANONICAL_SOURCE_RAW_KEY_LIMIT,
      zoneAggregate: CANONICAL_SOURCE_ZONE_AGGREGATE,
      generations: CANONICAL_SOURCE_GENERATION_CAPACITY,
      scopes: CANONICAL_SOURCE_SCOPE_CAPACITY,
      attempts: CANONICAL_SOURCE_ATTEMPTS(),
      identitySweepHomes: CANONICAL_SOURCE_IDENTITY_SWEEP_HOMES,
      identitySweeps: CANONICAL_SOURCE_IDENTITY_SWEEPS,
    }),
    statements: CANONICAL_SOURCE_STATEMENTS(),
    terms: CANONICAL_SOURCE_TERMS(observations),
    repair: CANONICAL_SOURCE_REPAIR_STEP(observations),
    publication: CANONICAL_SOURCE_PUBLICATION_STEP(),
    readback: CANONICAL_SOURCE_COMPLETED_READBACK(),
    receiving: CANONICAL_SOURCE_RECEIVING_COST(),
  });
}
export function CANONICAL_SOURCE_DECLARATION(
  observations: LibrarySemanticObservationCapability = librarySemanticObservations(),
) {
  let declaration = declarationByObservation.get(observations);
  if (!declaration) {
    declaration = buildCanonicalSourceDeclaration(observations);
    declarationByObservation.set(observations, declaration);
  }
  return declaration;
}

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

export function canonicalSourceCallAllowance(bound: Bound = CANONICAL_SOURCE_REPAIR_STEP()): Readonly<{
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
