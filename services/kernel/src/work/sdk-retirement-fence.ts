import {
  DBOS,
  DBOSClient,
  WorkflowRetirementBudgetError,
  type WorkflowRetirementInvocation,
  type WorkflowRetirementOutcome,
  type WorkflowWriterFence,
  type WorkflowWriterState,
} from '@dbos-inc/dbos-sdk';
import type { CommandTransaction } from '../command/command.ts';
import type { Pool } from 'pg';
import type { NativeStepWork } from '../semantic/identity-epoch-contract.ts';
import { ensureNativeWorkApplication } from './adapters/index.ts';
import type { WorkRetirementInvocation } from './contract/index.ts';

export { WorkflowRetirementBudgetError };

export type SdkRetirementFence = WorkflowWriterFence;
export type SdkRetirementClient = {
  retireWorkflow(workflowID: string): Promise<WorkflowWriterFence>;
  retireWorkflow(workflowID: string, invocation: WorkflowRetirementInvocation): Promise<WorkflowRetirementOutcome>;
  getWorkflowWriterFence(workflowID: string): Promise<WorkflowWriterFence | null>;
};
export type SdkWriterState = WorkflowWriterState;
export type SdkRetirementOutcome = WorkflowRetirementOutcome;

export {
  SDK_MAINTENANCE_DISPATCH,
  SDK_RETIREMENT_DISPATCH,
  SDK_RETIREMENT_MAX_ATTEMPTS,
  SDK_TRANSACTION_FENCE_COST,
} from './contract/bounds.ts';

type BoundedSdk = DBOSClient & {
  maintainWorkflowOnce(
    pool: Pool,
    expected: SdkWriterState,
    action: 'retire' | 'delete',
    deadline: number,
    reserve: (dispatch: string) => Promise<void>,
  ): Promise<WorkflowWriterFence | null>;
};

export function supportsBoundedSdkMaintenance(sdk: DBOSClient): sdk is BoundedSdk {
  return sdk instanceof DBOSClient && 'maintainWorkflowOnce' in sdk && typeof sdk.maintainWorkflowOnce === 'function';
}

export function supportsBoundedSdkRetirement(sdk: SdkRetirementClient): boolean {
  return typeof sdk.retireWorkflow === 'function' && sdk.retireWorkflow.length >= 2;
}

export function maintainSdkWorkflowOnce(
  pool: Pool,
  sdk: DBOSClient,
  expected: SdkWriterState,
  action: 'retire' | 'delete',
  deadline: number,
  reserve: (cost: NativeStepWork) => Promise<void>,
): Promise<WorkflowWriterFence | null> {
  return ensureNativeWorkApplication().maintainOnce(pool, sdk, expected, action, deadline, reserve);
}

export function readSdkWorkflowWriterState(actualWorkflowId: string, sdk: DBOSClient): Promise<SdkWriterState | null> {
  return ensureNativeWorkApplication().readWriterState(actualWorkflowId, sdk);
}

export function lockSdkWorkflowWriterState(
  tx: CommandTransaction,
  expected: SdkWriterState,
  sdk: DBOSClient,
): Promise<SdkWriterState> {
  return ensureNativeWorkApplication().lockWriterState(tx, expected, sdk);
}

export function retireSdkWorkflowWriters(
  actualWorkflowId: string,
  sdk: SdkRetirementClient = DBOS,
): Promise<SdkRetirementFence> {
  if (sdk !== DBOS) return sdk.retireWorkflow(actualWorkflowId);
  return ensureNativeWorkApplication().retireWriters(actualWorkflowId);
}

export function invokeSdkWorkflowRetirement(
  actualWorkflowId: string,
  invocation: WorkRetirementInvocation,
  sdk: SdkRetirementClient = DBOS,
): Promise<SdkRetirementOutcome> {
  return ensureNativeWorkApplication().invokeRetirement(actualWorkflowId, sdk, invocation);
}

export function readSdkWorkflowRetirement(
  actualWorkflowId: string,
  sdk: SdkRetirementClient = DBOS,
): Promise<SdkRetirementFence | null> {
  if (sdk !== DBOS) return sdk.getWorkflowWriterFence(actualWorkflowId);
  return ensureNativeWorkApplication().readRetirement(actualWorkflowId);
}
