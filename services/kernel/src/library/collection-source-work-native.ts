/** Same-client structural reads for the existing Source work branch. No admission or canonical planner lives here. */
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { Pool, QueryResultRow } from 'pg';
import { currentOperationalResources, hasLiveOperationalTransaction } from '../command/operational.ts';
import { ProblemError } from '../http/problem.ts';
import { readScopeWorkDefinition, type ScopeWorkContext } from '../search/scope-work-context.ts';
import type { Access } from '../request/access.ts';
import { nativeSourceFence, type CanonicalBasis, type CanonicalRawKey } from './canonical-source-store.ts';
import { readNativeCollectionMetadata, type NativeCollectionMetadata } from './collection-source-native.ts';
import { CollectionSourceLedger } from './collection-source-work.ts';
import type { CollectionSourceObservation, WorkAllowance } from './collection-source.ts';
import type { NativeSourceIdentity } from './native-source-custody.ts';

export type CollectionSourceWorkDefinition = Awaited<ReturnType<typeof readScopeWorkDefinition>>;
export type CollectionSourceWorkState = Readonly<{
  metadata: NativeCollectionMetadata;
  basis: CanonicalBasis;
  generation: string;
  observation: CollectionSourceObservation;
  definition: CollectionSourceWorkDefinition;
}>;
const drivers = ['member', 'entry', 'label', 'session', 'copy', 'output'] as const;

async function query<R extends QueryResultRow>(
  work: ScopeWorkContext,
  l: CollectionSourceLedger,
  sql: string,
  values: unknown[],
  rows = 16,
  bytes = 8192,
  keys = 0,
): Promise<R[]> {
  if (!hasLiveOperationalTransaction(work.tx)) throw new ProblemError('semantic_not_ready');
  return l.bounded(
    {
      nativeRows: rows,
      nativePoints: 1,
      statements: 1,
      emptySeeks: 1,
      candidateKeys: keys,
      bytes: Buffer.byteLength(sql) + Buffer.byteLength(JSON.stringify(values)) + bytes,
    },
    async () => (await work.tx.query<R>({ text: sql, values, query_timeout: Math.max(1, l.deadline - Date.now()) })).rows,
    (result) => ({ emptySeeks: result.length === 0 ? 1 : 0, candidateKeys: keys ? result.length : 0 }),
  );
}

/** Rereads actual native admission before I/O, then compares its binding to current local Source records.
 * The Source repeats this whole operation before returning. This data never grants Access.
 */
export async function readCollectionSourceWorkState(
  pool: Pool,
  work: ScopeWorkContext,
  options: Readonly<{ access: Access; deadline: number; allowance: WorkAllowance }>,
) {
  const l = new CollectionSourceLedger(options.allowance, options.deadline);
  try {
    const native = await readScopeWorkDefinition(work, { pool, access: options.access, deadline: options.deadline });
    if (!hasLiveOperationalTransaction(work.tx)) throw new ProblemError('semantic_not_ready');
    const resources = currentOperationalResources(work.tx);
    const source = native.sourceIdentity;
    if (
      resources.pool !== pool || resources.mode !== 'work-step' ||
      source.collectionId !== work.locator.collectionId || source.route !== work.locator.route ||
      source.scope === 'public_output' || source.accountId !== work.locator.ownerAccountId ||
      (work.kind === 'members-preparation' ? source.scope !== 'curated' : source.scope === 'curated')
    ) throw new ProblemError('dependency_unavailable');
    // Public/frozen output needs its own native public capture proof. Never borrow private capture here.
    const { metadata } = await l.run((allowance) => readNativeCollectionMetadata(pool, source, {
      deadline: options.deadline, allowance, tx: work.tx,
    }));
    if (!metadata || metadata.state !== 'active') throw new ProblemError('not_found');
    if (
      metadata.authority !== source.scope || metadata.curatorAccountId !== source.accountId ||
      metadata.incarnation !== source.incarnation || metadata.sourceGeneration !== source.generation ||
      metadata.stamp.epoch !== source.ownerEpoch || metadata.revision !== native.observation.revision ||
      (metadata.authority === 'private_builtin' && (!metadata.factFence || !metadata.builtinKind))
    ) throw new ProblemError('semantic_not_ready');
    const fence = nativeSourceFence(metadata);
    const [scope] = await query<{ identity: NativeSourceIdentity; capture: string | null; revision: string | null }>(
      work, l,
      `SELECT identity,capture_id::text AS capture,committed_revision::text AS revision
       FROM library.canonical_source_scope WHERE route=$1 AND collection_id=$2 AND source_fence=$3`,
      [source.route, source.collectionId, fence],
    );
    if (!scope?.capture || scope.revision === null || !isDeepStrictEqual(scope.identity, source))
      throw new ProblemError('semantic_not_ready');
    const identityDigest = createHash('sha256').update(JSON.stringify([scope.capture, scope.revision])).digest('hex');
    if (identityDigest !== native.observation.basis.identity.digest)
      throw new ProblemError('semantic_not_ready');
    if ('identityObservation' in native && (
      native.identityObservation.captureId !== scope.capture ||
      native.identityObservation.committedRevision !== BigInt(scope.revision)
    )) throw new ProblemError('semantic_not_ready');
    const [head] = await query<{ generation: string }>(work, l,
      'SELECT generation::text FROM library.canonical_source_head WHERE route=$1 AND collection_id=$2',
      [source.route, source.collectionId]);
    if (!head) throw new ProblemError('dependency_unavailable');
    const [generation] = await query<{ basis: CanonicalBasis; state: string; exhausted: boolean }>(work, l,
      `SELECT basis,state,source_exhausted AS exhausted FROM library.canonical_source_generation
       WHERE route=$1 AND collection_id=$2 AND generation=$3`,
      [source.route, source.collectionId, head.generation]);
    if (!generation || generation.state !== 'complete' || !generation.exhausted)
      throw new ProblemError('dependency_unavailable');
    const { basis } = generation;
    if (basis.sourceFence !== fence || basis.incarnation !== source.incarnation || !isDeepStrictEqual({
      digest: basis.digest, identity: basis.identity, query: basis.meaning,
      profilePins: metadata.releaseDigest ? [metadata.releaseDigest] : [], projection: null,
    }, native.observation.basis) || !isDeepStrictEqual(basis.authority, native.observation.authority))
      throw new ProblemError('semantic_not_ready');
    return {
      metadata, basis, generation: head.generation, observation: native.observation, definition: native, work: l.receipt(),
    };
  } catch (error) {
    if (error instanceof Error) Object.defineProperty(error, 'work', { get: () => l.receipt(), configurable: true });
    throw error;
  }
}

