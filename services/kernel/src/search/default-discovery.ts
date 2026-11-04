import { prepareSearchReviewContexts } from './review-context.ts';
import { boundWorkContexts } from './work-context.ts';
import { readFollowDiscovery } from '../library/follow-discovery.ts';
import { readSpaceDiscoveryEntryBatch, type SpaceEntryActionRuntime } from '../community/space-discovery-entry.ts';
import { observeSearchSpaceEntries, spaceEntryFollowing, type SpaceEntryFollowProducer } from './space-entry.ts';
import type { KeyRing } from '../tokens/seal.ts';
import { ProblemError } from '../http/problem.ts';
import { isDeepStrictEqual } from 'node:util';
import { activeRelease } from '../semantic/definitions.ts';
import { publicFilterSource } from '../semantic/public-filter-source.ts';
import { createWorkClient } from '../work/client.ts';
import { createReviewDiscoverySource, type ReviewDiscoverySource } from '../content/review-discovery.ts';
import type { Pool } from 'pg';
import { deadlineClient } from '../access/authenticate.ts';
import { discardConnection, withConnection } from '../database/pool.ts';
import { readListPresentationFacts } from '../semantic/list-presentation.ts';
import {
  prepareViewerFacts,
  readViewerFacts,
  viewerFactsCurrent,
  type ViewerFactInput,
  type ViewerFactsPage,
  type PreparedViewerFacts,
} from '../library/viewer-facts.ts';
import { readPublicFigureViews } from '../rating/public-figure-http.ts';
import { STANDARD_QUESTION_ID } from '../rating/votes.ts';
import type { AccountActor } from '../request/access.ts';
import { SearchUnavailableError } from './opensearch.ts';
import { nativeDiscoveryRegistry } from './account-discovery.ts';
import { CollectionDiscoveryReadinessError, createNativeCollectionDiscoveryAdapter } from './collection-discovery.ts';
import { createReviewDiscoveryAdapter } from './review-discovery.ts';
import { nativeSpaceDiscoveryAdapter } from './space-discovery.ts';
import type { SpaceDiscoverySummary } from '../community/space-discovery.ts';
import type {
  DiscoveryOwnerAdapterSlots,
  DiscoveryOwnerMetadataSummary,
  DiscoveryPage,
  DiscoveryReadContext,
  DiscoveryUnionHit,
} from './discovery.ts';
import type { DiscoveryMetadataKind, DiscoveryMetadataProducer } from './generations.ts';
import type { SecondScopeDiscoveryKey, SecondScopeDiscoveryRecord } from './discovery-documents.ts';
import { routeOf, partitionOf } from '../route/route.ts';
import { createRatedSubjectSource } from './rated-source.ts';
import {
  createRetainedDiscoverySearch,
  type DiscoverySearch,
  type RetainedDiscoveryRead,
  type RetainedDiscoverySearch,
} from './discovery-service.ts';
import { ownDiscoveryRequest } from './discovery-request.ts';
import { createDefaultPublicFilterRuntime, type DefaultPublicFilterRuntimeConfig } from './public-runtime.ts';
import { createPublicPreparationStore } from './public-preparation-store.ts';
import {
  discoveryConsumer,
  DiscoveryProducerCoverageError,
  DiscoveryPopulationCutChangedError,
  assertDiscoveryCapabilityBinding,
  discoveryGenerations,
} from './generations.ts';
import { discoveryIndexName } from './indices.ts';
import { createFreshness } from './freshness.ts';
import { searchObservation } from './search-context.ts';
import type { PublicDiscoveryConsumerOperations } from './public-filter-consumer-contract.ts';
import {
  installPublicFilterCoveragePage,
  openPublicFilterCoveragePage,
  type PublicFilterCoveragePage,
} from './public-filter-coverage-page.ts';

export type DefaultDiscoverySearchConfig = DefaultPublicFilterRuntimeConfig & {
  keys: KeyRing;
  spaceEntryActions?: SpaceEntryActionRuntime;
  spaceEntryFollow?: SpaceEntryFollowProducer;
};
export type DefaultDiscoverySearch = Readonly<{
  search: DiscoverySearch;
  open: RetainedDiscoverySearch;
  close(): Promise<void>;
}>;

export type DefaultDiscoveryOwnerAdapters = DiscoveryOwnerAdapterSlots &
  Readonly<{ metadataProducers: Readonly<Record<DiscoveryMetadataKind, DiscoveryMetadataProducer>> }>;

