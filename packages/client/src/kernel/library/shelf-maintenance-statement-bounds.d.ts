/** Library-owned declarations. A declaration prices dispatch; it is never run authority. */
import { type Bound } from '@rezics/bounds';
import type { WorkDimensions } from './contract/work-dimensions.ts';
export declare const SHELF_MAINTENANCE_LIMITS: Readonly<{
    page: 100;
    segment: 100;
    commandDeadlineMs: 5000;
    cursorScalars: 8;
    cursorBytes: 2048;
    workflowBytes: 4096;
    edgeBytes: 256;
    stagingBytes: 25600;
}>;
declare const json: (value: unknown) => string;
declare const size: (value: unknown) => number;
declare const row: (value: unknown) => number;
export declare const shelfCost: (part?: Partial<Bound>) => Bound;
declare const normalize: (sql: string) => string;
export interface ShelfMaintenanceStatementPlan {
    readonly kind: 'shelf-maintenance.sql';
    readonly sql: string;
    readonly serializedBinds: string;
    readonly logicalResultLimit: number;
    readonly total: Bound;
}
/** Literal SQL and original operands, fixed before dispatch. No result/rowCount enters this calculation. */
export declare function shelfMaintenanceStatementPlan(sql: string, values: readonly unknown[], valueBytes?: number): ShelfMaintenanceStatementPlan | undefined;
/** Explicit nine/eight-axis boundary. Every declared body above issues SQL only, with no engine producer. */
export declare function shelfMaintenanceWorkDimensions(bound: Bound): WorkDimensions;
/** Shared serialization maxima for the native command descriptor. */
export declare const shelfMaintenanceBoundValues: {
    P: 100;
    U: string;
    I: number;
    D: string;
    T: string;
    json: typeof json;
    size: typeof size;
    row: typeof row;
    normalize: typeof normalize;
};
export {};
