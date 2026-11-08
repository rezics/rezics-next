/** Search application boundary for Library-backed native scoped membership and ordering. */
import { isDeepStrictEqual } from 'node:util';
import type { Pool } from 'pg';
import type { KernelClock } from '../clock.ts';
import type {
  CollectionAliasProgress,
  CollectionSourceContext,
  CollectionSourceObservation,
  LibraryActor,
  NativeOrdinalKey,
  WorkAllowance,
  WorkReceipt,
} from '../library/contract/index.ts';
import type { Access } from '../request/access.ts';
import type { ScopeWorkContext } from '../library/adapters/index.ts';
import { SearchOperationError } from './operation-outcomes.ts';
import type {
  SearchLibraryScopePort,
  SearchScopeCollection,
  SearchScopeOrder,
  SearchScopeWorkDefinition,
} from './library-scope-port.ts';

export type SearchScopeReader = Readonly<{
  access: Access;
  deadline: number;
  actor?: LibraryActor;
  nativeT?: unknown;
  work?: ScopeWorkContext;
}>;

function unready(): never {
  throw new SearchOperationError('semantic_not_ready');
}

function unsupported(): never {
  throw new SearchOperationError('unsupported_query');
}

function unavailable(): never {
  throw new SearchOperationError('dependency_unavailable');
}

type ScopeCurrentWork = Readonly<{
  sourceIdentity: SearchScopeWorkDefinition['sourceIdentity'];
  observation: SearchScopeWorkDefinition['observation'];
  definition?: Readonly<{ sort?: SearchScopeWorkDefinition['definition']['sort'] }>;
}>;

/** Application orchestration around the complete native Collection source capability. */
export function createSearchScopeOrderApplication(
  config: Readonly<{
    pool: Pool;
    options: SearchScopeReader;
    clock: KernelClock;
    library: SearchLibraryScopePort;
    readWorkDefinition: (
      work: ScopeWorkContext,
      options: Readonly<{ pool: Pool; access: Access; deadline: number; library: SearchLibraryScopePort }>,
    ) => Promise<ScopeCurrentWork>;
    selectedOrdinalPage: () => Readonly<{ limit: number }>;
  }>,
) {
  const { pool, options, clock, library, readWorkDefinition, selectedOrdinalPage } = config;
  const native = library.source.open({ pool, access: options.access, clock });

  function context(): CollectionSourceContext {
    if (options.work) return { work: options.work, deadline: options.deadline };
    if (!options.nativeT) unready();
    if (!options.actor) unready();
    return { actor: options.actor, at: options.nativeT, deadline: options.deadline };
  }

  async function currentWork(
    order: SearchScopeOrder,
    observation?: CollectionSourceObservation,
    expected?: ScopeCurrentWork,
  ) {
    if (!options.work) return;
    const current = await readWorkDefinition(options.work, {
      pool,
      access: options.access,
      deadline: options.deadline,
      library,
    });
    if (
      order.kind !== (current.definition?.sort ?? 'id') ||
      !isDeepStrictEqual(order.source, current.sourceIdentity) ||
      (observation !== undefined && !isDeepStrictEqual(observation, current.observation)) ||
      (expected !== undefined && !isDeepStrictEqual(expected, structuredClone(current)))
    )
      unready();
    return structuredClone(current);
  }

  return {
    async prepare(
      order: SearchScopeOrder,
      allowance: WorkAllowance,
    ): Promise<Readonly<{ collection: SearchScopeCollection; work: WorkReceipt }>> {
      const identity = order.source;
      if (!identity || (order.kind === 'ordinal' && identity.scope !== 'curated')) unsupported();
      if (
        options.work &&
        ((options.work.kind === 'members-preparation' ? identity.scope !== 'curated' : identity.scope === 'curated') ||
          identity.collectionId !== options.work.locator.collectionId ||
          (options.work.kind === 'collection-publication' && identity.scope !== 'private_builtin') ||
          identity.route !== options.work.locator.route ||
          (identity.scope !== 'public_output' && identity.accountId !== options.work.locator.ownerAccountId))
      )
        unready();
      const admitted = await currentWork(order);
      const result = await native.prepare({ ...context(), collectionId: identity.collectionId, allowance });
      if (
        result.source.observation.collectionId !== identity.collectionId ||
        result.source.observation.incarnation !== identity.incarnation ||
        result.source.observation.route !== identity.route
      )
        unready();
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
        options.work?.kind === 'members-preparation'
          ? selectedOrdinalPage()
          : library.source.limits.ordinalPageBound(limit);
      if (limit !== statement.limit) unavailable();
      const admitted = await currentWork(collection.order, collection.observation);
      const page = await native.readRawOrdinalPrefix({
        ...context(),
        source: collection.source,
        after,
        limit: statement.limit,
        allowance,
      });
      if (!isDeepStrictEqual(page.observation, collection.observation)) unready();
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
      if (!isDeepStrictEqual(page.observation, collection.observation)) unready();
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
      if (!isDeepStrictEqual(result.observation, collection.observation)) unready();
      await currentWork(collection.order, result.observation, admitted);
      return result;
    },
  };
}

/** Full scoped observation comparison; a committed revision alone is not a Source identity. */
export function sameScopeObservation(a: unknown, b: unknown): boolean {
  return isDeepStrictEqual(a, b);
}

export type { SearchScopeCollection, SearchScopeOrder };