type SemanticDiscoveryHit = Extract<DiscoveryUnionHit, { summary: { kind: 'subject' } }>;
type EnrichedDiscoveryPage = Readonly<{
  page: DiscoveryPage;
  semanticOriginals: readonly string[];
  semanticPresentation: Awaited<ReturnType<typeof readListPresentationFacts>>;
  figureIds: readonly string[];
  figures: Awaited<ReturnType<typeof readPublicFigureViews>>;
  viewer: Readonly<{ actor: AccountActor; prepared: PreparedViewerFacts }> | null;
}>;

function viewerRowKey(hit: SemanticDiscoveryHit) {
  return JSON.stringify([hit.key.owner, hit.key.kind, hit.key.route, hit.key.id]);
}

/** Publication owns the retained read until both private and public final authority have completed. */
export async function readAdmittedDiscoveryPage(
  read: Pick<RetainedDiscoveryRead, 'search' | 'finish' | 'close'>,
  assemble: (page: DiscoveryPage) => Promise<Readonly<{ page: DiscoveryPage; viewerCurrent: boolean }>>,
): Promise<DiscoveryPage> {
  try {
    const assembled = await assemble(await read.search());
    // Losing viewer authority invalidates the whole assembly, including its cursors.
    // A producer's unavailable envelope is separate: it can accompany a current public page.
    if (!assembled.viewerCurrent) throw new ProblemError('search_restart_required');
    await read.finish();
    return assembled.page;
  } finally {
    // close also settles the native execution when assembly or a final guard refuses publication.
    await read.close();
  }
}

async function enrichDiscoveryPage(
  config: DefaultDiscoverySearchConfig,
  principal: string,
  page: DiscoveryPage,
  context: DiscoveryReadContext,
): Promise<EnrichedDiscoveryPage> {
  const languages = context.languages ?? ['en'];
  const subjects = page.hits.filter((hit): hit is SemanticDiscoveryHit => hit.summary.kind === 'subject');
  const originals = subjects.map(({ key }) => key.id);
  const presentation = await readListPresentationFacts(
    {
      pool: config.pool,
      access: config.access,
      actor: context.actor,
      routeKey: config.routeKey,
      deadline: context.deadline,
    },
    originals,
    { languages, workContext: true },
  );
  const facts = subjects.map((hit) => {
    const value = presentation.get(hit.key.id);
    if (!value) throw new SearchUnavailableError('Current Search facts are incomplete');
    return { rowKey: viewerRowKey(hit), subjectId: hit.key.id, facts: structuredClone(value.facts) };
  });
  const figureIds = [...new Set(subjects.filter(({ summary }) => summary.value.creativeWork).map(({ key }) => key.id))];
  let prepared: PreparedViewerFacts | undefined;
  let viewerActor: AccountActor | undefined;
  let viewerFacts: ViewerFactsPage | null =
    context.actor.kind === 'anonymous'
      ? null
      : {
          state: 'unavailable',
          reason: 'currentness',
          retryable: true,
        };
  if (context.actor.kind === 'account' && principal === `account:${context.actor.accountId}`) {
    viewerActor = context.actor;
    try {
      prepared = await prepareViewerFacts(
        { pool: config.pool, access: config.access },
        viewerActor,
        facts.map(({ rowKey, subjectId }) => ({ rowKey, subjectId }) satisfies ViewerFactInput),
        STANDARD_QUESTION_ID,
        context.deadline,
      );
    } catch (error) {
      if (!(error instanceof RangeError) || error.message !== 'Viewer facts input exceeds 16384 encoded bytes')
        throw error;
      viewerFacts = { state: 'unavailable', reason: 'response_limit', retryable: false };
      viewerActor = undefined;
    }
  }
  const snapshot = await withConnection(config.pool, async (connection) => {
    const client = deadlineClient(connection, context.deadline);
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    try {
      const viewerFacts = prepared && viewerActor ? await readViewerFacts(client, viewerActor, prepared) : null;
      const figures = await readPublicFigureViews(client, figureIds);
      await client.query('COMMIT');
      return { viewerFacts, figures };
    } catch (error) {
      try {
        await connection.query('ROLLBACK');
      } catch (rollbackError) {
        discardConnection(
          connection,
          rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError)),
        );
      }
      throw error;
    }
  });
  if (prepared && viewerActor) viewerFacts = snapshot.viewerFacts;
  if (snapshot.figures) {
    for (const id of figureIds)
      if (!snapshot.figures.has(id)) throw new SearchUnavailableError('Current public figure is incomplete');
  }
  const contexts = boundWorkContexts(subjects.map((hit) => presentation.get(hit.key.id)?.workContext));
  const byContext = new Map(subjects.map((hit, index) => [hit.key.id, contexts[index]]));
  const bySubject = new Map(subjects.map((hit, index) => [hit.key.id, facts[index]!]));
  return {
    page: {
      ...page,
      hits: page.hits.map((hit) => {
        if (hit.summary.kind !== 'subject') return hit;
        const current = bySubject.get(hit.key.id);
        const workContext = byContext.get(hit.key.id);
        const figure = snapshot.figures?.get(hit.key.id)?.figure;
        return {
          ...hit,
          ...(current ? { facts: current.facts } : {}),
          ...(workContext ? { workContext } : {}),
          ...(figure && hit.summary.value.creativeWork ? { figure: { ...figure, scale: { ...figure.scale } } } : {}),
        };
      }),
      viewerFacts:
        viewerFacts?.state === 'current' && prepared
          ? (() => {
              const mappings = new Map(prepared.mappings.map(({ subjectId, mapping }) => [subjectId, mapping]));
              const current = {
                ...viewerFacts,
                rows: viewerFacts.rows.map((row) => {
                  const mapping = mappings.get(row.subjectId);
                  return { ...row, resolvedSubjectId: mapping?.state === 'mapped' ? mapping.terminal : row.subjectId };
                }),
              };
              return new TextEncoder().encode(JSON.stringify(current)).byteLength <= 65536
                ? current
                : { state: 'unavailable' as const, reason: 'response_limit' as const, retryable: false };
            })()
          : viewerFacts,
    },
    semanticOriginals: originals,
    semanticPresentation: presentation,
    figureIds,
    figures: snapshot.figures,
    viewer: prepared && viewerActor ? { actor: viewerActor, prepared } : null,
  };
}

