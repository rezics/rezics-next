import { DBOS, DBOSClient, type WorkflowWriterFence, type WorkflowWriterState } from '@dbos-inc/dbos-sdk';
import { currentCommandResources, type CommandTransaction } from '../command/command.ts';
import type { Pool } from 'pg';
import type { NativeStepWork } from '../semantic/identity-epoch-contract.ts';

export type SdkRetirementFence = WorkflowWriterFence;
export type SdkRetirementClient = Pick<DBOSClient, 'retireWorkflow' | 'getWorkflowWriterFence'>;
export type SdkWriterState = WorkflowWriterState;

const cost = (rows: number, points: number, statements: number, bytes = 0): NativeStepWork => ({
  rows,
  points,
  statements,
  bytes,
  engineRequests: 0,
});

/** Literal dispatch identities in the pinned single-attempt owner body. The status
 * delete includes its four FK cascades; payload/operations have no FK. No DELETE
 * trigger invokes the INSERT/UPDATE writer guard. Stored payload bytes stay in PG. */
export const SDK_MAINTENANCE_DISPATCH = Object.freeze({
  rollback: cost(0, 0, 1),
  begin: cost(0, 0, 1),
  settings: cost(1, 0, 1, 128),
  lock: cost(4, 2, 4, 8192),
  retire: cost(8, 5, 9, 32768),
  commit: cost(0, 0, 1),
  'delete-workflow_input': cost(1, 1, 1),
  'delete-workflow_output': cost(1, 1, 1),
  'delete-operation_outputs': cost(64, 1, 1),
  'delete-workflow_status': cost(73, 5, 5),
});

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

/** No internal retry. Every real dispatch, including the rollback slot, is reserved
 * by the caller's existing Source frame. A failed/ambiguous attempt is not repeated
 * here: ordinary later scheduling observes exact durable state under its binding. */
export function maintainSdkWorkflowOnce(
  pool: Pool,
  sdk: DBOSClient,
  expected: SdkWriterState,
  action: 'retire' | 'delete',
  deadline: number,
  reserve: (cost: NativeStepWork) => Promise<void>,
): Promise<WorkflowWriterFence | null> {
  if (!supportsBoundedSdkMaintenance(sdk)) throw new TypeError('SDK bounded workflow maintenance is unavailable');
  return sdk.maintainWorkflowOnce(pool, expected, action, deadline, async (dispatch) => {
    const amount = SDK_MAINTENANCE_DISPATCH[dispatch as keyof typeof SDK_MAINTENANCE_DISPATCH];
    if (!amount) throw new TypeError('Unpriced SDK maintenance dispatch');
    await reserve(amount);
  });
}

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
export function readSdkWorkflowWriterState(actualWorkflowId: string, sdk: DBOSClient): Promise<SdkWriterState | null> {
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