/** Exact seek in the existing COMPLETE canonical generation, not a new producer or a public subject reader. */
export async function seekCollectionSourceWorkGroup(
  work: ScopeWorkContext,
  state: CollectionSourceWorkState,
  after: string | null,
  options: Readonly<{ deadline: number; allowance: WorkAllowance }>,
) {
  const l = new CollectionSourceLedger(options.allowance, options.deadline);
  try {
    const [row] = await query<{ subject: string }>(work, l,
      `SELECT canonical_subject_id::text AS subject FROM library.canonical_source_reference
       WHERE route=$1 AND collection_id=$2 AND generation=$3
       AND canonical_subject_id>COALESCE($4::uuid,'00000000-0000-0000-0000-000000000000')
       ORDER BY canonical_subject_id,stored_subject_id,driver,fact_id LIMIT 1`,
      [state.metadata.route, state.metadata.collectionId, state.generation, after], 8, 128, 1);
    return { subjectId: row?.subject ?? null, work: l.receipt() };
  } catch (error) {
    if (error instanceof Error) Object.defineProperty(error, 'work', { get: () => l.receipt(), configurable: true });
    throw error;
  }
}

export async function readCollectionSourceWorkGroup(
  work: ScopeWorkContext,
  state: CollectionSourceWorkState,
  subjectId: string,
  after: CanonicalRawKey | null,
  limit: number,
  options: Readonly<{ deadline: number; allowance: WorkAllowance }>,
) {
  const l = new CollectionSourceLedger(options.allowance, options.deadline);
  try {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new RangeError('Invalid work group limit');
    if (after && (after.driver === 'output' ||
      (state.metadata.authority === 'curated' ? after.driver !== 'member' : after.driver === 'member')))
      throw new ProblemError('invalid_cursor');
    const rows = await query<{ original: string; driver: number; fact: string }>(work, l,
      `SELECT stored_subject_id::text AS original,driver,fact_id::text AS fact FROM library.canonical_source_reference
       WHERE route=$1 AND collection_id=$2 AND generation=$3 AND canonical_subject_id=$4
       AND (stored_subject_id,driver,fact_id)>(COALESCE($5::uuid,'00000000-0000-0000-0000-000000000000'),COALESCE($6::smallint,-1),COALESCE($7::uuid,'00000000-0000-0000-0000-000000000000'))
       ORDER BY stored_subject_id,driver,fact_id LIMIT $8`,
      [state.metadata.route, state.metadata.collectionId, state.generation, subjectId,
        after?.storedSubjectId ?? null, after ? drivers.indexOf(after.driver) : null, after?.factId ?? null, limit],
      8 * limit + 8, 256 * limit, limit);
    const keys = rows.map((row): CanonicalRawKey => {
      const driver = drivers[row.driver];
      if (!driver || driver === 'output' || (state.metadata.authority === 'curated' ? driver !== 'member' : driver === 'member'))
        throw new ProblemError('semantic_not_ready');
      return { driver, storedSubjectId: row.original, factId: row.fact };
    });
    return { rows: keys.map((key) => ({ key })), exhausted: rows.length < limit, work: l.receipt() };
  } catch (error) {
    if (error instanceof Error) Object.defineProperty(error, 'work', { get: () => l.receipt(), configurable: true });
    throw error;
  }
}
