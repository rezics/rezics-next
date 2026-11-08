import { ContextDirectoryPreparingError, type ContextAccessHandle, type ContextAccessPort, type ContextDirectoryEntry, type ContextDirectoryPage, type ContextDirectoryQuery, type ContextDirectoryRead } from './context-access-port.ts';
import type { WorkContext } from '../work/registry.ts';
import type { Effect } from '../events/effects.ts';
import type { Pool } from 'pg';
import type { KeyRing } from '../tokens/seal.ts';
export { ContextDirectoryPreparingError };
export type { ContextDirectoryEntry, ContextDirectoryPage, ContextDirectoryQuery, ContextDirectoryRead };
export declare const ContextDirectoryEntrySchema: import("typebox").TObject<{
    id: import("typebox").TString;
    kind: import("typebox").TUnion<[import("typebox").TLiteral<"global">, import("typebox").TLiteral<"community">]>;
    labels: import("typebox").TRecord<"^.*$", import("typebox").TString>;
    state: import("typebox").TUnion<[import("typebox").TLiteral<"active">, import("typebox").TLiteral<"deleted">]>;
    deletedAt: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
    purgeAfter: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
}>;
export type ContextDirectory = {
    list(input: ContextDirectoryRead & ContextDirectoryQuery): Promise<ContextDirectoryPage>;
    lifecycle(input: ContextDirectoryRead & {
        id: string;
    }): Promise<ContextDirectoryEntry | null>;
};
export declare function createContextDirectory(dependencies: {
    pool: Pool;
    access: ContextAccessHandle;
    tokens: KeyRing;
    clock?: () => Date;
    ports?: ContextAccessPort;
}): ContextDirectory;
export declare const CONTEXT_DIRECTORY_CHANGED = "com.rezics.semantic.context-directory.changed.v1";
/** One retained native home step. Route/key order is indexed; raw100 includes keys with no eligible payload.
 * The native Source connection closes before the receiving Source command. No account/history completion is inferred.
 */
export declare function stepContextDirectory(pool: Pool, home: number, clock?: () => Date, accessPort?: ContextAccessPort): Promise<boolean>;
/** Existing effect delivery bridges changes; retained maintenance frontiers populate old native Contexts. */
export declare function contextDirectoryEffect(pool: Pool, clock?: () => Date, accessPort?: ContextAccessPort): Effect;
export declare function registerContextDirectoryWork(context: WorkContext, accessPort?: ContextAccessPort): Promise<void>;
export declare function populateContextDirectory(pool: Pool, clock?: () => Date, steps?: number, accessPort?: ContextAccessPort): Promise<void>;
