import { DBOS, DBOSClient, type WorkflowWriterFence, type WorkflowWriterState } from '@dbos-inc/dbos-sdk';
import { currentCommandResources, type CommandTransaction } from '../command/command.ts';

export type SdkRetirementFence = WorkflowWriterFence;
export type SdkRetirementClient = Pick<DBOSClient, 'retireWorkflow' | 'getWorkflowWriterFence'>;
export type SdkWriterState = WorkflowWriterState;

/** Per dispatch, including the outer SELECT and both nested indexed native locks and the native return SELECT.
 * Owners must reserve this in their existing frame before dispatch, including failures/rechecks. */
export const SDK_TRANSACTION_FENCE_COST = Object.freeze({
  rows: 4,
  points: 2,
  statements: 4,
  bytes: 8192,
  engineWork: 0,
});

/** Released observation only. Missing original identity is not manufactured by this read. */
export function readSdkWorkflowWriterState(
  actualWorkflowId: string,
  sdk: DBOSClient,
): Promise<SdkWriterState | null> {
  if (!(sdk instanceof DBOSClient)) throw new TypeError('An actual SDK owner client is required');
  return sdk.getWorkflowWriterState(actualWorkflowId);
}

/** Current SDK authority on the caller's SAME native command, held through its commit.
 * Generation 1 is pre-retirement serialization only; generation 2 checks the exact closure.
 * Neither result grants Source discharge, receiving closure or legal cleanup permission. */
export function lockSdkWorkflowWriterState(
  tx: CommandTransaction,
  expected: SdkWriterState,
  sdk: DBOSClient,
): Promise<SdkWriterState> {
  const { pool } = currentCommandResources(tx);
  if (!(sdk instanceof DBOSClient)) throw new TypeError('An actual SDK owner client is required');
  return sdk.checkWorkflowWriterStateInTransaction(tx, pool, expected);
}

/** Technical closure only. Owners must establish genuine readiness before calling this. */
export function retireSdkWorkflowWriters(
  actualWorkflowId: string,
  sdk: SdkRetirementClient = DBOS,
): Promise<SdkRetirementFence> {
  return sdk.retireWorkflow(actualWorkflowId);
}

/** Read the durable native fence even after supported execution/history deletion. */
export function readSdkWorkflowRetirement(
  actualWorkflowId: string,
  sdk: SdkRetirementClient = DBOS,
): Promise<SdkRetirementFence | null> {
  return sdk.getWorkflowWriterFence(actualWorkflowId);
}
