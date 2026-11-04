import type { SearchPlan } from './query.ts';
import type { PublicFilterConsumerQuery } from './public-filter-consumer-contract.ts';
export type { DiscoveryFilterDocument } from '@rezics/filter';
import type { Release } from '@rezics/definitions';
import type { SubjectSummary } from '../semantic/summaries.ts';
import type { EngineMatchEvidence } from './match-evidence.ts';
import type { SubjectDocument } from './document.ts';
import type { IndexedSubject, SubjectSource, SubjectSnapshot } from './source.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import type {
  AccountDiscoverySource,
  AccountSnapshot,
  DiscoveryKey,
  DiscoveryKindMetadata,
  DiscoveryOwnerAdapterSlots,
  DiscoveryOwnerKind,
  DiscoveryOwnerKey,
  DiscoveryOwnerMetadataSummary,
  DiscoveryOwnerRegistration,
  DiscoveryReadContext,
  DiscoveryUnionKey,
} from './discovery-api.ts';
export type {
  AccountDiscoverySource,
  AccountDiscoverySummary,
  AccountFrontier,
  AccountPage,
  AccountPageKey,
  AccountSnapshot,
  CharacterPersonDiscoveryContexts,
  DiscoveryAdapterSlot,
  DiscoveryConsumerCaptureInput,
  DiscoveryContextList,
  DiscoveryContextSubject,
  DiscoveryHit,
  DiscoveryKey,
  DiscoveryKindMetadata,
  DiscoveryOwnerAdapter,
  DiscoveryOwnerAdapterSlots,
  DiscoveryOwnerHit,
  DiscoveryOwnerKey,
  DiscoveryOwnerKind,
  DiscoveryOwnerMetadataSummary,
  DiscoveryOwnerRegistration,
  DiscoveryOwnerSummary,
  DiscoveryPage,
  DiscoveryPublicOwnerKey,
  DiscoveryReadContext,
  DiscoveryRequest,
  DiscoverySummary,
  DiscoveryUnionHit,
  DiscoveryUnionKey,
  DiscoveryUnionSummary,
  IndexedAccount,
  KindCountEvidence,
  PublicCollectionDiscoverySummary,
  PublicReviewDiscoverySummary,
  PublicSpaceDiscoverySummary,
} from './discovery-api.ts';

/** This format is opt-in; legacy Subject IDs and generation receipts retain their meaning. */
export const DISCOVERY_DOCUMENT_FORMAT = 1;
/** Successor requires a complete native rebuild; format 1 retains its original reader. */
export const MIXED_DISCOVERY_DOCUMENT_FORMAT = 2;
/** Calendar facts are written only to a physical generation using the matching successor mapping. */
export const MIXED_CALENDAR_DISCOVERY_DOCUMENT_FORMAT = 3;
export const ACCOUNT_DISCOVERY_BATCH_SIZE = 100;
export const MAX_ACCOUNT_DISCOVERY_BATCH = ACCOUNT_DISCOVERY_BATCH_SIZE;

export function discoveryPartition(id: string): number {
  const route = routeOf(id);
  if (route === null) throw new TypeError('Discovery id must be a routable UUID');
  return partitionOf(route);
}

/** Compatibility for the earlier projection adapter; native mixed writers use discoveryDocumentId. */
export function discoveryIdentity(owner: DiscoveryKey['owner'], id: string): string {
  discoveryPartition(id);
  return `${owner === 'accounts' ? 'account' : 'subject'}:${id}`;
}
export type DiscoveryDocument =
  | { owner: 'semantic'; kind: string; value: IndexedSubject }
  | { owner: 'accounts'; kind: 'account'; value: IndexedAccount };
export type DiscoveryDomain = 'text' | 'kind' | 'type' | 'statement' | 'owner' | 'collection' | 'zone' | 'realm';
export type DiscoveryTruth = boolean | 'not_applicable' | 'not_proven';
export type DiscoveryCondition =
  | { and: readonly DiscoveryCondition[] }
  | { or: readonly DiscoveryCondition[] }
  | { not: DiscoveryCondition }
  | { domain: DiscoveryDomain; value: unknown };

type RegistrationBase = {
  readonly metadata: Readonly<Omit<DiscoveryKindMetadata, 'count'>>;
  readonly domains: readonly DiscoveryDomain[];
};
export type DiscoveryRegistration = RegistrationBase &
  (
    | {
        readonly owner: 'semantic';
        readonly kind: string;
        readonly summary: 'subject';
        readonly source: SubjectSource;
        readonly hydrate: (
          ids: readonly string[],
          context: DiscoveryReadContext,
        ) => Promise<ReadonlyMap<string, SubjectSummary>>;
      }
    | {
        readonly owner: 'accounts';
        readonly kind: 'account';
        readonly summary: 'account';
        readonly source: AccountDiscoverySource;
        readonly hydrate: (
          ids: readonly string[],
          context: DiscoveryReadContext,
        ) => Promise<ReadonlyMap<string, AccountDiscoverySummary>>;
      }
  );
