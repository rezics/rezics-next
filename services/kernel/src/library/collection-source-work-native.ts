import { memoizedValue } from '../memoized.ts';
/** Same-client structural reads for the selected Source branch. Declarations constrain calls, never fund them. */
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { Pool, QueryResultRow } from 'pg';
import { type Bound } from '@rezics/bounds';
import { currentOperationalResources, hasLiveOperationalTransaction } from '../command/operational.ts';
import { deadlineClient } from '../access/authenticate.ts';
import { ProblemError } from '../http/problem.ts';
import { routeOf } from '../route/route.ts';
import { readScopeWorkDefinition, type ScopeWorkContext } from '../search/scope-work-context.ts';
import type { Access } from '../request/access.ts';
import {
  CANONICAL_SOURCE_RECEIVING_COST,
  CANONICAL_SOURCE_STATEMENTS,
  assertCanonicalSourceStatement,
  canonicalSourceGroupStatement,
  canonicalSourceWorkDimensions,
  type CanonicalSourceStatement,
} from './canonical-source-bounds.ts';
import { COLLECTION_SOURCE_WORK_GROUP_LIMIT } from './canonical-source-limits.ts';
export { COLLECTION_SOURCE_WORK_GROUP_LIMIT } from './canonical-source-limits.ts';
import { nativeSourceFence, type CanonicalBasis, type CanonicalRawKey } from './canonical-source-store.ts';
import { readNativeCollectionMetadataForWork, type NativeCollectionMetadata } from './collection-source-native.ts';
import type { CollectionSourceObservation, WorkReceipt } from './collection-source.ts';
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

/** Upper bounds follow the exact indexed statements in the canonical Source plan. */
export function COLLECTION_SOURCE_WORK_COST() {
  return memoizedValue(COLLECTION_SOURCE_WORK_COST, () => CANONICAL_SOURCE_RECEIVING_COST());
}

const sourceReceipt = (bound: Bound): WorkReceipt =>
  Object.freeze({
    reservationId: 'collection-source-static',
    used: canonicalSourceWorkDimensions(bound),
  });

type StaticFrame = { readonly deadline: number; readonly called: Set<string> };
function frame(deadline: number): StaticFrame {
  if (!Number.isFinite(deadline) || Date.now() >= deadline) throw new ProblemError('semantic_not_ready');
  return { deadline, called: new Set() };
}
async function query<R extends QueryResultRow>(
  work: ScopeWorkContext,
  current: StaticFrame,
  statement: CanonicalSourceStatement,
  values: unknown[],
): Promise<R[]> {
  const declared = statement;
  if (
    declared.sql.length === 0 ||
    !hasLiveOperationalTransaction(work.tx) ||
    Date.now() >= current.deadline ||
    current.called.has(declared.name)
  )
    throw new ProblemError('semantic_not_ready');
  const resources = currentOperationalResources(work.tx);
  if (resources.deadline < current.deadline || resources.mode !== 'work-step')
    throw new ProblemError('semantic_not_ready');
  assertCanonicalSourceStatement(declared, values);
  current.called.add(declared.name);
  const rows = (await deadlineClient(work.tx, current.deadline).query<R>(declared.sql, values)).rows;
  if (rows.length > declared.rows || Buffer.byteLength(JSON.stringify(rows) ?? '') > declared.resultBytes)
    throw new ProblemError('dependency_unavailable');
  return rows;
}

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
      CANONICAL_SOURCE_STATEMENTS().scope,
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
    const [head] = await query<{ generation: string }>(work, current, CANONICAL_SOURCE_STATEMENTS().head, [
      source.route,
      source.collectionId,
    ]);
    if (!head) throw new ProblemError('dependency_unavailable');
    const [generation] = await query<{ basis: CanonicalBasis; state: string; source_exhausted: boolean }>(
      work,
      current,
      CANONICAL_SOURCE_STATEMENTS().generation,
      [source.route, source.collectionId, head.generation],
    );
    if (!generation || generation.state !== 'complete' || !generation.source_exhausted)
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
      work: sourceReceipt(COLLECTION_SOURCE_WORK_COST().state),
    });
  } catch (error) {
    if (error instanceof Error)
      Object.defineProperty(error, 'work', {
        value: sourceReceipt(COLLECTION_SOURCE_WORK_COST().state),
        configurable: true,
      });
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
    const [row] = await query<{ subject: string }>(work, current, CANONICAL_SOURCE_STATEMENTS().seek, [
      state.metadata.route,
      state.metadata.collectionId,
      state.generation,
      after,
    ]);
    return { subjectId: row?.subject ?? null, work: sourceReceipt(COLLECTION_SOURCE_WORK_COST().seek) };
  } catch (error) {
    if (error instanceof Error)
      Object.defineProperty(error, 'work', {
        value: sourceReceipt(COLLECTION_SOURCE_WORK_COST().seek),
        configurable: true,
      });
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
  const cost = COLLECTION_SOURCE_WORK_COST().group(limit);
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
      canonicalSourceGroupStatement(limit),
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
    if (error instanceof Error)
      Object.defineProperty(error, 'work', { value: sourceReceipt(cost), configurable: true });
    throw error;
  }
}
