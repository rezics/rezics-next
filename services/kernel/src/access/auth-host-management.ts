import { bindAuthDeletionHandleRead, type AccountOperationAccess } from '@rezics/auth';
import type { NativeWorkflowProofPorts } from '@rezics/auth-contract';
import type { AccessContext } from '../request/access.ts';
import { deadlineFor } from '../request/deadline.ts';
import { accessClock } from './access-clock.ts';
import { admitGroup, PlatformClosedError } from './gates/admission.ts';
import { createAccountManagementReadAccess, createAuthDeletionHandleRead } from './management-source.ts';
import type { OperatorTransferState, OperatorTransferStateInput } from './management-source.ts';
import { createWorkflowApprovals, type WorkflowApprovalConfig } from './workflow-approvals.ts';

export type AuthHostManagementConfig = WorkflowApprovalConfig & {
  /** The same Auth-owned stage reader used by native account workflows. */
  creationBinding: NativeWorkflowProofPorts['creationBinding'];
};

export type AuthHostManagementReads = Readonly<{
  context: () => { pool: unknown; deadline: number };
  readOperatorTransferState: (
    token: string,
    input: OperatorTransferStateInput,
    boundary: { pool: unknown; deadline: number },
  ) => Promise<OperatorTransferState | null>;
}>;

export type AuthHostManagement = Readonly<{
  approvals: ReturnType<typeof createWorkflowApprovals>;
  accountOperations: AccountOperationAccess;
  accountManagementReads: AuthHostManagementReads;
}>;

/** Native management transport and workflow authority from one producer.
 * Construction performs no I/O and owns no resources. The Auth host owns the
 * lifetime of these closures; its caller owns the borrowed Kernel pool.
 */
export function createAuthHostManagement(config: AuthHostManagementConfig): AuthHostManagement {
  const { pool, access } = config;
  const approvals = createWorkflowApprovals(config);
  const reads = createAccountManagementReadAccess({ pool, access });
  const deletion = createAuthDeletionHandleRead({ pool, access });
  const context = () => ({ pool, deadline: deadlineFor(10_000) });
  // Auth's public transport deliberately hides the Pool type. Rebind that
  // trusted context here; individual native producers enforce its deadline.
  const nativeContext = (input: { pool: unknown; deadline: number }): AccessContext => ({
    pool,
    deadline: input.deadline,
  });
  const readOperatorTransferState: AuthHostManagementReads['readOperatorTransferState'] = (token, input, boundary) =>
    reads.readOperatorTransferState(token, input, nativeContext(boundary));
  const accountOperations: AccountOperationAccess = {
    context,
    approve: (token, input, boundary) => approvals.approve(token, input, nativeContext(boundary)),
    resolveForCaller: (token, reference, operation, boundary) =>
      approvals.resolveForCaller(token, reference, operation, nativeContext(boundary)),
    readOperatorTransferState,
    readDeletionHandle: (token, accountId, boundary) =>
      deletion.readDeletionHandle(token, accountId, nativeContext(boundary)),
    async admitGroup(token, group, boundary) {
      const request = nativeContext(boundary);
      const actor = await access.authenticate(token, request);
      try {
        await admitGroup({
          pool,
          access: () => access,
          actor,
          group,
          clientAction: 'organization:create',
          deadline: request.deadline,
          clock: accessClock(access),
        });
        return true;
      } catch (error) {
        // Dependency errors must remain unavailable, never a closed decision.
        if (error instanceof PlatformClosedError) return false;
        throw error;
      }
    },
  };
  bindAuthDeletionHandleRead(accountOperations, deletion);
  return {
    approvals,
    accountOperations,
    accountManagementReads: { context, readOperatorTransferState },
  };
}
