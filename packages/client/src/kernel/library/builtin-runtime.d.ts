import type { KeyRing } from '../tokens/seal.ts';
import type { Pool } from 'pg';
import type { Access, Actor } from '../request/access.ts';
import { type BuiltinCollectionKey } from './builtin-identity.ts';
import type { CollectionKind } from './collection-kind.ts';
import type { OwnerQueryDependencies } from './builtin-runtime-query.ts';
import type { FilterDocument } from '@rezics/filter';
export type BuiltinCollectionView = {
    id: string;
    curatorAccountId: string;
    membershipKind: 'dynamic';
    builtinKind: 'everything' | 'state' | 'liked';
    builtin: BuiltinCollectionKey;
    builtinLabels?: Readonly<Record<string, string>>;
    visibility: 'private';
    title: string | null;
    description: string | null;
    revision: number;
    presentationKind: CollectionKind['presentationKind'];
    presentationKindSource: CollectionKind['presentationKindSource'];
    cover: null;
    coverSource: 'none';
};
export type DynamicMemberView = {
    kind: 'dynamic';
    subjectId: string;
};
type ReadScope = 'collection:read' | 'collection:update' | 'collection:delete';
/** Logical owner reads share the native account/scopes boundary. They create no header, grant, receipt or work. */
export declare function createBuiltinRuntime(config: Omit<OwnerQueryDependencies, 'access'> & {
    access?: Access;
    tokens?: KeyRing;
}): {
    read: (actor: Actor, id: string, scope?: ReadScope, deadline?: number) => Promise<BuiltinCollectionView | null>;
    discover: (actor: Actor, after?: string | null, limit?: number) => Promise<BuiltinCollectionView[]>;
    resolve: (actor: Actor, key: Exclude<BuiltinCollectionKey, {
        kind: 'liked';
    }>, deadline?: number) => Promise<BuiltinCollectionView | null>;
    members: (actor: Actor, id: string, options?: {
        limit?: number;
        cursor?: string | null;
        deadline?: number;
        query?: {
            filter: FilterDocument;
            releaseDigest: string;
        };
    }) => Promise<{
        members: DynamicMemberView[];
        next: string | null;
    }>;
    sourceVersion: (actor: Actor, source: BuiltinCollectionView, deadline: number, allowAbsent?: boolean) => Promise<string>;
};
/** Internal native primitive for the real participant/retained plan integration. Never a successful member page. */
export declare function readBuiltinOriginalInputs(pool: Pool, accountId: string, after: string | null, limit: number): Promise<{
    fact: {
        original: string;
        presence: boolean | null;
        families: {
            entry: boolean;
            label: boolean | null;
            session: boolean;
            copy: boolean;
        };
        state: {
            id: string;
            sequence: bigint | null;
            pin: import("@rezics/definitions").LibraryProfilePin | null;
        } | null;
    };
    mapping: import("../semantic/identity-epoch-contract.ts").IdentityMapping;
}[]>;
export {};
