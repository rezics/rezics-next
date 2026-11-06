import { DBOSClient, type WorkflowWriterFence, type WorkflowWriterState } from '@dbos-inc/dbos-sdk';
import type { CommandTransaction } from '../command/command.ts';
import type { Pool } from 'pg';
import type { NativeStepWork } from '../semantic/identity-epoch-contract.ts';
export type SdkRetirementFence = WorkflowWriterFence;
export type SdkRetirementClient = Pick<DBOSClient, 'retireWorkflow' | 'getWorkflowWriterFence'>;
export type SdkWriterState = WorkflowWriterState;
export { SDK_MAINTENANCE_DISPATCH, SDK_TRANSACTION_FENCE_COST } from './contract/bounds.ts';
type BoundedSdk = DBOSClient & {
    maintainWorkflowOnce(pool: Pool, expected: SdkWriterState, action: 'retire' | 'delete', deadline: number, reserve: (dispatch: string) => Promise<void>): Promise<WorkflowWriterFence | null>;
};
export declare function supportsBoundedSdkMaintenance(sdk: DBOSClient): sdk is BoundedSdk;
export declare function maintainSdkWorkflowOnce(pool: Pool, sdk: DBOSClient, expected: SdkWriterState, action: 'retire' | 'delete', deadline: number, reserve: (cost: NativeStepWork) => Promise<void>): Promise<WorkflowWriterFence | null>;
export declare function readSdkWorkflowWriterState(actualWorkflowId: string, sdk: DBOSClient): Promise<SdkWriterState | null>;
export declare function lockSdkWorkflowWriterState(tx: CommandTransaction, expected: SdkWriterState, sdk: DBOSClient): Promise<SdkWriterState>;
export declare function retireSdkWorkflowWriters(actualWorkflowId: string, sdk?: SdkRetirementClient): Promise<SdkRetirementFence>;
export declare function readSdkWorkflowRetirement(actualWorkflowId: string, sdk?: SdkRetirementClient): Promise<SdkRetirementFence | null>;
