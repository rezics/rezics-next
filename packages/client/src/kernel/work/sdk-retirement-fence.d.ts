import { DBOSClient, type WorkflowWriterFence, type WorkflowWriterState } from '@dbos-inc/dbos-sdk';
import { type CommandTransaction } from '../command/command.ts';
import type { Pool } from 'pg';
import type { NativeStepWork } from '../semantic/identity-epoch-contract.ts';
export type SdkRetirementFence = WorkflowWriterFence;
export type SdkRetirementClient = Pick<DBOSClient, 'retireWorkflow' | 'getWorkflowWriterFence'>;
export type SdkWriterState = WorkflowWriterState;
/** Literal dispatch identities in the pinned single-attempt owner body. The status
 * delete includes its four FK cascades; payload/operations have no FK. No DELETE
 * trigger invokes the INSERT/UPDATE writer guard. Stored payload bytes stay in PG. */
export declare const SDK_MAINTENANCE_DISPATCH: Readonly<{
    rollback: Readonly<{
        rows: number;
        points: number;
        statements: number;
        bytes: number;
        engineRequests: number;
    }>;
    begin: Readonly<{
        rows: number;
        points: number;
        statements: number;
        bytes: number;
        engineRequests: number;
    }>;
    settings: Readonly<{
        rows: number;
        points: number;
        statements: number;
        bytes: number;
        engineRequests: number;
    }>;
    lock: Readonly<{
        rows: number;
        points: number;
        statements: number;
        bytes: number;
        engineRequests: number;
    }>;
    retire: Readonly<{
        rows: number;
        points: number;
        statements: number;
        bytes: number;
        engineRequests: number;
    }>;
    commit: Readonly<{
        rows: number;
        points: number;
        statements: number;
        bytes: number;
        engineRequests: number;
    }>;
    'delete-workflow_input': Readonly<{
        rows: number;
        points: number;
        statements: number;
        bytes: number;
        engineRequests: number;
    }>;
    'delete-workflow_output': Readonly<{
        rows: number;
        points: number;
        statements: number;
        bytes: number;
        engineRequests: number;
    }>;
    'delete-operation_outputs': Readonly<{
        rows: number;
        points: number;
        statements: number;
        bytes: number;
        engineRequests: number;
    }>;
    'delete-workflow_status': Readonly<{
        rows: number;
        points: number;
        statements: number;
        bytes: number;
        engineRequests: number;
    }>;
}>;
type BoundedSdk = DBOSClient & {
    maintainWorkflowOnce(pool: Pool, expected: SdkWriterState, action: 'retire' | 'delete', deadline: number, reserve: (dispatch: string) => Promise<void>): Promise<WorkflowWriterFence | null>;
};
export declare function supportsBoundedSdkMaintenance(sdk: DBOSClient): sdk is BoundedSdk;
/** No internal retry. Every real dispatch, including the rollback slot, is reserved
 * by the caller's existing Source frame. A failed/ambiguous attempt is not repeated
 * here: ordinary later scheduling observes exact durable state under its binding. */
export declare function maintainSdkWorkflowOnce(pool: Pool, sdk: DBOSClient, expected: SdkWriterState, action: 'retire' | 'delete', deadline: number, reserve: (cost: NativeStepWork) => Promise<void>): Promise<WorkflowWriterFence | null>;
/** Per dispatch, including the outer SELECT and both nested indexed native locks and the native return SELECT.
 * Owners must reserve this in their existing frame before dispatch, including failures/rechecks. */
export declare const SDK_TRANSACTION_FENCE_COST: Readonly<{
    rows: 4;
    points: 2;
    statements: 4;
    bytes: 8192;
    engineWork: 0;
}>;
/** Released observation only. Missing original identity is not manufactured by this read. */
export declare function readSdkWorkflowWriterState(actualWorkflowId: string, sdk: DBOSClient): Promise<SdkWriterState | null>;
/** Current SDK authority on the caller's SAME native command, held through its commit.
 * Generation 1 is pre-retirement serialization only; generation 2 checks the exact closure.
 * Neither result grants Source discharge, receiving closure or legal cleanup permission. */
export declare function lockSdkWorkflowWriterState(tx: CommandTransaction, expected: SdkWriterState, sdk: DBOSClient): Promise<SdkWriterState>;
/** Technical closure only. Owners must establish genuine readiness before calling this. */
export declare function retireSdkWorkflowWriters(actualWorkflowId: string, sdk?: SdkRetirementClient): Promise<SdkRetirementFence>;
/** Read the durable native fence even after supported execution/history deletion. */
export declare function readSdkWorkflowRetirement(actualWorkflowId: string, sdk?: SdkRetirementClient): Promise<SdkRetirementFence | null>;
export {};