export type DiscoveryRegistryOptions = {
  release: Release;
  semantic: {
    source: SubjectSource;
    hydrate: Extract<DiscoveryRegistration, { owner: 'semantic' }>['hydrate'];
    /** Presentation metadata keyed by the actual released type ID. */
    icons: Readonly<Record<string, string>>;
  };
  accounts: {
    source: AccountDiscoverySource;
    hydrate: Extract<DiscoveryRegistration, { owner: 'accounts' }>['hydrate'];
    labels: Record<string, string>;
    icon: string;
  };
  /** Missing ports default to typed-unavailable slots and do not register a searchable kind. */
  ownerAdapters?: DiscoveryOwnerAdapterSlots;
};
export interface DiscoveryRegistry {
  readonly entries: readonly DiscoveryRegistration[];
  get(kind: string): DiscoveryRegistration;
  key(value: DiscoveryKey): DiscoveryKey;
}
export interface DiscoveryOwnerRegistry {
  readonly ownerAdapters: DiscoveryOwnerAdapterSlots;
  getOwnerAdapter(kind: DiscoveryOwnerKind): DiscoveryOwnerRegistration;
  domains(kind: string): readonly DiscoveryDomain[];
  ownerKey(value: DiscoveryOwnerKey): DiscoveryOwnerKey;
}

export type DiscoverySnapshot =
  | { owner: 'semantic'; snapshot: SubjectSnapshot }
  | { owner: 'accounts'; snapshot: AccountSnapshot };
type DocumentIdentity = {
  document_format:
    | typeof DISCOVERY_DOCUMENT_FORMAT
    | typeof MIXED_DISCOVERY_DOCUMENT_FORMAT
    | typeof MIXED_CALENDAR_DISCOVERY_DOCUMENT_FORMAT;
  identity?: string;
  id: string;
  kind: string;
  route: number;
  partition: number;
  /** Exact decimal native position, never a floating point or timestamp surrogate. */
  source_position: string;
};
export type IndexedDiscoveryDocument =
  | (DocumentIdentity & SubjectDocument & { owner: 'semantic' })
  | (DocumentIdentity & {
      owner: 'accounts';
      kind: 'account';
      account_kind: IndexedAccount['accountKind'];
      handle: string | null;
      display_name: string | null;
      revision: string;
      names?: string[];
      descriptions?: string[];
      name_sort?: string | null;
    });
export type DiscoveryIndexAction =
  | { op: 'index'; id: string; version: bigint; document: IndexedDiscoveryDocument }
  | { op: 'delete'; id: string; version: bigint };

/** Inert mapping contract, shared by every configured kind in the discovery family. */
export type DiscoveryIndexDefinition = {
  settings: Record<string, unknown>;
  mappings: {
    _meta: {
      discovery_document_format:
        | typeof DISCOVERY_DOCUMENT_FORMAT
        | typeof MIXED_DISCOVERY_DOCUMENT_FORMAT
        | typeof MIXED_CALENDAR_DISCOVERY_DOCUMENT_FORMAT;
      identity?: string;
      name_sort_format: number;
      document_identity: string;
    };
    dynamic: 'strict';
    properties: Record<string, Record<string, unknown>>;
  };
};

/** Closed mixed admission on the same native consumer, never a Subject AST cast. */
export type DiscoveryEngineHit = Readonly<{
  key: DiscoveryUnionKey;
  index: string;
  sourcePosition: string;
  revision: string;
  sourceVersion?: string | null;
  matched: readonly string[];
  engineEvidence?: EngineMatchEvidence;
  sort: readonly (string | number | null)[];
}>;
export type DiscoveryEngineResult = Readonly<{ generation?: number; hits: readonly DiscoveryEngineHit[] }>;
export type DiscoveryConsumerQuery =
  | (Omit<Extract<PublicFilterConsumerQuery, { status: 'queried' }>, 'result'> &
      Readonly<{ result: DiscoveryEngineResult }>)
  | Exclude<PublicFilterConsumerQuery, { status: 'queried' }>;
export type DiscoverySort = Extract<SearchPlan['sort'], 'id' | 'name' | 'relevance'>;
