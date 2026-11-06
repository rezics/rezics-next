import { DBOS } from '@dbos-inc/dbos-sdk';

/** Received Accounts SDK vocabulary. Auth persists this continuation; it does not query SDK tables. */
export type WorkflowStatusScanKey = Readonly<{ createdAt: number; workflowID: string }>;
export type WorkflowStatusScanHorizon = Readonly<{
  applicationName: string;
  createdBefore: number;
  upperKey: WorkflowStatusScanKey | null;
}>;
export type WorkflowStatusScanContinuation = WorkflowStatusScanHorizon &
  Readonly<{ lastExaminedKey: WorkflowStatusScanKey | null }>;
export type WorkflowStatusScanCopy = Readonly<{
  workflowID: string;
  workflowName: string;
  status: string;
  createdAt: number;
  completedAt: number | null;
  applicationName: string;
}>;
export type WorkflowStatusScanPage = Readonly<{
  copies: readonly WorkflowStatusScanCopy[];
  lastExaminedKey: WorkflowStatusScanKey | null;
  examined: number;
  exhausted: boolean;
  continuation: WorkflowStatusScanContinuation;
}>;

export type WorkflowStatusScanSdk = Readonly<{
  openWorkflowStatusScan(input: {
    applicationName: string;
    createdBefore: number;
  }): Promise<WorkflowStatusScanContinuation>;
  readWorkflowStatusScanPage(
    continuation: WorkflowStatusScanHorizon | WorkflowStatusScanContinuation,
    options?: { rawLimit?: number },
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
