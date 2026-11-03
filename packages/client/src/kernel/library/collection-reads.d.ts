import { type BuiltinCollectionView } from './builtin-runtime.ts';
import { type AuthoritativeTime, type CommandAttempt } from '../command/command.ts';
import { type Account } from '../access/account-data.ts';
import { type AccountActor, type Actor } from '../request/access.ts';
import type { KeyRing } from '../tokens/seal.ts';
import { type CollectionPresentation } from './collection-presentation.ts';
import { type CollectionMemberQuery } from './owner-filter.ts';
import type { SearchService } from '../search/service-scope.ts';
import { type CollectionPreview } from './collection-preview.ts';
import { type PreviewPreparationDependencies } from './collection-preview-work.ts';
type CuratorPageOptions = {
    curatorAccountId: string | null;
    cursor?: string | null;
    limit?: number;
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
    memberCount: number;
    createdAt: string;
    updatedAt: string;
};
export type CuratedCollectionView = CollectionView & {
    membershipKind: 'curated';
    orderEpoch: number;
};
export type SavedDynamicCollectionView = Omit<CollectionView, 'membershipKind' | 'memberCount' | 'orderEpoch' | 'createdAt' | 'updatedAt'> & {
    membershipKind: 'dynamic';
};
export type CollectionResourceView = CollectionView | SavedDynamicCollectionView | BuiltinCollectionView;
/** Check the required wire fields without expanding the older curated caller guarantee. */
export declare function collectionReadView(value: CollectionResourceView): CuratedCollectionView | SavedDynamicCollectionView | BuiltinCollectionView;
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
/** Live account authority for a private Collection. A token cached before suspension is not enough. */
export declare function grantCapable(account: Pick<Account, 'route' | 'accountId' | 'kind' | 'state' | 'fenced' | 'minimumAuthnEpoch'>, viewer: AccountActor): boolean;
export declare function createCollectionReads(dependencies: PreviewPreparationDependencies & {
    tokens: KeyRing;
    search?: SearchService;
}): {
    readCollection: (viewer: Actor, id: string, deadline?: number, observation?: {
        time: AuthoritativeTime;
        attempt?: CommandAttempt;
    }) => Promise<CollectionResourceView>;
    readRule: (viewer: Actor, id: string, deadline?: number) => Promise<import("./collection-rules.ts").SavedCollectionRule>;
    listCollections: (viewer: Actor, options: CuratorPageOptions, preview?: {
        deadline: number;
    }) => Promise<{
        collections: CollectionResourceView[];
        next: string | null;
    }>;
    listAccountCollections: (viewer: Actor, options: CuratorPageOptions) => Promise<{
        collections: CollectionResourceView[];
        next: string | null;
    }>;
    listMembers: (viewer: Actor, collectionId: string, options?: {
        cursor?: string | null;
        limit?: number;
    }, deadline?: number) => Promise<{
        members: MemberView[];
        next: string | null;
    }>;
    readMembers: (viewer: Actor, collectionId: string, options?: CollectionMemberQuery, deadline?: number) => Promise<{
        members: {
            kind: 'dynamic';
            subjectId: string;
        }[];
        next: string | null;
    } | {
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
    }>(viewer: Actor, result: T, deadline?: number) => Promise<T>;
    readSitemapCollection: (collectionId: string, deadline: number) => Promise<{
        id: string;
        lastModified: string;
    }>;
    listSubjectCollections: (viewer: Actor, subjectId: string, options?: {
        cursor?: string | null;
        limit?: number;
    }) => Promise<{
        collections: PublicCollectionView[];
        count: {
            value: number;
            exact: true;
        };
        next: string | null;
    }>;
};
/** Batch form of the ordinary Collection read's public eligibility. Only the
 * requested full keys are examined; private rows remain available to Access grants. */
export declare const collectionViewerActionResource: import('../access/viewer-actions.ts').ViewerActionResource;
export {};
