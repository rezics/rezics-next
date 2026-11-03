import type { DiscoveryFilterDocument } from '@rezics/filter';
import type { SearchPlan } from './query.ts';
import type { PublicFilterConsumerCaptureInput, PublicFilterConsumerQuery } from './public-filter-consumer-contract.ts';
export type { DiscoveryFilterDocument } from '@rezics/filter';
export { compileDiscoveryConsumerCapture } from './discovery-filter.ts';
import type { Release } from '@rezics/definitions';
import type { AvatarSummary } from '../content/avatar.ts';
import type { SubjectSummary, SummaryReaderDependencies } from '../semantic/summaries.ts';
import type { KeyRing } from '../tokens/seal.ts';
import type { SubjectDocument } from './document.ts';
import type { SearchRequest } from './service.ts';
import type { IndexedSubject, SubjectSource, SubjectSnapshot } from './source.ts';
/** This format is opt-in; legacy Subject IDs and generation receipts retain their meaning. */
export declare const DISCOVERY_DOCUMENT_FORMAT = 1;
/** Successor requires a complete native rebuild; format 1 retains its original reader. */
export declare const MIXED_DISCOVERY_DOCUMENT_FORMAT = 2;
export declare const MIXED_CALENDAR_DISCOVERY_DOCUMENT_FORMAT = 3;
export declare const ACCOUNT_DISCOVERY_BATCH_SIZE = 100;
export declare const MAX_ACCOUNT_DISCOVERY_BATCH = 100;
export type DiscoveryKey = {
    owner: 'semantic';
    kind: string;
    route: number;
    id: string;
} | {
    owner: 'accounts';
    kind: 'account';
    route: number;
    id: string;
};
export type DiscoveryOwnerKey = {
    owner: 'commerce';
    kind: 'collection';
    route: number;
    id: string;
} | {
    owner: 'content';
    kind: 'review' | 'space';
    route: number;
    id: string;
};
export type DiscoveryUnionKey = DiscoveryKey | DiscoveryOwnerKey;
export type DiscoveryOwnerKind = 'collection' | 'review' | 'space';
/** Already eligible native projection. Only the producer can establish eligibility and exact claims at T. */
export type IndexedAccount = {
    id: string;
    accountKind: 'actor' | 'organization';
    /** Null when the current exact active claim is absent or invalid; displayName remains eligible. */
    handle: string | null;
    displayName: string | null;
    revision: bigint;
};
export type AccountSnapshot = {
    partition: number;
    position: bigint;
    accounts: IndexedAccount[];
};
export type AccountPageKey = {
    route: number;
    id: string;
};
export type AccountFrontier = AccountPageKey;
export type AccountPage = AccountSnapshot & {
    next: AccountPageKey | null;
};
export declare function discoveryPartition(id: string): number;
/** Compatibility for the earlier projection adapter; native mixed writers use discoveryDocumentId. */
export declare function discoveryIdentity(owner: DiscoveryKey['owner'], id: string): string;
export interface AccountDiscoverySource {
    /** Deduplicate at most 100 full keys in one partition; omit unknown/ineligible rows. */
    read(partition: number, ids: readonly string[]): Promise<AccountSnapshot>;
    /** Native generation census only, never query/kind count evidence. */
    count(partition: number): Promise<{
        partition: number;
        position: bigint;
        count: number;
    }>;
    /** Native partition keyset, limit 1..100; next proves remaining eligible input. */
    page(partition: number, after: AccountPageKey | null, limit: number): Promise<AccountSnapshot & {
        next: AccountPageKey | null;
    }>;
}
export type DiscoveryDocument = {
    owner: 'semantic';
    kind: string;
    value: IndexedSubject;
} | {
    owner: 'accounts';
    kind: 'account';
    value: IndexedAccount;
};
export type AccountDiscoverySummary = {
    id: string;
    accountKind: 'actor' | 'organization';
    handle: string | null;
    displayName: string | null;
    automated: boolean;
    operatorId: string | null;
    avatar: AvatarSummary | null;
    verifiedAgent: {
        id: string;
        label: string;
        type: string;
    } | null;
};
export type DiscoverySummary = {
    kind: 'subject';
    value: SubjectSummary;
} | {
    kind: 'account';
    value: AccountDiscoverySummary;
};
export type DiscoveryHit = {
    key: DiscoveryKey;
    summary: DiscoverySummary;
};
export type DiscoveryOwnerSummary = {
    kind: 'collection';
    value: DiscoveryOwnerMetadataSummary;
} | {
    kind: 'review';
    value: DiscoveryOwnerMetadataSummary;
} | {
    kind: 'space';
    value: DiscoveryOwnerMetadataSummary;
};
export type DiscoveryOwnerHit = {
    key: DiscoveryOwnerKey;
    summary: DiscoveryOwnerSummary;
};
export type DiscoveryUnionSummary = DiscoverySummary | DiscoveryOwnerSummary;
export type DiscoveryUnionHit = DiscoveryHit | DiscoveryOwnerHit;
export type KindCountEvidence = {
    kind: string;
    value: number;
    exact: true;
} | {
    kind: string;
    value: number;
    exact: false;
} | {
    kind: string;
    unavailable: true;
};
export type DiscoveryKindMetadata = {
    id: string;
    labels: Record<string, string>;
    icon: string;
    count?: KindCountEvidence;
};
export type DiscoveryPage = {
    hits: DiscoveryHit[];
    kinds: {
        values: DiscoveryKindMetadata[];
        next: string | null;
    };
    next: string | null;
    as_of: string;
};
/** Opt-in wire; omitted representation retains the Subject response. */
export type DiscoveryRequest = SearchRequest & {
    representation: 'discovery-v1';
    kindCursor?: string;
    /** Exact native Home selection; callers must also supply its opened population. */
    spaceId?: string;
};
/** Reuse native reader authorization/deadline and token custody, never a caller-supplied permission flag. */
export type DiscoveryReadContext = Pick<SummaryReaderDependencies, 'access' | 'actor' | 'deadline'>;
export type DiscoveryCursorKeys = KeyRing;
export type DiscoveryDomain = 'text' | 'kind' | 'type' | 'statement' | 'owner' | 'collection' | 'zone' | 'realm';
export type DiscoveryTruth = boolean | 'not_applicable' | 'not_proven';
/** The closed public metadata envelope returned by owner-native current reads. */
export type DiscoveryOwnerMetadataSummary = Readonly<{
    id: string;
    title: string;
    summary: string | null;
}>;
export type DiscoveryOwnerAdapter<K extends DiscoveryOwnerKind, O extends 'commerce' | 'content'> = Readonly<{
    owner: O;
    kind: K;
    metadata: Readonly<Omit<DiscoveryKindMetadata, 'count'>>;
    /** The owner validates current eligibility and returns only the public metadata summary at this read. */
    readCurrent: (ids: readonly string[], context: DiscoveryReadContext) => Promise<ReadonlyMap<string, DiscoveryOwnerMetadataSummary>>;
}>;
export type DiscoveryAdapterSlot<T> = Readonly<{
    readiness: 'unavailable';
}> | Readonly<{
    readiness: 'ready';
    adapter: T;
}>;
export type DiscoveryOwnerAdapterSlots = Readonly<{
    collection: DiscoveryAdapterSlot<DiscoveryOwnerAdapter<'collection', 'commerce'>>;
    review: DiscoveryAdapterSlot<DiscoveryOwnerAdapter<'review', 'content'>>;
    space: DiscoveryAdapterSlot<DiscoveryOwnerAdapter<'space', 'content'>>;
}>;
export type DiscoveryOwnerRegistration = (DiscoveryOwnerAdapter<'collection', 'commerce'> & {
    domains: readonly ['text', 'kind'];
}) | (DiscoveryOwnerAdapter<'review', 'content'> & {
    domains: readonly ['text', 'kind'];
}) | (DiscoveryOwnerAdapter<'space', 'content'> & {
    domains: readonly ['text', 'kind'];
});
export type DiscoveryCondition = {
    and: readonly DiscoveryCondition[];
} | {
    or: readonly DiscoveryCondition[];
} | {
    not: DiscoveryCondition;
} | {
    domain: DiscoveryDomain;
    value: unknown;
};
type RegistrationBase = {
    readonly metadata: Readonly<Omit<DiscoveryKindMetadata, 'count'>>;
    readonly domains: readonly DiscoveryDomain[];
};
export type DiscoveryRegistration = RegistrationBase & ({
    readonly owner: 'semantic';
    readonly kind: string;
    readonly summary: 'subject';
    readonly source: SubjectSource;
    readonly hydrate: (ids: readonly string[], context: DiscoveryReadContext) => Promise<ReadonlyMap<string, SubjectSummary>>;
} | {
    readonly owner: 'accounts';
    readonly kind: 'account';
    readonly summary: 'account';
    readonly source: AccountDiscoverySource;
    readonly hydrate: (ids: readonly string[], context: DiscoveryReadContext) => Promise<ReadonlyMap<string, AccountDiscoverySummary>>;
});
export type DiscoveryRegistryOptions = {
    release: Release;
    semantic: {
        source: SubjectSource;
        hydrate: Extract<DiscoveryRegistration, {
            owner: 'semantic';
        }>['hydrate'];
        /** Presentation metadata keyed by the actual released type ID. */
        icons: Readonly<Record<string, string>>;
    };
    accounts: {
        source: AccountDiscoverySource;
        hydrate: Extract<DiscoveryRegistration, {
            owner: 'accounts';
        }>['hydrate'];
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
export type DiscoverySnapshot = {
    owner: 'semantic';
    snapshot: SubjectSnapshot;
} | {
    owner: 'accounts';
    snapshot: AccountSnapshot;
};
type DocumentIdentity = {
    document_format: typeof DISCOVERY_DOCUMENT_FORMAT | typeof MIXED_DISCOVERY_DOCUMENT_FORMAT | typeof MIXED_CALENDAR_DISCOVERY_DOCUMENT_FORMAT;
    identity?: string;
    id: string;
    kind: string;
    route: number;
    partition: number;
    /** Exact decimal native position, never a floating point or timestamp surrogate. */
    source_position: string;
};
export type IndexedDiscoveryDocument = (DocumentIdentity & SubjectDocument & {
    owner: 'semantic';
}) | (DocumentIdentity & {
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
export type DiscoveryIndexAction = {
    op: 'index';
    id: string;
    version: bigint;
    document: IndexedDiscoveryDocument;
} | {
    op: 'delete';
    id: string;
    version: bigint;
};
/** Inert mapping contract, shared by every configured kind in the discovery family. */
export type DiscoveryIndexDefinition = {
    settings: Record<string, unknown>;
    mappings: {
        _meta: {
            discovery_document_format: typeof DISCOVERY_DOCUMENT_FORMAT | typeof MIXED_DISCOVERY_DOCUMENT_FORMAT | typeof MIXED_CALENDAR_DISCOVERY_DOCUMENT_FORMAT;
            identity?: string;
            name_sort_format: number;
            document_identity: string;
        };
        dynamic: 'strict';
        properties: Record<string, Record<string, unknown>>;
    };
};
/** Closed mixed admission on the same native consumer, never a Subject AST cast. */
export type DiscoveryConsumerCaptureInput = Omit<PublicFilterConsumerCaptureInput, 'filterDocument'> & Readonly<{
    representation: 'discovery-v1';
    filterDocument: DiscoveryFilterDocument | undefined;
    comparator: 'mixed-public-v1';
}>;
export type DiscoveryEngineHit = Readonly<{
    key: DiscoveryKey;
    index: string;
    sourcePosition: string;
    revision: string;
    matched: readonly string[];
    sort: readonly (string | number | null)[];
}>;
export type DiscoveryEngineResult = Readonly<{
    generation?: number;
    hits: readonly DiscoveryEngineHit[];
}>;
export type DiscoveryConsumerQuery = (Omit<Extract<PublicFilterConsumerQuery, {
    status: 'queried';
}>, 'result'> & Readonly<{
    result: DiscoveryEngineResult;
}>) | Exclude<PublicFilterConsumerQuery, {
    status: 'queried';
}>;
export type DiscoverySort = Extract<SearchPlan['sort'], 'id' | 'name' | 'relevance'>;