async function readDiscoveryFigures(config: DefaultDiscoverySearchConfig, ids: readonly string[], deadline: number) {
  return withConnection(config.pool, async (connection) => {
    const client = deadlineClient(connection, deadline);
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    try {
      const figures = await readPublicFigureViews(client, ids);
      await client.query('COMMIT');
      return figures;
    } catch (error) {
      try {
        await connection.query('ROLLBACK');
      } catch (rollbackError) {
        discardConnection(
          connection,
          rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError)),
        );
      }
      throw error;
    }
  });
}

function metadataKey(owner: 'commerce' | 'content', kind: 'collection' | 'review' | 'space', id: string) {
  const route = routeOf(id);
  if (route === null) throw new TypeError(`Invalid native ${kind} identity`);
  return { owner, kind, route, id } as SecondScopeDiscoveryKey;
}

function requestedKeys(
  owner: 'commerce' | 'content',
  kind: 'collection' | 'review' | 'space',
  partition: number,
  ids: readonly string[],
): SecondScopeDiscoveryKey[] {
  if (!Array.isArray(ids) || ids.length > 100) throw new RangeError(`Native ${kind} read exceeds 100 identities`);
  const unique = [...new Set(ids)];
  const keys = unique.map((id) => metadataKey(owner, kind, id));
  if (keys.some((key) => partitionOf(key.route) !== partition))
    throw new TypeError(`Native ${kind} identities cross their source partition`);
  return keys;
}

function collectionRecords(
  items: readonly import('../library/collection-discovery-source.ts').CollectionDiscoveryItem[],
) {
  const records: SecondScopeDiscoveryRecord[] = [];
  for (const item of items) {
    if (item.status === 'unavailable') throw new CollectionDiscoveryReadinessError('unavailable', item.reason);
    if (item.status !== 'indexable') continue;
    records.push({
      key: { owner: 'commerce', kind: 'collection', ...item.key },
      revision: BigInt(item.value.revision),
      sourceVersion: null,
      names: [item.value.title],
      descriptions: [],
      nameSort: item.value.title,
    });
  }
  return records;
}

