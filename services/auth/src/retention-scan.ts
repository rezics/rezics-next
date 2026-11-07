import {
  DBOS,
  type OpenWorkflowStatusScanInput,
  type ReadWorkflowStatusScanPageOptions,
  type WorkflowStatusScanContinuation,
  type WorkflowStatusScanCopy,
  type WorkflowStatusScanHorizon,
  type WorkflowStatusScanKey,
  type WorkflowStatusScanPage,
} from '@dbos-inc/dbos-sdk';

export type {
  OpenWorkflowStatusScanInput,
  ReadWorkflowStatusScanPageOptions,
  WorkflowStatusScanContinuation,
  WorkflowStatusScanCopy,
  WorkflowStatusScanHorizon,
  WorkflowStatusScanKey,
  WorkflowStatusScanPage,
};

/** Received Accounts SDK vocabulary. Auth persists this continuation; it does not query SDK tables. */
export type WorkflowStatusScanSdk = Readonly<{
  openWorkflowStatusScan(input: OpenWorkflowStatusScanInput): Promise<WorkflowStatusScanContinuation>;
  readWorkflowStatusScanPage(
    continuation: WorkflowStatusScanHorizon | WorkflowStatusScanContinuation,
    options?: ReadWorkflowStatusScanPageOptions,
  ): Promise<WorkflowStatusScanPage>;
}>;

export const AUTH_WORKFLOW_STATUS_SCAN_UNAVAILABLE = 'auth-workflow-status-scan-producer-unavailable';

export function workflowStatusScanReadiness(sdk: object = DBOS): Readonly<{ ready: boolean; gap: string }> {
  return {
    ready:
      'openWorkflowStatusScan' in sdk &&
      typeof (sdk as WorkflowStatusScanSdk).openWorkflowStatusScan === 'function' &&
      'readWorkflowStatusScanPage' in sdk &&
      typeof (sdk as WorkflowStatusScanSdk).readWorkflowStatusScanPage === 'function',
    gap: AUTH_WORKFLOW_STATUS_SCAN_UNAVAILABLE,
  };
}

export function workflowStatusScan(sdk: object = DBOS): WorkflowStatusScanSdk {
  if (!workflowStatusScanReadiness(sdk).ready) throw new Error(AUTH_WORKFLOW_STATUS_SCAN_UNAVAILABLE);
  return sdk as WorkflowStatusScanSdk;
}
