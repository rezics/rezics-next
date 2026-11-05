/** Library-owned declarations. A declaration prices dispatch; it is never run authority. */
import { type Bound } from '@rezics/bounds';
import type { Pool, PoolClient } from 'pg';
import type { LegacyCommandOptions, PrincipalCommandOptions } from '../command/command.ts';
import type { WorkDimensions } from './collection-source.ts';
import type { PreparationSourceExecution } from './preparation-source.ts';
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
export declare const shelfCost: (part?: Partial<Bound>) => Bound;
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
export declare function consumeShelfMaintenance<T>(operation: string, total: Bound, dispatch: () => Promise<T>): Promise<T>;
/** Keep the live client/transaction and original binds; a copied plan supplies no new permission. */
export declare function shelfMaintenanceQuery<Client, Input extends object, Result>(query: {
    sql: string;
    params: readonly string[];
    run(client: Client, input: Input): Promise<Result>;
}): Readonly<{
    sql: string;
    params: readonly string[];
    run(client: Client, input: Input): Promise<Result>;
}>;
/** Private allocator SQL remains on the same live CommandTransaction. The allocator's own admission,
 * repeated native currentness reads, collision retries and deferred checks are retained. */
export declare function withShelfMaintenanceAllocator<T>(client: Pick<PoolClient, 'query'>, fullType: string | undefined, body: () => Promise<T>): Promise<T>;
export type ShelfMaintenanceOperationKind = 'request' | 'status' | 'page' | 'recovery' | 'segment';
export type ShelfMaintenanceOperation = Readonly<{
    kind: ShelfMaintenanceOperationKind;
    /** Fixed serialized owner/run/header, never authority or execution evidence. */
    input: string;
    parts: readonly Bound[];
    total: Bound;
}>;
export declare function shelfMaintenanceOperation(kind: ShelfMaintenanceOperationKind, input: unknown, parts: readonly Bound[]): ShelfMaintenanceOperation;
export declare function shelfMaintenanceEnqueuePlan(input: unknown): ShelfMaintenanceOperation;
/** Core's complete one-attempt scaffold, disjoint from Access (which uses its own native sink) and
 * the phase SQL above. Reserve before checkout; the held terminal terms settle only after dispatch
 * has drained/released, including a failed COMMIT followed by expired ROLLBACK. */
export declare function shelfMaintenanceCommandPlan(pool: Pool, options: LegacyCommandOptions | PrincipalCommandOptions): ShelfMaintenanceOperation;
/** Released observation costs keep the original snapshot/client. Full input length is obtained by a
 * scalar size point before its projection, never from a result rowCount or retransferred text. */
export declare const shelfMaintenanceSourceExecution: PreparationSourceExecution;
/** Durable SDK control is outside the page callback, so bind it before calling the registered step.
 * The callback's command/source/SQL ports remain separate consumers of the SAME original frame.
 * The existing pinned SDK continuation producer covers status/result and failed-result guards. */
export declare function runShelfMaintenanceStep<T>(input: unknown, dispatch: () => Promise<T>): Promise<T>;
/** Closed executable composition: dynamic byte operands are bound by their native size points, not
 * population constants. Limits describe invocation multiplicity; no operation can buy another frame. */
export declare const SHELF_MAINTENANCE_OPERATIONS: Readonly<{
    request: Readonly<{
        command: typeof shelfMaintenanceCommandPlan;
        query: typeof shelfMaintenanceStatementPlan;
    }>;
    status: Readonly<{
        query: typeof shelfMaintenanceStatementPlan;
    }>;
    page: Readonly<{
        command: typeof shelfMaintenanceCommandPlan;
        source: PreparationSourceExecution;
        query: typeof shelfMaintenanceStatementPlan;
        allocator: typeof withShelfMaintenanceAllocator;
        conflictReconciliations: 1;
    }>;
    recovery: Readonly<{
        limit: 100;
        query: typeof shelfMaintenanceStatementPlan;
        enqueue: typeof shelfMaintenanceEnqueuePlan;
        command: typeof shelfMaintenanceCommandPlan;
    }>;
    segment: Readonly<{
        pages: 100;
        attempts: number;
        step: typeof runShelfMaintenanceStep;
        enqueue: typeof shelfMaintenanceEnqueuePlan;
    }>;
}>;
