/** Identity-native bound arithmetic. SQL texts arrive as catalog values; this module imports none of them. */
import { type Bound } from '@rezics/bounds';
import type { IdentityNativeCatalog, IdentityWorkHandle } from '../contract/index.ts';
import type { WorkDimensions } from '../contract/work-dimensions.ts';
declare function workDimensions(value: Bound): WorkDimensions;
export declare const IDENTITY_BASIS_BINDINGS: Readonly<Record<string, unknown>>;
export declare function identityBasisBindValues(params: readonly string[]): unknown[];
export declare function createIdentityNativeBounds(catalog: IdentityNativeCatalog): {
    bound: (sql: string, values: readonly unknown[], work?: IdentityWorkHandle) => Bound | undefined;
    footprint(sql: string, values: readonly unknown[], work?: IdentityWorkHandle): WorkDimensions | undefined;
    selectedFootprint(sql: string, values: readonly unknown[]): WorkDimensions | undefined;
    isFullPartitionSQL(sql: string): boolean;
    isSourceBasisSQL(sql: string): boolean;
    sourceBasisFootprint: (sql: string, values: readonly unknown[]) => WorkDimensions | undefined;
    sourceBasisBound: (sql: string, values: readonly unknown[]) => Bound | undefined;
    selectedBound: (sql: string, values: readonly unknown[]) => Bound | undefined;
    jobSizeSQL: string;
    workDimensions: typeof workDimensions;
    basisStatements(): readonly Readonly<{
        sql: string;
        values: readonly unknown[];
        work: WorkDimensions;
        engineRequests: 0;
    }>[];
};
export {};
