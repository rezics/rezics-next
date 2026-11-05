import type { Release } from '@rezics/definitions';
import type { DiscoveryFilterDocument } from '@rezics/filter';
import type { AvatarSummary, ReviewDiscoverySource } from '../content/index.ts';
import type { FollowDiscovery, PublicCollectionDiscoverySummary as CollectionDiscoveryCard, ViewerFactsPage } from '../library/index.ts';
import type { PublicFigureView } from '../rating/index.ts';
import type { SummaryReaderDependencies, SubjectSummary } from '../semantic/index.ts';
import type { SpaceDiscoveryDependencyReadiness, SpaceEntryPage, SpaceEntryPresentation } from '../community/index.ts';
import type { Fact } from './hits.ts';
import type { MatchEvidence, MatchEvidenceQuery } from './match-evidence.ts';
import type { SearchRequest } from './service.ts';
import type { SearchFreshness } from './search-context.ts';
import type { PublicFilterConsumerCaptureInput } from './public-filter-consumer-contract.ts';
import type { SubjectSource } from './source.ts';

export type DiscoveryKey =
  | { owner: 'semantic'; kind: string; route: number; id: string }
  | { owner: 'accounts'; kind: 'account'; route: number; id: string };
export type DiscoveryOwnerKey =
  | { owner: 'commerce'; kind: 'collection'; route: number; id: string }
  | { owner: 'content'; kind: 'review' | 'space'; route: number; id: string };
export type DiscoveryUnionKey = DiscoveryKey | DiscoveryOwnerKey;
export type DiscoveryOwnerKind = 'collection' | 'review' | 'space';
/** Public owner labels are stable DTO values; execution keys retain the native producer owner. */
export type DiscoveryPublicOwnerKey =
  | { owner: 'library'; kind: 'collection'; route: number; id: string }
  | { owner: 'content'; kind: 'review'; route: number; id: string }
  | { owner: 'community'; kind: 'space'; route: number; id: string };

export type IndexedAccount = {
  id: string;
  accountKind: 'actor' | 'organization';
  handle: string | null;
  displayName: string | null;
  revision: bigint;
};
export type AccountSnapshot = { partition: number; position: bigint; accounts: IndexedAccount[] };
export type AccountPageKey = { route: number; id: string };
export type AccountFrontier = AccountPageKey;
export type AccountPage = AccountSnapshot & { next: AccountPageKey | null };

/** Accounts' native partition source. Its count is generation evidence, never query or kind-count evidence. */
export interface AccountDiscoverySource {
  read(partition: number, ids: readonly string[]): Promise<AccountSnapshot>;
  count(partition: number): Promise<{ partition: number; position: bigint; count: number }>;
  page(
    partition: number,
    after: AccountPageKey | null,
    limit: number,
  ): Promise<AccountSnapshot & { next: AccountPageKey | null }>;
}

export type AccountDiscoverySummary = {
  context?: import('./account-context.ts').AccountContext;
  id: string;
  accountKind: 'actor' | 'organization';
  handle: string | null;
  displayName: string | null;
  automated: boolean;
  operatorId: string | null;
  avatar: AvatarSummary | null;
  verifiedAgent: { id: string; label: string; type: string } | null;
};
export type DiscoverySummary =
  | { kind: 'subject'; value: SubjectSummary }
  | { kind: 'account'; value: AccountDiscoverySummary };
export type DiscoveryContextSubject = {
  id: string;
  labels: Record<string, string>;
  aliases?: Record<string, string[]>;
};
export type DiscoveryContextList = { items: DiscoveryContextSubject[]; next: boolean };
export type CharacterPersonDiscoveryContexts = {
  credits: DiscoveryContextList;
  appearances: DiscoveryContextList;
};
export type DiscoveryHit = {
  workContext?: import('./work-context.ts').WorkContext;
  key: DiscoveryKey;
  summary: DiscoverySummary;
  labels?: Record<string, string>;
  aliases?: Record<string, string[]>;
  descriptions?: Record<string, string>;
  facts?: Record<string, Fact[]>;
  figure?: PublicFigureView;
  listPresentation?: { imageAspect: 'portrait' | 'landscape' | 'square'; keyFacts: string[] };
  contexts?: CharacterPersonDiscoveryContexts;
  matchEvidence?: MatchEvidence;
};
export type PublicCollectionDiscoverySummary = Readonly<{
  id: string;
  title: string;
  description: string | null;
  card: CollectionDiscoveryCard;
}>;
export type PublicReviewDiscoverySummary = Readonly<{
  id: string;
  kind: 'review';
  title: string | null;
  author?: Readonly<{ displayName: string | null; handle: string | null }>;
  excerpt?: string;
  subject?: Readonly<{ id: string; title: string | null }> | null;
  source?: import('./review-context.ts').ReviewContextSource;
  searchContext?: import('./review-context.ts').SearchReviewContext;
}>;
export type PublicSpaceDiscoverySummary = Readonly<{
  id: string;
  title: string;
  address: string;
  summary?: string;
  realm?: Readonly<{ id: string; title: string | null }> | null;
  presentation?: SpaceEntryPresentation;
}>;
export type DiscoveryOwnerSummary =
  | { kind: 'collection'; value: PublicCollectionDiscoverySummary }
  | { kind: 'review'; value: PublicReviewDiscoverySummary }
  | { kind: 'space'; value: PublicSpaceDiscoverySummary };
