import { isDeepStrictEqual } from 'node:util';
import type { Pool } from 'pg';
import type { KernelClock } from '../clock.ts';
import { ProblemError } from '../http/problem.ts';
import {
  createCollectionSource,
  type CollectionSourceObservation,
  type CollectionAliasProgress,
  type PreparedCollectionSource,
  type WorkAllowance,
  type WorkReceipt,
  type CollectionSourceContext,
} from '../library/collection-source.ts';
import type {
  NativeOrdinalFrontier,
  NativeOrdinalKey,
  RawOrdinalCollectionPrefix,
} from '../library/collection-source-order.ts';
import { type NativeSourceIdentity } from '../library/native-source-custody.ts';
import type { LeafOptions } from '../semantic/scope-leaf-evidence.ts';
import type { IdentityScopeObservation } from '../semantic/identity-scope-types.ts';
import { readScopeWorkDefinition } from './scope-work-context.ts';

/** Internal Source locator, never an authority assertion or public Search sort. */
export type SearchScopeOrder =
  | Readonly<{ kind: 'id'; source?: NativeSourceIdentity }>
  | Readonly<{ kind: 'ordinal'; source: NativeSourceIdentity }>;
export type SearchScopeOrdinalPrefix = Readonly<{
  subjects: readonly Readonly<{ subject: string; after: NativeOrdinalKey }>[];
  frontier: NativeOrdinalFrontier;
  exhausted: boolean;
  observation: CollectionSourceObservation;
  work: WorkReceipt;
}>;
export type SearchScopeCollection = Readonly<{
  order: SearchScopeOrder;
  source: PreparedCollectionSource;
  observation: CollectionSourceObservation;
}>;

/** CLOSED adapter API. Native rows/frontiers/work keep their Library type home.
 * Raw ordinal exhaustion describes input only. Search preparation resolves identity,
 * current disclosure and DISTINCT before selecting an output page.
 */
export function createSearchScopeOrder(
  config: Readonly<{
    pool: Pool;
    options: LeafOptions;
    clock: KernelClock;
  }>,
) {
  const { pool, options, clock } = config;
  const native = createCollectionSource({ pool, access: options.access, clock });
  function context(): CollectionSourceContext {
    if (options.work) return { work: options.work, deadline: options.deadline };
    if (!options.nativeT) throw new ProblemError('semantic_not_ready');
    return { actor: options.actor, at: options.nativeT, deadline: options.deadline };
  }
  async function currentWork(
    order: SearchScopeOrder,
    observation?: CollectionSourceObservation,
    expected?: Awaited<ReturnType<typeof readScopeWorkDefinition>>,
  ) {
    if (!options.work) return;
    const native = await readScopeWorkDefinition(options.work, {
      pool,
      access: options.access,
      deadline: options.deadline,
    });
    if (
      order.kind !== ('definition' in native ? native.definition.sort : 'id') ||
      !isDeepStrictEqual(order.source, native.sourceIdentity) ||
      (observation !== undefined && !isDeepStrictEqual(observation, native.observation)) ||
      (expected !== undefined && !isDeepStrictEqual(expected, structuredClone(native)))
    )
      throw new ProblemError('semantic_not_ready');
    return structuredClone(native);
  }
  return {
    async prepare(
      order: SearchScopeOrder,
      allowance: WorkAllowance,
    ): Promise<{
      collection: SearchScopeCollection;
      work: WorkReceipt;
    }> {
      const identity = order.source;
      if (!identity || (order.kind === 'ordinal' && identity.scope !== 'curated'))
        throw new ProblemError('unsupported_query');
      if (
        options.work &&
        ((options.work.kind === 'members-preparation' ? identity.scope !== 'curated' : identity.scope === 'curated') ||
          identity.collectionId !== options.work.locator.collectionId ||
          (options.work.kind === 'collection-publication' && identity.scope !== 'private_builtin') ||
          identity.route !== options.work.locator.route ||
          (identity.scope !== 'public_output' && identity.accountId !== options.work.locator.ownerAccountId))
      )
        throw new ProblemError('semantic_not_ready');
      const admitted = await currentWork(order);
      const result = await native.prepare({ ...context(), collectionId: identity.collectionId, allowance });
      if (
        result.source.observation.collectionId !== identity.collectionId ||
        result.source.observation.incarnation !== identity.incarnation ||
        result.source.observation.route !== identity.route
      )
        throw new ProblemError('semantic_not_ready');
      await currentWork(order, result.source.observation, admitted);
      return {
        collection: { order, source: result.source, observation: result.source.observation },
        work: result.work,
      };
    },
    async rawOrdinal(
      collection: SearchScopeCollection,
      after: NativeOrdinalKey | null,
      limit: number,
      allowance: WorkAllowance,
    ): Promise<RawOrdinalCollectionPrefix> {
      if (collection.order.kind !== 'ordinal') throw new TypeError('Ordinal source required');
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new RangeError('Invalid ordinal limit');
      const admitted = await currentWork(collection.order, collection.observation);
      const page = await native.readRawOrdinalPrefix({
        ...context(),
        source: collection.source,
        after,
        limit,
        allowance,
      });
      if (!isDeepStrictEqual(page.observation, collection.observation)) throw new ProblemError('semantic_not_ready');
      await currentWork(collection.order, page.observation, admitted);
      return page;
    },
    async prefix(
      collection: SearchScopeCollection,
      afterSubjectId: string | null,
      allowance: WorkAllowance,
      candidateLimit?: number,
    ) {
      if (options.work && (!Number.isSafeInteger(candidateLimit) || candidateLimit! < 1 || candidateLimit! > 100))
        throw new RangeError('Selected Collection Source candidate limit required');
      const admitted = await currentWork(collection.order, collection.observation);
      const page = await native.prefix({
        ...context(),
        source: collection.source,
        afterSubjectId,
        allowance,
        ...(candidateLimit === undefined ? {} : { candidateLimit }),
      });
      if (!isDeepStrictEqual(page.observation, collection.observation)) throw new ProblemError('semantic_not_ready');
      await currentWork(collection.order, page.observation, admitted);
      return page;
    },
    async contains(
      collection: SearchScopeCollection,
      subjectId: string,
      allowance: WorkAllowance,
      progress?: CollectionAliasProgress,
    ) {
      const admitted = await currentWork(collection.order, collection.observation);
      const result = await native.containsSubject({
        ...context(),
        source: collection.source,
        subjectId,
        allowance,
        ...(progress ? { progress } : {}),
      });
      if (!isDeepStrictEqual(result.observation, collection.observation)) throw new ProblemError('semantic_not_ready');
      await currentWork(collection.order, result.observation, admitted);
      return result;
    },
  };
}

/** Full scoped observation comparison; a committed revision alone is not a Source identity. */
export function sameScopeObservation(a: IdentityScopeObservation, b: IdentityScopeObservation): boolean {
  return isDeepStrictEqual(a, b);
}
