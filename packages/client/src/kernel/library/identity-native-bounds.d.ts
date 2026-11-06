/** Compatibility identity-native matching. Core owns arithmetic; the adapter catalog owns SQL texts. */
import { type Bound } from '@rezics/bounds';
import type { WorkDimensions } from './contract/work-dimensions.ts';
import type { NativeCollectionWork } from './collection-source-work.ts';
import { libraryIdentityJobSizeSQL, nativeIdentityPartitionQuery } from './adapters/identity-statements.ts';
export { libraryIdentityJobSizeSQL, nativeIdentityPartitionQuery };
export declare function isNativeIdentitySourceBasisSQL(sql: string): boolean;
export declare function isLibraryIdentityFullPartitionSQL(sql: string): boolean;
export declare function nativeIdentitySourceBasisBound(sql: string, values: readonly unknown[]): Bound | undefined;
export declare function nativeIdentitySourceBasisFootprint(sql: string, values: readonly unknown[]): WorkDimensions | undefined;
export declare function declareNativeIdentitySourceBasisStatements(): readonly Readonly<{
    sql: string;
    values: readonly unknown[];
    work: WorkDimensions;
    engineRequests: 0;
}>[];
export declare function libraryIdentityNativeOperationBound(sql: string, values: readonly unknown[], work?: NativeCollectionWork): Bound | undefined;
export declare function libraryIdentitySelectedOperationBound(sql: string, values: readonly unknown[]): Bound | undefined;
export declare function libraryIdentityNativeOperationFootprint(sql: string, values: readonly unknown[], work?: NativeCollectionWork): WorkDimensions | undefined;
export declare function libraryIdentitySelectedFootprint(sql: string, values: readonly unknown[]): WorkDimensions | undefined;
/** Immutable Library-owned declarations. Each result projection remains beside its exact SQL identity. */
export declare function LIBRARY_IDENTITY_NATIVE_OPERATION_DECLARATIONS(): Readonly<{
    sql: Readonly<Record<string, Readonly<{
        sql: string;
        work: Bound;
        resultBytes: number;
    }>>>;
    selected: Readonly<Record<string, Readonly<{
        sql: string;
        values: readonly unknown[];
        work: Bound;
        resultBytes: number;
    }>>>;
    sourceBasis: readonly Readonly<{
        sql: string;
        values: readonly unknown[];
        work: Readonly<Record<"bytes" | "candidateKeys" | "emptySeeks" | "engineRequests" | "identityMetadataRows" | "nativePoints" | "nativeRows" | "statements" | "witnessKeys", number>>;
    }>[];
}>;
