import type { WorkContext } from '../work/registry.ts';
import type { Effect } from '../events/effects.ts';
import type { Pool } from 'pg';
import type { Access, Actor } from '../request/access.ts';
import type { KeyRing } from '../tokens/seal.ts';
export declare const ContextDirectoryEntrySchema: import("typebox").TObject<{
    id: import("typebox").TString;
    kind: import("typebox").TUnion<[import("typebox").TLiteral<"global">, import("typebox").TLiteral<"community">]>;
    labels: import("typebox").TRecord<"^.*$", import("typebox").TString>;
    state: import("typebox").TUnion<[import("typebox").TLiteral<"active">, import("typebox").TLiteral<"deleted">]>;
    deletedAt: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
    purgeAfter: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
}>;
export type ContextDirectoryEntry = {
    id: string;
    kind: 'global' | 'community';
    labels: Record<string, string>;
    state: 'active' | 'deleted';
    deletedAt: string | null;
    purgeAfter: string | null;
};
export type ContextDirectoryPage = {
    contexts: ContextDirectoryEntry[];
    next: string | null;
};
export type ContextDirectoryRead = {
    actor: Actor;
    deadline: number;
};
export type ContextDirectoryQuery = {
    query?: string;
    limit?: number;
    cursor?: string;
    deleted?: boolean;
};
export type ContextDirectory = {
    list(input: ContextDirectoryRead & ContextDirectoryQuery): Promise<ContextDirectoryPage>;
    lifecycle(input: ContextDirectoryRead & {
        id: string;
    }): Promise<ContextDirectoryEntry | null>;
};
export declare class ContextDirectoryPreparingError extends Error {
    constructor();
}
export declare function createContextDirectory(dependencies: {
    pool: Pool;
    access: Access;
    tokens: KeyRing;
    clock?: () => Date;
}): ContextDirectory;
export declare const CONTEXT_DIRECTORY_CHANGED = "com.rezics.semantic.context-directory.changed.v1";
/** One retained native home step. Route/key order is indexed; raw100 includes keys with no eligible payload.
 * The native Source connection closes before the receiving Source command. No account/history completion is inferred.
 */
export declare function stepContextDirectory(pool: Pool, home: number, clock?: () => Date): Promise<boolean>;
/** Existing effect delivery bridges changes; retained maintenance frontiers populate old native Contexts. */
export declare function contextDirectoryEffect(pool: Pool, clock?: () => Date): Effect;
export declare function registerContextDirectoryWork(context: WorkContext): Promise<void>;
export declare function populateContextDirectory(pool: Pool, clock?: () => Date, steps?: number): Promise<void>;