function reviewRecords(
  partition: number,
  position: bigint,
  reviews: readonly import('../content/review-discovery.ts').IndexedReview[],
) {
  const records: SecondScopeDiscoveryRecord[] = [];
  for (const review of reviews) {
    const key = metadataKey('content', 'review', review.id);
    if (partitionOf(key.route) !== partition) throw new TypeError('Review source returned a foreign partition key');
    if (
      !Object.prototype.propertyIsEnumerable.call(review, 'sourceVersion') ||
      typeof review.sourceVersion !== 'string' ||
      !review.sourceVersion ||
      !review.sourceVersion.isWellFormed()
    )
      throw new TypeError('Review source version is invalid');
    const excerpt = review.excerpt ?? '';
    records.push({
      key,
      revision: position,
      sourceVersion: review.sourceVersion,
      names: review.title === null ? [] : [review.title],
      descriptions: [excerpt],
      nameSort: review.title,
    });
  }
  return records;
}

function spaceRecords(partition: number, spaces: readonly import('../community/space-discovery.ts').IndexedSpace[]) {
  return spaces.map((space): SecondScopeDiscoveryRecord => {
    const key = metadataKey('content', 'space', space.id);
    if (partitionOf(key.route) !== partition) throw new TypeError('Space source returned a foreign partition key');
    return {
      key,
      revision: BigInt(space.revision),
      sourceVersion: null,
      names: [space.name],
      descriptions: [space.description],
      nameSort: space.name,
    };
  });
}

function createCollectionPopulationProducer(
  adapter: ReturnType<typeof createNativeCollectionDiscoveryAdapter>,
): DiscoveryMetadataProducer {
  return {
    kind: 'collection',
    owner: 'commerce',
    async readiness() {
      return adapter.status === 'ready' ? 'ready' : adapter.status;
    },
    async page(partition, after, continuation, limit) {
      if (continuation !== null) throw new TypeError('Collection discovery does not use an opaque continuation');
      const page = await adapter.source.page(partition, after, limit);
      if (page.status !== 'available') throw new CollectionDiscoveryReadinessError('unavailable', page.reason);
      return {
        position: BigInt(page.stamp.position),
        epoch: page.stamp.epoch,
        next: page.next,
        continuation: null,
        keys: page.items.map((item) => ({ owner: 'commerce', kind: 'collection', ...item.key })),
        records: collectionRecords(page.items),
      };
    },
    async read(partition, ids) {
      const keys = requestedKeys('commerce', 'collection', partition, ids);
      const snapshot = await adapter.source.read(
        partition,
        keys.map(({ route, id }) => ({ route, id })),
      );
      if (snapshot.status !== 'available') throw new CollectionDiscoveryReadinessError('unavailable', snapshot.reason);
      return {
        position: BigInt(snapshot.stamp.position),
        epoch: snapshot.stamp.epoch,
        keys,
        records: collectionRecords(snapshot.items),
      };
    },
    async position(partition) {
      const snapshot = await adapter.source.read(partition, []);
      if (snapshot.status !== 'available') throw new CollectionDiscoveryReadinessError('unavailable', snapshot.reason);
      return BigInt(snapshot.stamp.position);
    },
  };
}

function createReviewPopulationProducer(source: ReviewDiscoverySource | undefined): DiscoveryMetadataProducer {
  return {
    kind: 'review',
    owner: 'content',
    async readiness() {
      return source?.pageWithCut ? 'ready' : 'unavailable';
    },
    async page(partition, after, continuation, limit) {
      if (!source?.pageWithCut) throw new TypeError('Content review discovery pageWithCut capability is unavailable');
      if (continuation !== null && after === null)
        throw new TypeError('Review continuation has no native full-key frontier');
      const cursor = continuation === null ? null : { ...after!, token: continuation };
      const page = await source.pageWithCut(partition, cursor, limit);
      if (page.state === 'changed') throw new DiscoveryPopulationCutChangedError('review');
      if (page.state !== 'ready')
        throw new DiscoveryProducerCoverageError({
          missingKinds: [],
          unsupportedKinds: ['review'],
          duplicateKinds: [],
        });
      if (page.next && (typeof page.next.token !== 'string' || !page.next.token))
        throw new TypeError('Content review population returned an invalid opaque continuation');
      return {
        position: page.position,
        next: page.next ? { route: page.next.route, id: page.next.id } : null,
        continuation: page.next?.token ?? null,
        keys: page.reviews.map((review) => metadataKey('content', 'review', review.id)),
        records: reviewRecords(partition, page.position, page.reviews),
      };
    },
    async read(partition, ids) {
      if (!source) throw new TypeError('Content review discovery source is unavailable');
      const keys = requestedKeys('content', 'review', partition, ids);
      const snapshot = await source.read(partition, ids);
      return {
        position: snapshot.position,
        keys,
        records: reviewRecords(partition, snapshot.position, snapshot.reviews),
      };
    },
    async position(partition) {
      if (!source) throw new TypeError('Content review discovery source is unavailable');
      return (await source.read(partition, [])).position;
    },
  };
}

