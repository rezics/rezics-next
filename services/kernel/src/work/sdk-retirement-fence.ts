import { DBOS, type DBOSClient, type WorkflowWriterFence } from '@dbos-inc/dbos-sdk';

export type SdkRetirementFence = WorkflowWriterFence;
export type SdkRetirementClient = Pick<DBOSClient, 'retireWorkflow' | 'getWorkflowWriterFence'>;

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
