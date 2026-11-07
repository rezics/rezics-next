/** Search application boundary for Library-backed native scoped membership and ordering. */
import { isDeepStrictEqual } from 'node:util';
import type { Pool } from 'pg';
import { ProblemError } from '../http/problem.ts';
import type { KernelClock } from '../clock.ts';
import type { WorkAllowance, WorkReceipt } from '../library/contract/work-dimensions.ts';
import type {
  CollectionAliasProgress,
  CollectionSourceContext,
  CollectionSourceObservation,
} from '../library/collection-source.ts';
import type { NativeOrdinalKey } from '../library/collection-source-order.ts';
import type { LeafOptions } from '../semantic/scope-leaf-evidence.ts';
import type { IdentityScopeObservation } from '../semantic/identity-scope-types.ts';
import type { readScopeWorkDefinition } from './scope-work-context.ts';
import type { SearchLibraryScopePort, SearchScopeCollection, SearchScopeOrder } from './library-scope-port.ts';

let installedLibraryScope: SearchLibraryScopePort;

/** Installed once by Kernel composition, before Library or Search exposes scoped work. */
export function bindSearchLibraryScopePort(port: SearchLibraryScopePort): void {
  installedLibraryScope = port;
}

/** The port is supplied by composition; use before constructing any scoped Search operation. */
export function searchLibraryScopePort(): SearchLibraryScopePort {
  return installedLibraryScope!;
}

type ScopeWorkDefinition = Awaited<ReturnType<typeof readScopeWorkDefinition>>;

/** Application orchestration around the complete native Collection source capability. */
export function createSearchScopeOrderApplication(
  config: Readonly<{
    pool: Pool;
    options: LeafOptions;
    clock: KernelClock;
    library: SearchLibraryScopePort;
    readWorkDefinition: typeof readScopeWorkDefinition;
    selectedOrdinalPage: () => Readonly<{ limit: number }>;
  }>,
) {
  const { pool, options, clock, library, readWorkDefinition, selectedOrdinalPage } = config;
  const native = library.source.create({ pool, access: options.access, clock });

  function context(): CollectionSourceContext {
    if (options.work) return { work: options.work, deadline: options.deadline };
    if (!options.nativeT) throw new ProblemError('semantic_not_ready');
    return { actor: options.actor, at: options.nativeT, deadline: options.deadline };
  }

  async function currentWork(
    order: SearchScopeOrder,
    observation?: CollectionSourceObservation,
    expected?: ScopeWorkDefinition,
  ) {
    if (!options.work) return;
    const current = await readWorkDefinition(options.work, {
      pool,
      access: options.access,
      deadline: options.deadline,
    });
    if (
      order.kind !== ('definition' in current ? current.definition.sort : 'id') ||
      !isDeepStrictEqual(order.source, current.sourceIdentity) ||
      (observation !== undefined && !isDeepStrictEqual(observation, current.observation)) ||
      (expected !== undefined && !isDeepStrictEqual(expected, structuredClone(current)))
    )
      throw new ProblemError('semantic_not_ready');
    return structuredClone(current);
  }

  return {
    async prepare(
      order: SearchScopeOrder,
      allowance: WorkAllowance,
    ): Promise<Readonly<{ collection: SearchScopeCollection; work: WorkReceipt }>> {
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
    ) {
      if (collection.order.kind !== 'ordinal') throw new TypeError('Ordinal source required');
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new RangeError('Invalid ordinal limit');
      const statement =
        options.work?.kind === 'members-preparation' ? selectedOrdinalPage() : library.source.ordinalPageBound(limit);
      if (limit !== statement.limit) throw new ProblemError('dependency_unavailable');
      const admitted = await currentWork(collection.order, collection.observation);
      const page = await native.readRawOrdinalPrefix({
        ...context(),
        source: collection.source,
        after,
        limit: statement.limit,
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

export type { SearchScopeCollection, SearchScopeOrder };
