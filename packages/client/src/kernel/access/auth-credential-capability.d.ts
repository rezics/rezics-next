import { type Account } from './account-data.ts';
import type { AuthSessionPort, CredentialApprovalPorts, CredentialFloorAuthorizationInput, CredentialEffectBinding as OperatorCredentialBinding, CredentialFloorPurpose, CredentialEffectAuthorization, CredentialFloorBinding, CredentialEffectExpectation, CredentialFloorPort, TrustedAccessPorts } from '@rezics/auth-contract';
import type { Pool } from 'pg';
import type { Access, AccessContext, AccountActor, Resource } from '../request/access.ts';
import type { KeyRing } from '../tokens/seal.ts';
import { type AuthAuthorizationReceipt } from './auth-bindings.ts';
import type { createOperatorCommands } from './operator.ts';
import { type createWorkflowApprovals } from './workflow-approvals.ts';
/** Nonsecret exact binding plus the native opening's selected-row locator.
 * References are locators only, never proof of current authority. Own-human and
 * automated paths use their real native owners; never fake a self-operator row.
 */
type OpeningBinding<Binding> = Pick<Binding & CredentialFloorBinding, 'operationKey' | 'effectReference' | 'effectDigest' | 'subjectAccountId' | 'purpose'>;
export type CredentialOpeningLocator = (OpeningBinding<CredentialFloorBinding> & {
    kind: 'workflow-approval';
    reference: string;
}) | (OpeningBinding<OperatorCredentialBinding> & {
    kind: 'operator-opening';
    operatorAccountId: string;
    receiptId: string;
});
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
    accessTokenForProof: AuthSessionPort['internal']['accessTokenForProof'];
    verifyCredentialEffect(reference: string, expected: CredentialEffectExpectation<CredentialFloorPurpose>): Promise<CredentialFloorBinding>;
};
type CredentialRevalidationInput = Parameters<NonNullable<TrustedAccessPorts['revalidateCredentialEffect']>>[0] & {
    /** Auth's saved committing opening identity; required for result disclosure. */
    committedOpeningReceiptId?: string;
};
export type CredentialCapability = Required<Pick<CredentialApprovalPorts<CredentialFloorPurpose>, 'approveCredentialEffect'>> & {
    revalidateCredentialEffect(input: CredentialRevalidationInput): Promise<void>;
    /** Seal only a verified native exact opening locator; no caller approval minting.
     */
    createOpeningReference(opening: CredentialOpeningLocator): string;
    /** Credential-only consumer. Reject legacy unbound input, session/device approval
     * and broad credential-management alone. Auth verifies the committed stage; the
     * exact purpose/key/reference/digest/subject must match the narrowed native row
     * and returned CredentialEffectAuthorization before Auth writes.
     */
    consumeAuthAuthorization<Purpose extends CredentialFloorPurpose>(input: Omit<CredentialFloorAuthorizationInput, 'purpose'> & {
        purpose: Purpose;
    }): Promise<Omit<AuthAuthorizationReceipt, 'authorization'> & {
        authorization: CredentialEffectAuthorization<Purpose>;
    }>;
    /** Credential-only committed floor hook; never consent/recovery relabelling.
     */
    advanceCredentialFloor: CredentialFloorPort;
};
/** Native exact credential capability. Configuration is validated synchronously
 * without calling a dependency. Legacy unbound inputs fail unavailable before I/O.
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
 * Operator opening expiry is min(native created T + 60s, bearer expiry carried
 * into kernel time), checked against command T. The evidence read window bounds
 * creation reads, not the opening lifetime. Retention never renews rows. Every
 * consume/retry re-runs the SAME formula, current state, fences, floors and operator
 * checks, including before disclosure of an exact saved Auth result.
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
export declare function createCredentialCapability(config: CredentialCapabilityConfig): CredentialCapability;
export type { PasskeyPurpose, CredentialFloorPurpose } from '@rezics/auth-contract';
declare const floorIdentity: unique symbol;
export type CredentialFloorIdentity = {
    readonly [floorIdentity]: true;
};
/** Installed once by the ordinary Access factory; no actor JSON registration. */
export declare function installCredentialFloorBridge(access: Access, bridge: (proof: CredentialFloorIdentity, resource: Resource, context: AccessContext) => Promise<boolean>): void;
/** Opaque evidence exists only after exact native consumed-row verification. */
export declare function credentialFloorIdentityClaims(proof: CredentialFloorIdentity, pool: Pool): {
    actor: AccountActor;
    account: Account;
    pool: Pool;
} | undefined;
