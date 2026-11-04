/** Same-client structural reads for the selected Source branch. Declarations constrain calls, never fund them. */
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { Pool, QueryConfig, QueryResultRow } from 'pg';
import { declareBound, sumBounds, type Bound } from '@rezics/bounds';
import { currentOperationalResources, hasLiveOperationalTransaction } from '../command/operational.ts';
import { ProblemError } from '../http/problem.ts';
import { readScopeWorkDefinition, type ScopeWorkContext } from '../search/scope-work-context.ts';
import type { Access } from '../request/access.ts';
import { nativeSourceFence, type CanonicalBasis, type CanonicalRawKey } from './canonical-source-store.ts';
import {
  readNativeCollectionMetadataForWork,
  type NativeCollectionMetadata,
} from './collection-source-native.ts';
import type { CollectionSourceObservation, WorkDimensions, WorkReceipt } from './collection-source.ts';
import type { NativeSourceIdentity } from './native-source-custody.ts';

export type CollectionSourceWorkDefinition = Awaited<ReturnType<typeof readScopeWorkDefinition>>;
export type CollectionSourceWorkState = Readonly<{
  metadata: NativeCollectionMetadata;
  basis: CanonicalBasis;
  generation: string;
  observation: CollectionSourceObservation;
  definition: CollectionSourceWorkDefinition;
  /** Static work evidence only. It is never accepted as an allowance or commit token. */
  work: WorkReceipt;
}>;
const drivers = ['member', 'entry', 'label', 'session', 'copy', 'output'] as const;

const bounded = (
  values: Omit<Bound, 'engineRequests'>,
): Bound => declareBound({ ...values, engineRequests: 0 });

const sourceScopeSQL = `SELECT identity,capture_id::text AS capture,committed_revision::text AS revision
       FROM library.canonical_source_scope WHERE route=$1 AND collection_id=$2 AND source_fence=$3`;
const sourceHeadSQL =
  'SELECT generation::text FROM library.canonical_source_head WHERE route=$1 AND collection_id=$2';
const sourceGenerationSQL = `SELECT basis,state,source_exhausted AS exhausted FROM library.canonical_source_generation
       WHERE route=$1 AND collection_id=$2 AND generation=$3`;
const groupSeekSQL = `SELECT canonical_subject_id::text AS subject FROM library.canonical_source_reference
       WHERE route=$1 AND collection_id=$2 AND generation=$3
       AND canonical_subject_id>COALESCE($4::uuid,'00000000-0000-0000-0000-000000000000')
       ORDER BY canonical_subject_id,stored_subject_id,driver,fact_id LIMIT 1`;
const groupPageSQL = `SELECT stored_subject_id::text AS original,driver,fact_id::text AS fact FROM library.canonical_source_reference
       WHERE route=$1 AND collection_id=$2 AND generation=$3 AND canonical_subject_id=$4
       AND (stored_subject_id,driver,fact_id)>(COALESCE($5::uuid,'00000000-0000-0000-0000-000000000000'),COALESCE($6::smallint,-1),COALESCE($7::uuid,'00000000-0000-0000-0000-000000000000'))
       ORDER BY stored_subject_id,driver,fact_id LIMIT $8`;

const pointBound = (rows: number, bytes: number) =>
  bounded({
    candidateKeys: 0,
    nativeRows: rows,
    identityMetadataRows: 0,
    emptySeeks: 1,
    nativePoints: 1,
    witnessKeys: 0,
    statements: 1,
    bytes,
  });

const metadataBound = bounded({
  candidateKeys: 0,
  nativeRows: 24,
  identityMetadataRows: 0,
  emptySeeks: 5,
  nativePoints: 5,
  witnessKeys: 0,
  statements: 5,
  bytes: 2_097_152,
});
const sourceScopeBound = pointBound(16, 9_216);
const sourceHeadBound = pointBound(16, 1_536);
const sourceGenerationBound = pointBound(16, 9_216);