type DiscoveryOwnerHitOf<K extends DiscoveryOwnerKind> = {
  key: Extract<DiscoveryPublicOwnerKey, { kind: K }>;
  summary: Extract<DiscoveryOwnerSummary, { kind: K }>;
  matchEvidence?: MatchEvidence;
};
export type DiscoveryOwnerHit =
  | DiscoveryOwnerHitOf<'collection'>
  | DiscoveryOwnerHitOf<'review'>
  | DiscoveryOwnerHitOf<'space'>;
export type DiscoveryUnionSummary = DiscoverySummary | DiscoveryOwnerSummary;
type DiscoveryHitOf<K extends DiscoverySummary['kind']> = Omit<DiscoveryHit, 'summary'> & {
  summary: Extract<DiscoverySummary, { kind: K }>;
};
export type DiscoveryUnionHit = DiscoveryHitOf<'subject'> | DiscoveryHitOf<'account'> | DiscoveryOwnerHit;

export type KindCountEvidence =
  | { kind: string; value: number; exact: true }
  | { kind: string; value: number; exact: false }
  | { kind: string; unavailable: true };
export type DiscoveryApplicability = 'all' | 'partial' | 'none' | 'unknown';
export type DiscoveryFilterApplicability = Readonly<{
  type: DiscoveryApplicability;
  statement: DiscoveryApplicability;
}>;
export type DiscoveryOmittedKind = Readonly<{
  id: string;
  labels: Record<string, string>;
  state: 'preparing' | 'unavailable';
}>;
export type DiscoveryKindMetadata = {
  id: string;
  labels: Record<string, string>;
  icon: string;
  count?: KindCountEvidence;
};
export type DiscoveryPage = {
  accountFollows?: FollowDiscovery;
  collectionFollows?: FollowDiscovery;
  spaceEntries?: SpaceEntryPage;
  hits: DiscoveryUnionHit[];
  kinds: { values: DiscoveryKindMetadata[]; next: string | null; omitted?: DiscoveryOmittedKind[] };
  applicability?: DiscoveryFilterApplicability;
  next: string | null;
  as_of: string;
  freshness?: SearchFreshness;
  /** Current private envelope; it is never cached publicly. */
  viewerFacts?:
    | Exclude<ViewerFactsPage, { state: 'current' }>
    | (Omit<Extract<ViewerFactsPage, { state: 'current' }>, 'rows'> & {
        rows: readonly (Extract<ViewerFactsPage, { state: 'current' }>['rows'][number] & {
          resolvedSubjectId?: string;
        })[];
      })
    | null;
};
export type DiscoveryRequest = SearchRequest & {
  representation: 'discovery-v1';
  kindCursor?: string;
  spaceId?: string;
};
export type MixedDiscoveryRequest = DiscoveryRequest & {
  kindPage?: { limit: number; cursor?: string };
  kindCountLeaf?: number;
};
export type DiscoveryReadContext = Pick<SummaryReaderDependencies, 'access' | 'actor' | 'deadline'> & {
  languages?: readonly string[];
  descriptions?: boolean;
  spoilerThreshold?: 0 | 1 | 2;
  observeRelationRelease?: () => Promise<{
    digest: string;
    head: number;
    release: import('@rezics/filter').FilterRelease;
    definitions?: Release;
  } | null>;
  matchEvidencePlan?: MatchEvidenceQuery;
};
/** Closed mixed admission on the same native consumer, never a Subject AST cast. */
export type DiscoveryConsumerCaptureInput = Omit<PublicFilterConsumerCaptureInput, 'filterDocument'> &
  Readonly<{
    representation: 'discovery-v1';
    filterDocument: DiscoveryFilterDocument | undefined;
    comparator: 'mixed-public-v1';
  }>;

