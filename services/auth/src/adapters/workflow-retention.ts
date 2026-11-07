import { DBOS } from '@dbos-inc/dbos-sdk';
import { AUTH_WORKFLOW_APPLICATION, type WorkflowRetentionScan } from '../contract/index.ts';
import { workflowStatusScan, type WorkflowStatusScanContinuation } from '../retention-scan.ts';

/** Supported SDK scan only. Its opaque continuation is stored without reinterpretation;
 * terminal eligibility and the original upper key remain producer-owned.
 */
export function workflowRetentionScan(sdk: object = DBOS): WorkflowRetentionScan<WorkflowStatusScanContinuation> {
  return {
    admit() {
      workflowStatusScan(sdk);
    },
    async open(createdBefore) {
      const opened = await workflowStatusScan(sdk).openWorkflowStatusScan({
        applicationName: AUTH_WORKFLOW_APPLICATION,
        createdBefore,
      });
      return opened.upperKey === null ? null : opened;
    },
    async read(continuation, rawLimit) {
      const page = await workflowStatusScan(sdk).readWorkflowStatusScanPage(continuation, { rawLimit });
      return {
        cutoff: continuation.createdBefore,
        examined: page.examined,
        copies: page.copies,
        continuation: page.continuation,
        exhausted: page.exhausted,
      };
    },
  };
}