function createSpacePopulationProducer(
  adapter: ReturnType<typeof nativeSpaceDiscoveryAdapter>,
): DiscoveryMetadataProducer {
  return {
    kind: 'space',
    owner: 'content',
    async readiness() {
      return adapter.source.dependencies();
    },
    async page(partition, after, continuation, limit) {
      if (continuation !== null) throw new TypeError('Space discovery does not use an opaque continuation');
      const page = await adapter.source.page(partition, after, limit);
      return {
        position: page.position,
        next: page.next,
        continuation: null,
        keys: page.spaces.map((space) => metadataKey('content', 'space', space.id)),
        records: spaceRecords(partition, page.spaces),
      };
    },
    async read(partition, ids) {
      const keys = requestedKeys('content', 'space', partition, ids);
      const snapshot = await adapter.source.read(partition, ids);
      return { position: snapshot.position, keys, records: spaceRecords(partition, snapshot.spaces) };
    },
    async position(partition) {
      return (await adapter.source.read(partition, [])).position;
    },
  };
}

/** Bind the delivered Commerce and Content leaves to the canonical current-reader slots. */
export function createDefaultDiscoveryOwnerAdapters(config: {
  pool: Pool;
  routeKey: Uint8Array;
  access: DefaultPublicFilterRuntimeConfig['access'];
  clock?: DefaultPublicFilterRuntimeConfig['clock'];
  keys?: KeyRing;
  reviewSource?: ReviewDiscoverySource;
}): DefaultDiscoveryOwnerAdapters {
  const metadata = {
    collection: {
      id: 'collection',
      labels: {
        de: 'Sammlungen',
        en: 'Collections',
        es: 'Colecciones',
        fr: 'Collections',
        ja: 'コレクション',
        ko: '컬렉션',
        'zh-Hans': '收藏集',
        'zh-Hant': '收藏集',
      },
      icon: 'library',
    },
    review: {
      id: 'review',
      labels: {
        de: 'Rezensionen',
        en: 'Reviews',
        es: 'Reseñas',
        fr: 'Avis',
        ja: 'レビュー',
        ko: '리뷰',
        'zh-Hans': '评论',
        'zh-Hant': '評論',
      },
      icon: 'message-square',
    },
    space: {
      id: 'space',
      labels: {
        de: 'Spaces',
        en: 'Spaces',
        es: 'Espacios',
        fr: 'Espaces',
        ja: 'スペース',
        ko: '스페이스',
        'zh-Hans': '空间',
        'zh-Hant': '空間',
      },
      icon: 'users',
    },
  } as const;
  const clock = config.clock ? { clock: config.clock } : {};
  const collection = createNativeCollectionDiscoveryAdapter(
    { pool: config.pool, access: config.access, routeKey: config.routeKey, ...clock },
    metadata.collection,
  );
  const reviewSource =
    config.reviewSource ??
    (config.keys
      ? createReviewDiscoverySource(
          { pool: config.pool, access: config.access, tokens: config.keys, ...clock },
          () => ({ actor: { kind: 'anonymous' }, deadline: Date.now() + 30_000 }),
        )
      : undefined);
  const review = reviewSource ? createReviewDiscoveryAdapter(reviewSource) : undefined;
  const space = nativeSpaceDiscoveryAdapter({ pool: config.pool, access: config.access, ...clock });
  const ownerContext = (context: DiscoveryReadContext) => ({ deadline: context.deadline });
  const reviewSlot = review
    ? {
        readiness: 'ready' as const,
        adapter: {
          owner: 'content' as const,
          kind: 'review' as const,
          metadata: metadata.review,
          readCurrent: review.readCurrent,
        },
      }
    : { readiness: 'unavailable' as const };
  const spaceSlot = {
    readiness: 'ready' as const,
    adapter: {
      owner: 'content' as const,
      kind: 'space' as const,
      metadata: metadata.space,
      async readCurrent(
        ids: readonly string[],
        context: DiscoveryReadContext,
      ): Promise<ReadonlyMap<string, DiscoveryOwnerMetadataSummary<'space'>>> {
        if (!Array.isArray(ids) || ids.length > 200) throw new RangeError('Space current read exceeds 200 identities');
        const before = await space.source.dependencies();
        if (before.state !== 'ready')
          throw new DiscoveryProducerCoverageError({
            missingKinds: [],
            unsupportedKinds: ['space'],
            duplicateKinds: [],
          });
        const summaries = new Map<string, SpaceDiscoverySummary>();
        for (let offset = 0; offset < ids.length; offset += 100) {
          const batch = await space.hydrate(ids.slice(offset, offset + 100), ownerContext(context));
          for (const [id, summary] of batch) summaries.set(id, summary);
        }
        const partitions = new Map<number, string[]>();
        for (const id of ids) {
          const route = routeOf(id);
          if (route === null) throw new TypeError('Invalid Space discovery identity');
          const partition = partitionOf(route);
          const group = partitions.get(partition) ?? [];
          group.push(id);
          partitions.set(partition, group);
        }
        const current = new Map<string, DiscoveryOwnerMetadataSummary<'space'>>();
        for (const [partition, group] of partitions) {
          for (let offset = 0; offset < group.length; offset += 100) {
            const batch = group.slice(offset, offset + 100);
            const snapshot = await space.source.read(partition, batch);
            for (const native of snapshot.spaces) {
              const summary = summaries.get(native.id);
              if (
                !summary ||
                summary.address !== native.address ||
                summary.title !== native.title ||
                summary.realmTitle !== native.realmTitle ||
                summary.realmId !== native.realmId ||
                summary.name !== native.name ||
                summary.description !== native.description
              )
                throw new TypeError('Current Space discovery presentation changed');
              current.set(native.id, {
                id: native.id,
                title: summary.title,
                summary: summary.description || null,
                revision: native.revision,
                sourcePosition: snapshot.position.toString(),
                address: summary.address,
                realmId: summary.realmId,
                realmTitle: summary.realmTitle,
              });
            }
          }
        }
        if (!isDeepStrictEqual(before, await space.source.dependencies()))
          throw new DiscoveryProducerCoverageError({
            missingKinds: [],
            unsupportedKinds: ['space'],
            duplicateKinds: [],
          });
        return current;
      },
    },
  };
  const metadataProducers: Readonly<Record<DiscoveryMetadataKind, DiscoveryMetadataProducer>> = Object.freeze({
    collection: createCollectionPopulationProducer(collection),
    review: createReviewPopulationProducer(reviewSource),
    space: createSpacePopulationProducer(space),
  });
  return Object.freeze({
    collection: collection.registration,
    review: reviewSlot,
    space: spaceSlot,
    metadataProducers,
  });
}

