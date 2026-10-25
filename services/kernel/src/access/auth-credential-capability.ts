import type {
  AuthService,
  CredentialAuthorizationInput,
  CredentialEffectAuthorization,
  CredentialEffectBinding,
  CredentialEffectVerifier,
  CredentialFloorPort,
} from '@rezics/auth';
import type { Pool } from 'pg';
import type { Access } from '../request/access.ts';
import type { KeyRing } from '../tokens/seal.ts';
import { AuthBindingUnavailableError, type AuthAuthorizationReceipt } from './auth-bindings.ts';
import type { createOperatorCommands } from './operator.ts';
import type { createWorkflowApprovals } from './workflow-approvals.ts';

/** Nonsecret exact binding plus the native opening's selected-row locator.
 * References are locators only, never proof of current authority. Own-human and
 * automated paths use their real native owners; never fake a self-operator row.
 */
export type CredentialOpeningLocator = Pick<
  CredentialEffectBinding,
  'operationKey' | 'effectReference' | 'effectDigest' | 'subjectAccountId' | 'purpose'
> &
  (
    | { kind: 'workflow-approval'; reference: string }
    | { kind: 'operator-opening'; operatorAccountId: string; receiptId: string }
  );

/** Trusted Auth-host composition, with installed Access and real native commands.
 * Auth retains its database, secrets, signing keys and runtime. referenceKeys are
 * kernel locator keys: one to three entries, byte IDs, >=32 bytes, current present.
 * accessTokenForProof accepts only this Auth instance's exact live callback proof;
 * feed its JWT immediately to ordinary installed Access authentication and never
 * retain either. verifyCredentialEffect is Auth's committed point-read closure,
 * not a caller hash, stage minter or kernel access to Auth storage.
 */
export type CredentialCapabilityConfig = {
  pool: Pool;
  access: Access;
  operators: ReturnType<typeof createOperatorCommands>;
  workflowApprovals: ReturnType<typeof createWorkflowApprovals>;
  referenceKeys: KeyRing;
  accessTokenForProof: AuthService['internal']['accessTokenForProof'];
  verifyCredentialEffect: CredentialEffectVerifier;
};

export type CredentialCapability = {
  /** Seal only a verified native exact opening locator; no caller approval minting.
   * The stub throws AuthBindingUnavailableError without inspecting the locator.
   */
  createOpeningReference(opening: CredentialOpeningLocator): string;
  /** Credential-only consumer. Reject legacy unbound input, session/device approval
   * and broad credential-management alone. Auth verifies the committed stage; the
   * exact purpose/key/reference/digest/subject must match the narrowed native row
   * and returned CredentialEffectAuthorization before Auth writes.
   * The stub rejects AuthBindingUnavailableError before inspecting input or I/O.
   */
  consumeAuthAuthorization(
    input: CredentialAuthorizationInput,
  ): Promise<AuthAuthorizationReceipt & { authorization: CredentialEffectAuthorization }>;
  /** Credential-only committed floor hook; never consent/recovery relabelling.
   * The stub rejects AuthBindingUnavailableError before inspecting input or I/O.
   */
  advanceCredentialFloor: CredentialFloorPort;
};

function configured(value: unknown): asserts value {
  if (!value) throw new TypeError('Invalid credential capability configuration');
}

/** Validate configuration synchronously without calling any dependency. Until
 * native implementation EVERY returned method fails closed with
 * AuthBindingUnavailableError before input inspection or any I/O, including seal.
 * This factory adds no HTTP route, SQL, migration or product credential behavior;
 * the existing session capability and its rows/behavior stay unchanged.
 *
 * Native requirements: own-human means current human equals the actor subject;
 * account:manage on that exact account uses actor grant AND consented client scope
 * AND principal grant when present. Explicit deny/missing evidence deny; no owner
 * bypass. Use workflow_approval with a CLOSED credential descriptor consumed once
 * by CAS. Organizations never hold credentials, automation never acts as operator.
 *
 * For automation, authorizeOpening/consumeOpening on the operator anchor enforce
 * current human, eligible operator, current relation/reservation/version, applicable
 * organization membership, exact human/client/scopes and every recorded floor.
 * Narrow credential-management in its native transaction AND consume CAS to ONE
 * exact purpose/key/Auth-verified commitment. Reuse operator_opening_receipt with
 * credential binding columns; a broad opening alone fails. Four separate purposes
 * never substitute for each other, sessions or devices in either direction.
 *
 * Expiry is min(native created T + 60s, source proof/session lifetime, evidence
 * lifetime), checked against command T AND database time. Retention never renews
 * rows. Every consume/retry re-runs the SAME formula, current state, fences, floors
 * and operator checks, including before disclosure of an exact saved Auth result.
 * Revalidate at the Auth commit boundary: revocation after consumption spends the
 * opening without mutation. An opening without exact committed Auth success fails
 * closed; NEW authenticated approval may resume only the same immutable operation.
 *
 * Floor advancement binds Auth's stage, consumed opening, expected previous floor,
 * key and purpose; return a real committed native receipt for the exact next floor
 * with fence preserved. Password replacement/remove-password/remove-key advance
 * before mutation and revoke <=64 sessions; add-key/first password do not. Keep
 * Auth's mutation/revocation/exact success receipt atomic in Auth, never in kernel.
 *
 * Access/DBOS persist only nonsecret locators, no password/private key/cookie/JWT
 * or permission context. Fixed selected rows/statements and logarithmic buffers:
 * O(log R + (1+K) log G), R=N+U*t+M. No history/opening/session scans. Native tasks
 * prove checkGrowth at 1x/8x/64x separately for same-subject consumed openings, old
 * Auth effects and unrelated owners. Migration versions use date -u +%Y%m%d%H%M%S
 * at creation; temporary artifacts use worktree-relative .temp/ only.
 */
export function createCredentialCapability(config: CredentialCapabilityConfig): CredentialCapability {
  configured(config && typeof config === 'object' && !Array.isArray(config));
  configured(typeof config.pool?.query === 'function' && typeof config.pool?.connect === 'function');
  configured(
    typeof config.access?.authenticate === 'function' &&
      typeof config.access?.prepare === 'function' &&
      typeof config.access?.authorize === 'function',
  );
  configured(
    typeof config.operators?.authorizeOpening === 'function' && typeof config.operators?.consumeOpening === 'function',
  );
  configured(
    typeof config.workflowApprovals?.approve === 'function' &&
      typeof config.workflowApprovals?.resolve === 'function' &&
      typeof config.workflowApprovals?.resolveForCaller === 'function',
  );
  configured(typeof config.accessTokenForProof === 'function' && typeof config.verifyCredentialEffect === 'function');
  const ring = config.referenceKeys;
  configured(ring?.keys instanceof Map && ring.keys.size > 0 && ring.keys.size <= 3);
  configured(ring.keys.has(ring.current));
  for (const [id, key] of ring.keys)
    configured(Number.isInteger(id) && id >= 0 && id <= 255 && key instanceof Uint8Array && key.byteLength >= 32);
  return {
    createOpeningReference() {
      throw new AuthBindingUnavailableError('consumeAuthAuthorization');
    },
    async consumeAuthAuthorization() {
      throw new AuthBindingUnavailableError('consumeAuthAuthorization');
    },
    async advanceCredentialFloor() {
      throw new AuthBindingUnavailableError('consumeAuthAuthorization');
    },
  };
}
