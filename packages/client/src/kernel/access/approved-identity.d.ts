import { type IdentityExpiry } from './identity-expiry.ts';
import { type Access, type AccessContext, type AccountActor } from '../request/access.ts';
import { type KeyRing } from '../tokens/seal.ts';
import approvalRead from './workflow-approvals-read.sql';
export declare class ApprovalIdentityDeniedError extends Error {
    readonly status = 403;
    constructor();
}
export declare class ApprovalIdentityUnavailableError extends Error {
    readonly status = 503;
    constructor();
}
export declare const APPROVAL_REFERENCE_PURPOSE = "access.workflow-approval.v1";
export type ApprovalRow = NonNullable<Awaited<ReturnType<typeof approvalRead.run>>>;
declare const approvedIdentity: unique symbol;
/** Internal opaque evidence. Only a verified native row can mint this brand. */
export type ApprovedIdentity = {
    readonly [approvedIdentity]: true;
};
type Claims = {
    actor: AccountActor;
    expires: number;
    scope: object;
    pool: AccessContext['pool'];
};
type Bridge = {
    scope: object;
    expiry(actor: AccountActor, context: AccessContext): IdentityExpiry | undefined;
    restore(proof: ApprovedIdentity, context: AccessContext): Promise<AccountActor>;
};
/** Factory composition only; no actor JSON registration or public bearer port. */
export declare function installApprovalIdentityBridge(access: Access, bridge: Bridge): void;
export declare function approvedIdentityClaims(proof: ApprovedIdentity, scope: object, pool: AccessContext['pool']): Claims | undefined;
/** The original verified instant, checked on the clock that issued the identity. */
export declare function verifiedBearerExpiry(access: Access, actor: AccountActor, context: AccessContext): number;
/** Kernel rows retain kernel instants, including caps inherited from a bearer. */
export declare function verifiedKernelExpiry(access: Access, actor: AccountActor, context: AccessContext): number;
/** Bind every immutable column, including original scope ceiling and JWT expiry. */
export declare function approvalRowDigest(row: ApprovalRow): string;
/** This is the only approval identity minting path. It requires the configured
 * MAC, exact native row, immutable binding and strict live native expiry. The
 * authenticator additionally reads the current actor and assignment on its pool.
 */
export declare function readApprovedIdentity(access: Access, keys: KeyRing, reference: string, context: AccessContext): Promise<{
    row: ApprovalRow;
    actor: AccountActor;
}>;
export {};
