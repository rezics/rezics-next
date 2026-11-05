import { type Bound } from '@rezics/bounds';
import type { WorkDimensions } from './collection-source.ts';
import type { NativeCollectionWork } from './collection-source-work.ts';
type Query = Readonly<{
    sql: string;
    params: readonly string[];
}>;
export declare const libraryIdentityJobSizeSQL = "SELECT octet_length(intent::text) AS bytes FROM semantic.identity_epoch_job WHERE partition_no=$1 AND job_id=$2 AND epoch=$3";
export declare const nativeIdentityPartitionQuery: Query;
/** Immutable Library-owned declarations. Each result projection remains beside its exact SQL identity. */
export declare const LIBRARY_IDENTITY_NATIVE_OPERATION_DECLARATIONS: Readonly<{
    sql: Readonly<Readonly<Record<"abandonWorking" | "advanceCapture" | "advanceGeneration" | "advancePlan" | "detachHead" | "detachState" | "effectPage" | "insertEffect" | "insertGeneration" | "insertPlan" | "insertReference" | "insertSeal" | "invalidateGeneration" | "invalidateKey" | "invalidateKeyInline" | "mappingClaim" | "nextPlan" | "oldFacts" | "oldHead" | "oldReferences" | "oldState" | "readEffect" | "retainedGenerations" | "sealPlan", Readonly<{
        sql: string;
        work: Bound;
        resultBytes: number;
    }>>>>;
    selected: Readonly<Readonly<Record<"current" | "job" | "page" | "plan" | "seal", Readonly<{
        sql: string;
        values: readonly unknown[];
        work: Bound;
        resultBytes: number;
    }>>>>;
    sourceBasis: readonly Readonly<{
        sql: string;
        values: readonly unknown[];
        work: Readonly<Record<"bytes" | "candidateKeys" | "emptySeeks" | "engineRequests" | "identityMetadataRows" | "nativePoints" | "nativeRows" | "statements" | "witnessKeys", number>>;
    }>[];
}>;
export declare function isNativeIdentitySourceBasisSQL(sql: string): boolean;
export declare function isLibraryIdentityFullPartitionSQL(sql: string): boolean;
/** Exact shared native-basis declaration used by planner execution, custody and original composition. */
export declare function nativeIdentitySourceBasisBound(sql: string, values: readonly unknown[]): Bound | undefined;
export declare function nativeIdentitySourceBasisFootprint(sql: string, values: readonly unknown[]): WorkDimensions | undefined;
export declare function declareNativeIdentitySourceBasisStatements(): readonly Readonly<{
    sql: string;
    work: WorkDimensions;
    engineRequests: 0;
}>[];
/** The one executable planner declaration shared with the original invocation composer. */
export declare function libraryIdentityNativeOperationBound(sql: string, values: readonly unknown[], work?: NativeCollectionWork): Bound | undefined;
export declare function libraryIdentitySelectedOperationBound(sql: string, values: readonly unknown[]): Bound | undefined;
export declare function libraryIdentityNativeOperationFootprint(sql: string, values: readonly unknown[], work?: NativeCollectionWork): WorkDimensions | undefined;
export declare function libraryIdentitySelectedFootprint(sql: string, values: readonly unknown[]): WorkDimensions | undefined;
export {};