/** Upper bounds follow the exact indexed statements below. Request parameters and returned projections are capped. */
export const COLLECTION_SOURCE_WORK_COST = Object.freeze({
  metadata: metadataBound,
  sourceScope: sourceScopeBound,
  sourceHead: sourceHeadBound,
  sourceGeneration: sourceGenerationBound,
  seek: bounded({
    candidateKeys: 1,
    nativeRows: 8,
    identityMetadataRows: 0,
    emptySeeks: 1,
    nativePoints: 1,
    witnessKeys: 0,
    statements: 1,
    bytes: 2_304,
  }),
  group(limit: number): Bound {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new RangeError('Invalid work group limit');
    return bounded({
      candidateKeys: limit,
      nativeRows: 8 * limit + 8,
      identityMetadataRows: 0,
      emptySeeks: 1,
      nativePoints: 1,
      witnessKeys: 0,
      statements: 1,
      bytes: 2_304 + 256 * limit,
    });
  },
  state: sumBounds(metadataBound, sourceScopeBound, sourceHeadBound, sourceGenerationBound),
});

const sourceReceipt = (bound: Bound): WorkReceipt =>
  Object.freeze({
    reservationId: 'collection-source-static',
    used: Object.freeze({
      candidateKeys: bound.candidateKeys,
      nativeRows: bound.nativeRows,
      identityMetadataRows: bound.identityMetadataRows,
      emptySeeks: bound.emptySeeks,
      nativePoints: bound.nativePoints,
      witnessKeys: bound.witnessKeys,
      statements: bound.statements,
      bytes: bound.bytes,
    }),
  });

type StaticStatement = Readonly<{
  name: string;
  sql: string;
  requestBytes: number;
  resultBytes: number;
  rows: number;
}>;
type StaticFrame = { readonly deadline: number; readonly called: Set<string> };
function frame(deadline: number): StaticFrame {
  if (!Number.isFinite(deadline) || Date.now() >= deadline) throw new ProblemError('semantic_not_ready');
  return { deadline, called: new Set() };
}
async function query<R extends QueryResultRow>(
  work: ScopeWorkContext,
  current: StaticFrame,
  statement: StaticStatement,
  values: unknown[],
): Promise<R[]> {
  if (
    statement.sql.length === 0 ||
    !hasLiveOperationalTransaction(work.tx) ||
    Date.now() >= current.deadline ||
    current.called.has(statement.name)
  )
    throw new ProblemError('semantic_not_ready');
  const resources = currentOperationalResources(work.tx);
  if (resources.deadline < current.deadline || resources.mode !== 'work-step')
    throw new ProblemError('semantic_not_ready');
  const requestBytes = Buffer.byteLength(statement.sql) + Buffer.byteLength(JSON.stringify(values));
  if (requestBytes > statement.requestBytes) throw new ProblemError('dependency_unavailable');
  current.called.add(statement.name);
  const config: QueryConfig = {
    text: statement.sql,
    values,
    query_timeout: Math.max(1, current.deadline - Date.now()),
  };
  const rows = (await work.tx.query<R>(config)).rows;
  if (rows.length > statement.rows || Buffer.byteLength(JSON.stringify(rows) ?? '') > statement.resultBytes)
    throw new ProblemError('dependency_unavailable');
  return rows;
}

const stateScopeStatement: StaticStatement = Object.freeze({
  name: 'source-scope-currentness',
  sql: sourceScopeSQL,
  requestBytes: 1_024,
  resultBytes: 8_192,
  rows: 1,
});
const stateHeadStatement: StaticStatement = Object.freeze({
  name: 'source-head-generation',
  sql: sourceHeadSQL,
  requestBytes: 1_024,
  resultBytes: 512,
  rows: 1,
});
const stateGenerationStatement: StaticStatement = Object.freeze({
  name: 'source-complete-generation',
  sql: sourceGenerationSQL,
  requestBytes: 1_024,
  resultBytes: 8_192,
  rows: 1,
});

