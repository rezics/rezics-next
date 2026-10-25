import type { Pool } from 'pg';
import { type Access, type Actor } from '../request/access.ts';
import type { KeyRing } from '../tokens/seal.ts';
export type CollectionView = {
    id: string;
    curatorAccountId: string;
    title: string;
    description: string | null;
    visibility: 'private' | 'unlisted' | 'public';
    revision: number;
    memberCount: number;
    createdAt: string;
    updatedAt: string;
};
export type MemberView = {
    id: string;
    subjectId: string;
    note: string | null;
    addedAt: string;
};
export type PublicCollectionView = {
    id: string;
    curatorAccountId: string;
    title: string;
    multiplicity: number;
};
export declare function createCollectionReads(dependencies: {
    pool: Pool;
    access: Access;
    tokens: KeyRing;
}): {
    readCollection: (viewer: Actor, id: string) => Promise<CollectionView>;
    listCollections: (viewer: Actor, options: {
        curatorAccountId: string;
        cursor?: string | null;
        limit?: number;
    }) => Promise<{
        collections: CollectionView[];
        next: string | null;
    }>;
    listMembers: (viewer: Actor, collectionId: string, options?: {
        cursor?: string | null;
        limit?: number;
    }) => Promise<{
        members: MemberView[];
        next: string | null;
    }>;
    listSubjectCollections: (viewer: Actor, subjectId: string, options?: {
        cursor?: string | null;
        limit?: number;
    }) => Promise<{
        collections: PublicCollectionView[];
        next: string | null;
    }>;
};
