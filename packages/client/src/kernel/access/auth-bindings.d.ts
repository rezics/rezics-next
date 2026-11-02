import type { Access } from '../request/access.ts';
import type { AuthErasureProofPorts, AuthReceivingClosurePorts, AuthErasureLivePorts, AuthErasureLiveReceiver, AuthErasureObligationPorts, AccessAccount, ProvisioningReceiptMetadata, EffectAuthorization, CredentialEffectAuthorization, CredentialFloorPurpose, CredentialPurpose, PasskeyAuthorizationInput, PasskeyTrustedAccessPorts, TrustedAccessPorts } from '@rezics/auth-contract';
import type { Pool } from 'pg';
import type { createLifecycleInternals, LifecycleFenceReceipt } from './lifecycle.ts';
import type { OperatorOpening } from './operator.ts';
type ConsumeInput = Parameters<NonNullable<TrustedAccessPorts['consumeAuthorization']>>[0] | PasskeyAuthorizationInput;
type InvalidateInput = Parameters<NonNullable<TrustedAccessPorts['invalidateAccount']>>[0];
type RecoveryInput = Parameters<NonNullable<TrustedAccessPorts['authorizeRecovery']>>[0];
export type AuthProvisioningReceipt = Awaited<ReturnType<ReturnType<typeof createLifecycleInternals>['createPending']>>['value'];
export type AuthAuthorizationReceipt<Purpose extends CredentialFloorPurpose = CredentialPurpose> = {
    authorization: EffectAuthorization | CredentialEffectAuthorization<Purpose>;
    /** Required for automation; a broad native credential purpose never replaces the exact Auth purpose. */
    operatorOpening: OperatorOpening | null;
};
/** Trusted in-process coordinators own durable verification, single consumption and atomic
 * epoch checks. These callbacks are capabilities, never request JSON or authorization flags.
 * Workflow/provider implementations can bind here without another account or policy authority.
 */
export type AuthBindingCapabilities = AuthErasureProofPorts & Partial<AuthReceivingClosurePorts> & {
    /** Native pending reader, including verified original receipt metadata. The
     * composition must also verify current workflow approval for automated chains. */
    verifyPendingIdentity?: (reference: string) => Promise<(AccessAccount & {
        operatorAccountId: string | null;
        registrationId: string;
        expiresAt: string;
        receipt: ProvisioningReceiptMetadata;
    }) | null>;
    verifyProvisioningReceipt?: (commandReference: string) => Promise<AuthProvisioningReceipt | null>;
    consumeAuthAuthorization?: (input: ConsumeInput) => Promise<AuthAuthorizationReceipt<CredentialFloorPurpose> | null>;
    invalidateAccount?: (input: InvalidateInput) => Promise<LifecycleFenceReceipt | null>;
    authorizeRecovery?: (input: RecoveryInput) => Promise<LifecycleFenceReceipt | null>;
    completeRecovery?: TrustedAccessPorts['completeRecovery'];
    confirmBarrier?: TrustedAccessPorts['confirmBarrier'];
};
export declare class AuthBindingUnavailableError extends Error {
    constructor(capability: keyof AuthBindingCapabilities);
}
export declare class AuthBindingDeniedError extends Error {
    readonly status = 403;
    constructor();
}
/** Production Auth/Access seam. Reads use Access's existing account anchor; no local
 * account cache, policy evaluator, fence clearing or cross-account workflow runs here.
 * Callback fixtures establish this structural contract only, not product authorization.
 */
type AuthBindingConfig = {
    pool: Pool;
    access?: Access;
    authErasureLiveReceiver?: AuthErasureLiveReceiver;
} & AuthBindingCapabilities;
export declare function createAuthBindings(config: AuthBindingConfig & {
    authErasureLiveReceiver: AuthErasureLiveReceiver;
}): PasskeyTrustedAccessPorts & AuthErasureObligationPorts & AuthErasureLivePorts;
export declare function createAuthBindings(config: AuthBindingConfig): PasskeyTrustedAccessPorts & AuthErasureObligationPorts & Partial<AuthErasureLivePorts>;
export {};
