import type { AccessWorkAccounting } from '../access/work.ts';
import { type BuiltinCollectionView } from './builtin-runtime.ts';
import { type AuthoritativeTime, type CommandAttempt } from '../command/command.ts';
import type { ContributionAttribution } from '../access/public-identity.ts';
import type { Actor } from '../request/access.ts';
import type { KeyRing } from '../tokens/seal.ts';
import { type CollectionPresentation } from './collection-presentation.ts';
import { type CollectionMetadataHistoryDetail, type CollectionMetadataHistoryPage } from './collection-metadata-history.ts';
import { type CollectionMemberQuery } from './owner-filter.ts';
import type { SearchService } from '../search/service-scope.ts';
import { type CollectionPreview } from './collection-preview.ts';
import { type PreviewPreparationDependencies } from './collection-preview-work.ts';
import type { ViewerPersonalActionsReader } from './viewer-personal-actions.ts';
type CuratorPageOptions = {
    curatorAccountId: string | null;
    cursor?: string | null;
    limit?: number;
    ownerManagement?: boolean;
};
export type CollectionView = CollectionPresentation & Partial<CollectionPreview> & {
    membershipKind?: 'curated';
    orderEpoch?: number;
    id: string;
    curatorAccountId: string | null;
    title: string;
    description: string | null;
    visibility: 'private' | 'unlisted' | 'public';
    revision: number;
    /** Present for the curator and derived from the same native update authority as the writer. */
    allowedVisibilityActions?: ('private' | 'unlisted' | 'public')[];
    memberCount: number;
    createdAt: string;
    updatedAt: string;
    attribution?: ContributionAttribution;
    generation?: string;
    subjectIds?: string[];
};
export type CuratedCollectionView = CollectionView & {
    membershipKind: 'curated';
    orderEpoch: number;
};
export type SavedDynamicCollectionView = Omit<CollectionView, 'membershipKind' | 'memberCount' | 'orderEpoch' | 'createdAt' | 'updatedAt'> & {
    membershipKind: 'dynamic';
};
export type CollectionResourceView = CollectionView | SavedDynamicCollectionView | (BuiltinCollectionView & {
    allowedVisibilityActions?: ('private' | 'unlisted' | 'public')[];
});
/** Check the required wire fields without expanding the older curated caller guarantee. */
export declare function collectionReadView(value: CollectionResourceView): {
    presentationKind: import("./collection-kind.ts").CollectionKind['presentationKind'];
    presentationKindSource: import("./collection-kind.ts").CollectionKind['presentationKindSource'];
    cover: import("./contract/capabilities.ts").LibraryCoverSummary | null;
    coverSource: 'owner' | 'member' | 'none' | 'pending';
    coverMediaId?: string | null;
    previewMembers?: {
        subjectId: string;
        subject: import("../semantic/summaries.ts").SubjectSummary;
    }[];
    previewStatus?: 'ready' | 'pending';
    id: string;
    curatorAccountId: string | null;
    title: string;
    description: string | null;
    visibility: 'private' | 'unlisted' | 'public';
    revision: number;
    attribution?: ContributionAttribution;
    generation?: string;
    subjectIds?: string[];
    membershipKind: 'dynamic';
    allowedVisibilityActions?: ("private" | "public" | "unlisted")[];
} | {
    allowedVisibilityActions?: ("private" | "public" | "unlisted")[];
    id: string;
    curatorAccountId: string;
    membershipKind: 'dynamic';
    builtinKind: 'everything' | 'state' | 'liked';
    builtin: import("./builtin-identity.ts").BuiltinCollectionKey;
    builtinLabels?: Readonly<Record<string, string>>;
    visibility: 'private';
    title: string | null;
    description: string | null;
    revision: number;
    presentationKind: import("./collection-kind.ts").CollectionKind['presentationKind'];
    presentationKindSource: import("./collection-kind.ts").CollectionKind['presentationKindSource'];
    cover: null;
    coverSource: 'none';
} | {
    presentationKind: import("./collection-kind.ts").CollectionKind['presentationKind'];
    presentationKindSource: import("./collection-kind.ts").CollectionKind['presentationKindSource'];
    cover: import("./contract/capabilities.ts").LibraryCoverSummary | null;
    coverSource: 'owner' | 'member' | 'none' | 'pending';
    coverMediaId?: string | null;
    previewMembers?: {
        subjectId: string;
        subject: import("../semantic/summaries.ts").SubjectSummary;
    }[];
    previewStatus?: 'ready' | 'pending';
    id: string;
    curatorAccountId: string | null;
    title: string;
    description: string | null;
    visibility: 'private' | 'unlisted' | 'public';
    revision: number;
    memberCount: number;
    createdAt: string;
    updatedAt: string;
    attribution?: ContributionAttribution;
    generation?: string;
    subjectIds?: string[];
    allowedVisibilityActions?: ("private" | "public" | "unlisted")[];
    membershipKind: 'curated';
    orderEpoch: number;
};
export type MemberView = {
    id: string;
    subjectId: string;
    note: string | null;
    addedAt: string;
};
export type PublicCollectionView = {
    id: string;
    curatorAccountId: string | null;
    title: string;
    multiplicity: number;
};
export type PublicCollectionPage = {
    collections: PublicCollectionView[];
    count: {
        value: number;
        exact: true;
    };
    next: string | null;
};
type CollectionDirectoryPage = {
    collections: CollectionResourceView[];
    next: string | null;
    ownerManagement?: 'owner';
    ownerAccountId?: string;
};
/** The mounted presentation finishes before the reader's terminal observations. */
type PagePresentation<Page, Result = Page> = {
    deadline: number;
    present(page: Page): Promise<Result>;
};
export declare function createCollectionReads(dependencies: PreviewPreparationDependencies & {
    tokens: KeyRing;
    search?: SearchService;
} & ({
    viewerPersonalActions?: undefined;
} | {
    viewerPersonalActions: ViewerPersonalActionsReader;
    routeKey: Uint8Array;
})): {
    readCollection: (viewer: Actor, id: string, deadline?: number, observation?: {
        time: AuthoritativeTime;
        attempt?: CommandAttempt;
    }, ownerManagement?: boolean) => Promise<CollectionResourceView>;
    readCollectionSummary: (viewer: Actor, id: string, deadline: number, work?: AccessWorkAccounting) => Promise<{
        id: string;
        title: string | null;
    }>;
    readCollectionMetadataHistory: (viewer: Actor, id: string, options?: {
        cursor?: string | null;
        limit?: number;
    }, deadline?: number) => Promise<CollectionMetadataHistoryPage>;
    readCollectionMetadataHistoryChange: (viewer: Actor, id: string, revision: number, deadline?: number) => Promise<CollectionMetadataHistoryDetail>;
    readRule: (viewer: Actor, id: string, deadline?: number) => Promise<import("./collection-rules.ts").SavedCollectionRule>;
    listCollections: {
        (viewer: Actor, options: CuratorPageOptions, preview?: {
            deadline: number;
        }): Promise<CollectionDirectoryPage>;
        <Result>(viewer: Actor, options: CuratorPageOptions, preview: {
            deadline: number;
        } | undefined, presentation: PagePresentation<CollectionDirectoryPage, Result>): Promise<Result>;
    };
    listAccountCollections: {
        (viewer: Actor, options: CuratorPageOptions): Promise<CollectionDirectoryPage>;
        <Result>(viewer: Actor, options: CuratorPageOptions, presentation: PagePresentation<CollectionDirectoryPage, Result>): Promise<Result>;
    };
    listMembers: (viewer: Actor, collectionId: string, options?: {
        cursor?: string | null;
        limit?: number;
    }, deadline?: number) => Promise<{
        members: MemberView[];
        next: string | null;
    }>;
    readMembers: (viewer: Actor, collectionId: string, options?: CollectionMemberQuery, deadline?: number) => Promise<import("../search/service-contract.ts").SavedCatalogueMembersPage | {
        preparing: true;
    } | {
        members: MemberView[];
        next: string | null;
    }>;
    withViewerFacts: <T extends {
        members: readonly {
            subjectId: string;
            id?: string;
        }[];
    }>(viewer: Actor, result: T, deadline?: number, revalidate?: () => Promise<void>) => Promise<T>;
    observeMemberSource: (viewer: Actor, id: string, deadline: number) => Promise<() => Promise<void>>;
    readSitemapCollection: (collectionId: string, deadline: number) => Promise<{
        id: string;
        lastModified: string;
    }>;
    listSubjectCollections: (viewer: Actor, subjectId: string, options?: {
        cursor?: string | null;
        limit?: number;
        view?: 'BASIC' | 'FULL';
    }, presentation?: PagePresentation<PublicCollectionPage>) => Promise<PublicCollectionPage>;
};
/** Batch form of the ordinary Collection read's public eligibility. Only the
 * requested full keys are examined; private rows remain available to Access grants. */
export declare const collectionViewerActionResource: import('../access/viewer-actions.ts').ViewerActionResource;
export {};
