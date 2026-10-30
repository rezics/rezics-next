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
} from '../library/collection-source.ts';
import type {
  NativeOrdinalFrontier,
  NativeOrdinalKey,
  RawOrdinalCollectionPrefix,
} from '../library/collection-source-order.ts';
import { type NativeSourceIdentity } from '../library/native-source-custody.ts';
import type { LeafOptions } from '../semantic/scope-leaf-evidence.ts';
import type { IdentityScopeObservation } from '../semantic/identity-scope-types.ts';

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
  function context() {
    if (!options.nativeT) throw new ProblemError('semantic_not_ready');
    return { actor: options.actor, at: options.nativeT, deadline: options.deadline };
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
      const result = await native.prepare({ ...context(), collectionId: identity.collectionId, allowance });
      if (
        result.source.observation.collectionId !== identity.collectionId ||
        result.source.observation.incarnation !== identity.incarnation ||
        result.source.observation.route !== identity.route
      )
        throw new ProblemError('semantic_not_ready');
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
      const page = await native.readRawOrdinalPrefix({
        ...context(),
        source: collection.source,
        after,
        limit,
        allowance,
      });
      if (!isDeepStrictEqual(page.observation, collection.observation)) throw new ProblemError('semantic_not_ready');
      return page;
    },
    async prefix(collection: SearchScopeCollection, afterSubjectId: string | null, allowance: WorkAllowance) {
      const page = await native.prefix({ ...context(), source: collection.source, afterSubjectId, allowance });
      if (!isDeepStrictEqual(page.observation, collection.observation)) throw new ProblemError('semantic_not_ready');
      return page;
    },
    async contains(
      collection: SearchScopeCollection,
      subjectId: string,
      allowance: WorkAllowance,
      progress?: CollectionAliasProgress,
    ) {
      const result = await native.containsSubject({
        ...context(),
        source: collection.source,
        subjectId,
        allowance,
        ...(progress ? { progress } : {}),
      });
      if (!isDeepStrictEqual(result.observation, collection.observation)) throw new ProblemError('semantic_not_ready');
      return result;
    },
  };
}

/** Full scoped observation comparison; a committed revision alone is not a Source identity. */
export function sameScopeObservation(a: IdentityScopeObservation, b: IdentityScopeObservation): boolean {
  return isDeepStrictEqual(a, b);
}
