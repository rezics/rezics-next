import type { Access } from '../request/access.ts';
import type { KeyRing } from '../tokens/seal.ts';
import type { Pool } from 'pg';
import type { OwnerQueryDependencies } from './builtin-runtime-query.ts';
export type { BuiltinCollectionView, DynamicMemberView } from './adapters/builtin-runtime.ts';
/** The ordinary composition owns all built-in construction and current producer bindings. */
export declare function createBuiltinRuntime(config: Omit<OwnerQueryDependencies, 'access'> & {
    access?: Access;
    tokens?: KeyRing;
}): {
    read: (actor: import("./adapters/authorization.ts").Actor, id: string, scope?: "collection:delete" | "collection:read" | "collection:update", deadline?: number) => Promise<import("./builtin-runtime.ts").BuiltinCollectionView | null>;
    discover: (actor: import("./adapters/authorization.ts").Actor, after?: string | null, limit?: number) => Promise<import("./builtin-runtime.ts").BuiltinCollectionView[]>;
    resolve: (actor: import("./adapters/authorization.ts").Actor, key: Exclude<import("./builtin-identity.ts").BuiltinCollectionKey, {
        kind: 'liked';
    }>, deadline?: number) => Promise<import("./builtin-runtime.ts").BuiltinCollectionView | null>;
    members: (actor: import("./contract/actors.ts").LibraryActor, id: string, options?: import("./contract/builtin-presentation.ts").BuiltinMemberOptions<{
        filter: import("@rezics/filter").FilterDocument;
        releaseDigest: string;
    }>) => Promise<{
        members: import("./builtin-runtime.ts").DynamicMemberView[];
        next: string | null;
    }>;
    sourceVersion: (actor: import("./adapters/authorization.ts").Actor, source: import("./builtin-runtime.ts").BuiltinCollectionView, deadline: number, allowAbsent?: boolean) => Promise<string>;
};
/** Retained participant input: one native prefix and the producer's exact batched mappings. */
export declare function readBuiltinOriginalInputs(pool: Pool, accountId: string, after: string | null, limit: number): Promise<{
    fact: {
        clear?: {
            sequence: bigint;
        };
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