/** Rereads native admission before IO, then verifies the same source and current indexed generation. */
export async function readCollectionSourceWorkState(
  pool: Pool,
  work: ScopeWorkContext,
  options: Readonly<{ access: Access; deadline: number }>,
): Promise<CollectionSourceWorkState> {
  const current = frame(options.deadline);
  try {
    const native = await readScopeWorkDefinition(work, { pool, access: options.access, deadline: options.deadline });
    if (!hasLiveOperationalTransaction(work.tx)) throw new ProblemError('semantic_not_ready');
    const resources = currentOperationalResources(work.tx);
    const source = native.sourceIdentity;
    if (
      resources.pool !== pool ||
      resources.mode !== 'work-step' ||
      source.collectionId !== work.locator.collectionId ||
      source.route !== work.locator.route ||
      source.scope === 'public_output' ||
      (work.kind === 'collection-publication' && source.scope !== 'private_builtin') ||
      source.accountId !== work.locator.ownerAccountId ||
      (work.kind === 'members-preparation' ? source.scope !== 'curated' : source.scope === 'curated')
    )
      throw new ProblemError('dependency_unavailable');
    const { metadata } = await readNativeCollectionMetadataForWork(pool, source, {
      deadline: options.deadline,
      tx: work.tx,
      working: work.kind === 'collection-publication',
    });
    if (!metadata || metadata.state !== 'active') throw new ProblemError('not_found');
    if (
      metadata.authority !== source.scope ||
      metadata.curatorAccountId !== source.accountId ||
      metadata.incarnation !== source.incarnation ||
      metadata.sourceGeneration !== source.generation ||
      metadata.stamp.epoch !== source.ownerEpoch ||
      metadata.revision !== native.observation.revision ||
      (metadata.authority === 'private_builtin' &&
        (!metadata.factFence ||
          ('rule' in native
            ? native.rule.kind === 'saved'
              ? metadata.builtinKind !== null ||
                !metadata.ruleReady ||
                metadata.ruleRevision !== String(native.rule.revision) ||
                metadata.ruleReleaseDigest !== native.rule.releaseDigest
              : metadata.builtinKind !== native.rule.key.kind ||
                (native.rule.key.kind === 'state' &&
                  (metadata.profileId !== native.rule.key.profileId ||
                    metadata.stateSetId !== native.rule.key.stateSetId ||
                    metadata.stateId !== native.rule.key.stateId))
            : !metadata.builtinKind)))
    )
      throw new ProblemError('semantic_not_ready');
    const fence = nativeSourceFence(metadata);
    const [scope] = await query<{ identity: NativeSourceIdentity; capture: string | null; revision: string | null }>(
      work,
      current,
      stateScopeStatement,
      [source.route, source.collectionId, fence],
    );
    if (!scope?.capture || scope.revision === null || !isDeepStrictEqual(scope.identity, source))
      throw new ProblemError('semantic_not_ready');
    const identityDigest = createHash('sha256')
      .update(JSON.stringify([scope.capture, scope.revision]))
      .digest('hex');
    if (identityDigest !== native.observation.basis.identity.digest) throw new ProblemError('semantic_not_ready');
    if (
      'identityObservation' in native &&
      (native.identityObservation.captureId !== scope.capture ||
        native.identityObservation.committedRevision !== BigInt(scope.revision))
    )
      throw new ProblemError('semantic_not_ready');
    const [head] = await query<{ generation: string }>(work, current, stateHeadStatement, [source.route, source.collectionId]);
    if (!head) throw new ProblemError('dependency_unavailable');
    const [generation] = await query<{ basis: CanonicalBasis; state: string; exhausted: boolean }>(
      work,
      current,
      stateGenerationStatement,
      [source.route, source.collectionId, head.generation],
    );
    if (!generation || generation.state !== 'complete' || !generation.exhausted)
      throw new ProblemError('dependency_unavailable');
    const { basis } = generation;
    if (
      basis.sourceFence !== fence ||
      basis.incarnation !== source.incarnation ||
      !isDeepStrictEqual(
        {
          digest: basis.digest,
          identity: basis.identity,
          query: basis.meaning,
          profilePins: metadata.releaseDigest ? [metadata.releaseDigest] : [],
          projection: null,
        },
        native.observation.basis,
      ) ||
      !isDeepStrictEqual(basis.authority, native.observation.authority)
    )
      throw new ProblemError('semantic_not_ready');
    return Object.freeze({
      metadata,
      basis,
      generation: head.generation,
      observation: native.observation,
      definition: structuredClone(native),
      work: sourceReceipt(COLLECTION_SOURCE_WORK_COST.state),
    });
  } catch (error) {
    if (error instanceof Error)
      Object.defineProperty(error, 'work', { value: sourceReceipt(COLLECTION_SOURCE_WORK_COST.state), configurable: true });
    throw error;
  }
}