export type DiscoveryOwnerMetadataSummary<K extends DiscoveryOwnerKind = DiscoveryOwnerKind> = K extends 'collection'
  ? Readonly<{
      id: string;
      title: string;
      summary: string | null;
      revision: string;
      sourcePosition: string;
      card: CollectionDiscoveryCard;
    }>
  : K extends 'review'
    ? Readonly<{
        id: string;
        title: string | null;
        summary: string | null;
        sourceVersion: string;
        sourcePosition: string;
        authorId: string;
        subjectId: string;
        source?: import('./review-context.ts').ReviewContextSource;
      }>
    : Readonly<{
        id: string;
        title: string;
        summary: string | null;
        revision: string;
        sourcePosition: string;
        address: string | null;
        realmId: string | null;
        realmTitle: string | null;
      }>;
export type DiscoveryOwnerAdapter<K extends DiscoveryOwnerKind, O extends 'commerce' | 'content'> = Readonly<{
  owner: O;
  kind: K;
  metadata: Readonly<Omit<DiscoveryKindMetadata, 'count'>>;
  readCurrent: (
    ids: readonly string[],
    context: DiscoveryReadContext,
  ) => Promise<ReadonlyMap<string, DiscoveryOwnerMetadataSummary<K>>>;
}>;
export type DiscoveryAdapterSlot<T> =
  | Readonly<{ readiness: 'unavailable' }>
  | Readonly<{ readiness: 'ready'; adapter: T }>;
export type DiscoveryOwnerAdapterSlots = Readonly<{
  collection: DiscoveryAdapterSlot<DiscoveryOwnerAdapter<'collection', 'commerce'>>;
  review: DiscoveryAdapterSlot<DiscoveryOwnerAdapter<'review', 'content'>>;
  space: DiscoveryAdapterSlot<DiscoveryOwnerAdapter<'space', 'content'>>;
}>;
export type DiscoveryOwnerRegistration =
  | (DiscoveryOwnerAdapter<'collection', 'commerce'> & { domains: readonly ['text', 'kind'] })
  | (DiscoveryOwnerAdapter<'review', 'content'> & { domains: readonly ['text', 'kind'] })
  | (DiscoveryOwnerAdapter<'space', 'content'> & { domains: readonly ['text', 'kind'] });

export type DiscoveryMetadataKind = DiscoveryOwnerKind;
export type DiscoveryMetadataRecord = Readonly<{
  key: DiscoveryOwnerKey;
  revision: bigint;
  sourceVersion: string | null;
  names: readonly string[];
  descriptions: readonly string[];
  nameSort: string | null;
}>;
export type DiscoveryMetadataProducer = Readonly<{
  kind: DiscoveryMetadataKind;
  owner: 'commerce' | 'content';
  readiness(): Promise<'ready' | 'preparing' | 'unavailable' | SpaceDiscoveryDependencyReadiness>;
  page(
    partition: number,
    after: Readonly<{ route: number; id: string }> | null,
    continuation: string | null,
    limit: number,
  ): Promise<
    Readonly<{
      position: bigint;
      epoch?: number;
      next: Readonly<{ route: number; id: string }> | null;
      continuation: string | null;
      keys: readonly DiscoveryOwnerKey[];
      records: readonly DiscoveryMetadataRecord[];
    }>
  >;
  read(
    partition: number,
    ids: readonly string[],
  ): Promise<
    Readonly<{
      position: bigint;
      epoch?: number;
      keys: readonly DiscoveryOwnerKey[];
      records: readonly DiscoveryMetadataRecord[];
    }>
  >;
  position(partition: number): Promise<bigint>;
}>;
export type DiscoveryMetadataProducers = Readonly<Partial<Record<DiscoveryMetadataKind, DiscoveryMetadataProducer>>>;

/** One composed set is consumed by the live query registry and the default population worker. */
export type DiscoveryProducerEntry = Readonly<{
  subjects: SubjectSource;
  accounts: AccountDiscoverySource;
  reviewSource?: ReviewDiscoverySource;
  ownerAdapters: DiscoveryOwnerAdapterSlots;
  metadataProducers: DiscoveryMetadataProducers;
}>;

/** Public operation used by Content Home; the service owns admission and current disclosure. */
export type DiscoverySearch = (
  principal: 'anonymous' | `account:${string}`,
  request: MixedDiscoveryRequest,
  context: DiscoveryReadContext,
) => Promise<DiscoveryPage>;