/** Default public catalogue/Account candidates, also consumed by the home feed with its current Actor.
 * Source owns whole-population readiness. Neither a local census nor returned summaries replace it.
 */
export function createDefaultDiscoverySearch(config: DefaultDiscoverySearchConfig): DefaultDiscoverySearch {
  const freshness = new Map<number, ReturnType<typeof createFreshness>>();
  const runtime = createDefaultPublicFilterRuntime(config);
  const source = publicFilterSource(config);
  const subjects = createRatedSubjectSource(config.pool, config.routeKey).source;
  const ownerAdapters = createDefaultDiscoveryOwnerAdapters(config);
  let work: ReturnType<typeof createWorkClient> | undefined;
  const pending = new Set<Promise<unknown>>();
  const retained = new Set<RetainedDiscoveryRead>();
  let closed = false;
  let closing: Promise<void> | undefined;
  const open: RetainedDiscoverySearch = (principal, request, context) => {
    if (closed) return Promise.reject(new ProblemError('index_not_ready', { headers: { 'retry-after': '1' } }));
    request = ownDiscoveryRequest(request);
    const languages = request.languages ?? ['en'];
    request = { ...request, languages };
    context = { ...context, languages };
    const deadline = context.deadline;
    const actor =
      context.actor.kind === 'account'
        ? Object.freeze({ ...context.actor, scopes: Object.freeze([...context.actor.scopes]) })
        : Object.freeze({ kind: 'anonymous' as const });
    const execute = async () => {
      let operations: PublicDiscoveryConsumerOperations | undefined;
      let disclosureTarget: import('./account-discovery.ts').DiscoveryTarget | undefined;
      const current = await activeRelease(config.pool);
      if (!current) throw new ProblemError('index_not_ready', { headers: { 'retry-after': '1' } });
      const registry = await nativeDiscoveryRegistry(config.pool, config.routeKey, subjects, {
        release: current.release,
        languages,
        ownerAdapters,
      });
      const bound = () => {
        if (!operations) throw new Error('Discovery capture or retained resume must precede consumer work');
        return operations;
      };
      const consumer: PublicDiscoveryConsumerOperations = {
        capture: (input, nativeContext) => bound().capture(input, nativeContext),
        async captureDiscovery(input, nativeContext) {
          operations = await runtime.openDiscovery(registry, current.digest, nativeContext);
          return operations.captureDiscovery(input, nativeContext);
        },
        async queryDiscovery(queried, nativeContext, refill) {
          operations ??= await runtime.openDiscovery(registry, current.digest, nativeContext, queried);
          return operations.queryDiscovery(queried, nativeContext, refill);
        },
        query: (queried, nativeContext, refill) => bound().query(queried, nativeContext, refill),
        readStatus: (input, nativeContext) => bound().readStatus(input, nativeContext),
        repairStep: (job, nativeContext) => bound().repairStep(job, nativeContext),
        async closeObservation(queried, nativeContext) {
          // A rejected retained generation has not opened a factory in this request.
          if (operations) await operations.closeObservation(queried, nativeContext);
        },
        close: () => runtime.close(),
      };
      installPublicFilterCoveragePage(consumer, (nativeContext) => {
        let page: Promise<PublicFilterCoveragePage> | undefined;
        const open = (queried?: Parameters<typeof runtime.openDiscovery>[3]) =>
          (page ??= (async () => {
            operations ??= await runtime.openDiscovery(registry, current.digest, nativeContext, queried);
            return openPublicFilterCoveragePage(operations, nativeContext);
          })());
        return {
          capture: async (plan, snapshot) => (await open()).capture(plan, snapshot),
          query: async (queried, refill) => (await open(queried)).query(queried, refill),
          queryDiscovery: async (queried, refill) => (await open(queried)).queryDiscovery(queried, refill),
          consume: async (execution, consumed) => (await open()).consume(execution, consumed),
          async finish() {
            if (!page) throw new Error('Native page was not opened');
            await (await page).finish();
            if (disclosureTarget)
              await assertDiscoveryCapabilityBinding(config.pool, disclosureTarget, ownerAdapters.metadataProducers);
          },
          async dispose() {
            if (page) await (await page).dispose();
          },
          failure(error) {
            // The public discovery boundary translates native refusal after
            // this lazy wrapper has disposed its original resource owner.
            throw error;
          },
        };
      });
      const read = await createRetainedDiscoverySearch({
        consumer,
        source,
        keys: config.keys,
        now: () => config.clock().getTime(),
        resolve: async () => ({ ...current, registry }),
        async prepare(job) {
          // Enqueue on the existing durable default-worker path. No executor is launched by a request.
          work ??= createWorkClient(config.pool.options.connectionString ?? '', config.pool);
          await createPublicPreparationStore(config.pool, await work, config.prefix).retain(
            { kind: 'repair', key: JSON.stringify(job), job },
            Date.now() + 24 * 60 * 60 * 1000,
          );
        },
        async asOf(queried) {
          const match = /discovery-g([1-9][0-9]*)$/.exec(queried.consumer.physicalTarget);
          const generation = Number(match?.[1]);
          if (
            !Number.isSafeInteger(generation) ||
            discoveryIndexName(config.prefix, generation) !== queried.consumer.physicalTarget
          )
            throw new Error('Discovery freshness requires the actual queried mixed generation');
          const target = (await discoveryGenerations(config.pool, config.prefix)).find(
            (row) => row.generation === generation,
          );
          if (!target || target.uuid !== queried.consumer.incarnation)
            throw new DiscoveryProducerCoverageError({
              missingKinds: ['space'],
              unsupportedKinds: [],
              duplicateKinds: [],
            });
          disclosureTarget = target;
          await assertDiscoveryCapabilityBinding(config.pool, target, ownerAdapters.metadataProducers);
          let reader = freshness.get(generation);
          if (!reader) reader = createFreshness(config.pool, discoveryConsumer(config.prefix, generation));
          // Keep the live and retained generations coalesced while requests overlap an alias change.
          freshness.delete(generation);
          freshness.set(generation, reader);
          if (freshness.size > 4) {
            const oldest = freshness.keys().next();
            if (!oldest.done) freshness.delete(oldest.value);
          }
          return searchObservation(await reader.current());
        },
      })(principal, request, {
        ...context,
        deadline,
        actor,
        access: config.access,
        descriptions: request.descriptions === true,
      });
      const wrapped: RetainedDiscoveryRead = Object.freeze({
        search: () => read.search(),
        currentPrimaryCandidates: (keys) => read.currentPrimaryCandidates(keys),
        finish: () => read.finish(),
        async close() {
          try {
            await read.close();
          } finally {
            retained.delete(wrapped);
          }
        },
      });
      retained.add(wrapped);
      return wrapped;
    };
    const operation = execute().catch((error: unknown) => {
      if (error instanceof ProblemError) throw error;
      if (error instanceof CollectionDiscoveryReadinessError) throw error;
      throw new ProblemError('index_not_ready', { headers: { 'retry-after': '1' } });
    });
    pending.add(operation);
    void operation.finally(() => pending.delete(operation)).catch(() => {});
    return operation;
  };
  const search: DiscoverySearch = (...args) => {
    const [principal, inputRequest, inputContext] = args;
    const ownedRequest = ownDiscoveryRequest(inputRequest);
    const languages = ownedRequest.languages ?? ['en'];
    const request = { ...ownedRequest, languages };
    const context = { ...inputContext, languages };
    const operation = (async () => {
      const read = await open(principal, request, context);
      return readAdmittedDiscoveryPage(read, async (page) => {
        try {
          const reviews = await prepareSearchReviewContexts({ ...config, tokens: config.keys }, page, context);
          const enriched = await enrichDiscoveryPage(config, principal, page, {
            ...context,
            descriptions: request.descriptions === true,
          });
          const spaces = await observeSearchSpaceEntries({
            page: enriched.page,
            actor: context.actor,
            deadline: context.deadline,
            read: (ids) =>
              readSpaceDiscoveryEntryBatch(config, context.actor, ids, context.deadline, config.spaceEntryActions),
            follow:
              config.spaceEntryFollow ??
              spaceEntryFollowing((actor, targets, deadline) => readFollowDiscovery(config, actor, targets, deadline)),
          });
          const finalPresentation = await readListPresentationFacts(
            {
              pool: config.pool,
              access: config.access,
              actor: context.actor,
              routeKey: config.routeKey,
              deadline: context.deadline,
            },
            enriched.semanticOriginals,
            { languages, workContext: true },
          );
          if (!isDeepStrictEqual(enriched.semanticPresentation, finalPresentation))
            throw new ProblemError('search_restart_required');
          const finalFigures = enriched.figureIds.length
            ? await readDiscoveryFigures(config, enriched.figureIds, context.deadline)
            : enriched.figures;
          if (!isDeepStrictEqual(enriched.figures, finalFigures)) throw new ProblemError('search_restart_required');
          const targets = enriched.page.hits.flatMap((hit) => {
            if (hit.summary.kind !== 'collection') return [];
            const card = hit.summary.value.card;
            return [
              {
                targetId: hit.key.id,
                targetType: 'collection' as const,
                source: JSON.stringify([
                  card.id,
                  card.sourceGeneration,
                  card.revision,
                  card.membershipKind,
                  card.membershipKind === 'curated' ? card.orderEpoch : card.outputGeneration,
                ]),
              },
            ];
          });
          const collectionFollows = await readFollowDiscovery(config, context.actor, targets, context.deadline);
          if (!(await spaces.finish())) throw new ProblemError('search_restart_required');
          const reviewedPage = await reviews.finish({ ...spaces.page, collectionFollows });
          const viewerCurrent =
            !enriched.viewer ||
            (await viewerFactsCurrent(
              { pool: config.pool, access: config.access },
              enriched.viewer.actor,
              enriched.viewer.prepared,
              context.deadline,
            ));
          return { page: reviewedPage, viewerCurrent };
        } catch (error) {
          if (error instanceof ProblemError || error instanceof CollectionDiscoveryReadinessError) throw error;
          throw new ProblemError('index_not_ready', { headers: { 'retry-after': '1' } });
        }
      });
    })();
    pending.add(operation);
    void operation.finally(() => pending.delete(operation)).catch(() => {});
    return operation;
  };
  return {
    search,
    open,
    close() {
      closed = true;
      return (closing ??= (async () => {
        await Promise.allSettled([...pending]);
        try {
          await Promise.allSettled([...retained].map((read) => read.close()));
          await runtime.close();
        } finally {
          if (work) await (await work).close();
        }
      })());
    },
  };
}