/** Exact seek in the already admitted COMPLETE generation; empty seeks are part of the fixed declaration. */
export async function seekCollectionSourceWorkGroup(
  work: ScopeWorkContext,
  state: CollectionSourceWorkState,
  after: string | null,
  options: Readonly<{ deadline: number }>,
) {
  const current = frame(options.deadline);
  try {
    const [row] = await query<{ subject: string }>(
      work,
      current,
      { name: 'canonical-group-seek', sql: groupSeekSQL, requestBytes: 2_048, resultBytes: 256, rows: 1 },
      [state.metadata.route, state.metadata.collectionId, state.generation, after],
    );
    return { subjectId: row?.subject ?? null, work: sourceReceipt(COLLECTION_SOURCE_WORK_COST.seek) };
  } catch (error) {
    if (error instanceof Error)
      Object.defineProperty(error, 'work', { value: sourceReceipt(COLLECTION_SOURCE_WORK_COST.seek), configurable: true });
    throw error;
  }
}

export async function readCollectionSourceWorkGroup(
  work: ScopeWorkContext,
  state: CollectionSourceWorkState,
  subjectId: string,
  after: CanonicalRawKey | null,
  limit: number,
  options: Readonly<{ deadline: number }>,
) {
  const cost = COLLECTION_SOURCE_WORK_COST.group(limit);
  const current = frame(options.deadline);
  try {
    if (routeOf(subjectId) !== state.metadata.route) throw new ProblemError('invalid_cursor');
    if (
      after &&
      (after.driver === 'output' ||
        (state.metadata.authority === 'curated' ? after.driver !== 'member' : after.driver === 'member'))
    )
      throw new ProblemError('invalid_cursor');
    const values = [
      state.metadata.route,
      state.metadata.collectionId,
      state.generation,
      subjectId,
      after?.storedSubjectId ?? null,
      after ? drivers.indexOf(after.driver) : null,
      after?.factId ?? null,
      limit,
    ];
    const rows = await query<{ original: string; driver: number; fact: string }>(
      work,
      current,
      {
        name: 'canonical-group-page',
        sql: groupPageSQL,
        requestBytes: 2_048,
        resultBytes: 256 * limit,
        rows: limit,
      },
      values,
    );
    const keys = rows.map((row): CanonicalRawKey => {
      const driver = drivers[row.driver];
      if (
        !driver ||
        driver === 'output' ||
        (state.metadata.authority === 'curated' ? driver !== 'member' : driver === 'member')
      )
        throw new ProblemError('semantic_not_ready');
      return { driver, storedSubjectId: row.original, factId: row.fact };
    });
    return { rows: keys.map((key) => ({ key })), exhausted: rows.length < limit, work: sourceReceipt(cost) };
  } catch (error) {
    if (error instanceof Error) Object.defineProperty(error, 'work', { value: sourceReceipt(cost), configurable: true });
    throw error;
  }
}
