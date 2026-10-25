import type { AccountOperation } from '@rezics/auth';
import type { Pool } from 'pg';
import type { Access, AccessContext, ActionCatalogue } from '../request/access.ts';
import type { KeyRing } from '../tokens/seal.ts';
import type { LifecycleRequest } from './lifecycle.ts';

export const MAX_WORKFLOW_APPROVAL_LIFETIME_MS = 300_000;

/** Nonsecret integrity-bound locator only; no actor, credentials or authority. */
export type WorkflowApproval = { reference: string; expiresAt: string };
export type WorkflowApprovalConfig = {
  pool: Pool;
  access: Access;
  actions: ActionCatalogue;
  referenceKeys: KeyRing;
};
export type WorkflowApprovalRequest = { operationKey: string; operation: AccountOperation };

export class WorkflowApprovalUnavailableError extends Error {
  constructor() {
    super('Durable workflow approvals are unavailable');
    this.name = 'WorkflowApprovalUnavailableError';
  }
}

/** Build contract only: constant work, zero I/O, no retained input or Auth runtime.
 *
 * Native implementation must keep verified immutable actor/client/scopes,
 * principal/epoch facts and the canonical complete operation/key digest in one
 * exact route-led Access row. No bearer, refresh token, credential or serialized
 * context may enter Access or DBOS. Expiry is at most min(verified JWT exp,
 * approval T + MAX_WORKFLOW_APPROVAL_LIFETIME_MS); native pending registration
 * (30 minutes) and operator opening (60 seconds) lifetimes remain unchanged.
 *
 * Resolution must check exact operation, expiry and current auth facts, recheck
 * the installed formula and restore evidence only through a native proven
 * persisted approval bridge into the installed Access authenticator. An arbitrary
 * reconstructed AccountActor carries no evidence. Denied replay reveals no receipt;
 * unknown operation mappings fail closed. There is no automatic expiry renewal.
 * Fresh authenticated approval may explicitly resume only with stable operation
 * and command keys and an exact digest preserving one effect. Deliberate-fence
 * cleanup uses exact terminal/fence receipts and narrow internal commands; expired
 * user approval never grants arbitrary mutation authority.
 *
 * Eventual reads stay bounded to that exact row, native account/evidence reads
 * and the existing O((1 + K) log G) formula (K <= 1000), without history scans,
 * all-account searches or a stored-token vault.
 */
export function createWorkflowApprovals(_config: WorkflowApprovalConfig) {
  return {
    async approve(_token: string, _input: WorkflowApprovalRequest, _context: AccessContext): Promise<WorkflowApproval> {
      throw new WorkflowApprovalUnavailableError();
    },
    /** Trusted server-side workflow port; never an unauthenticated HTTP endpoint. */
    async resolve(
      _reference: string,
      _operation: AccountOperation,
      _context: AccessContext,
    ): Promise<LifecycleRequest> {
      throw new WorkflowApprovalUnavailableError();
    },
    /** Must additionally verify the actual caller matches the bound actor/client
     * before disclosing or replaying any operation. Currently always unavailable.
     */
    async resolveForCaller(
      _token: string,
      _reference: string,
      _operation: AccountOperation,
      _context: AccessContext,
    ): Promise<LifecycleRequest> {
      throw new WorkflowApprovalUnavailableError();
    },
  };
}
