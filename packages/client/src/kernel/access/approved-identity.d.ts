import type { Access, AccessContext, AccountActor } from '../request/access.ts';
import { type KeyRing } from '../tokens/seal.ts';
import approvalRead from './workflow-approvals-read.sql';
import { type KernelClock } from '../clock.ts';
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
    clock?: KernelClock;
    expiry(actor: AccountActor, context: AccessContext): number | undefined;
    restore(proof: ApprovedIdentity, context: AccessContext): Promise<AccountActor>;
};
/** The factory supplies its root clock with the identity bridge. Keeping this
 * lookup here avoids importing the factory and its standalone Access during setup. */
export declare function approvalClock(access: Access): KernelClock;
/** Factory composition only; no actor JSON registration or public bearer port. */
export declare function installApprovalIdentityBridge(access: Access, bridge: Bridge): void;
export declare function approvedIdentityClaims(proof: ApprovedIdentity, scope: object, pool: AccessContext['pool']): Claims | undefined;
export declare function verifiedBearerExpiry(access: Access, actor: AccountActor, context: AccessContext): number;
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
