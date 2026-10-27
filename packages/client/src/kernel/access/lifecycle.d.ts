import { LifecycleDeniedError } from './lifecycle-20261025094010-command.ts';
export { LifecycleDeniedError } from './lifecycle-20261025094010-command.ts';
import type { Pool } from 'pg';
import { type CommandAttempt } from '../command/command.ts';
import { type Access, type AccountActor, type AccessClient, type ActionCatalogue } from '../request/access.ts';
import type { PermissionContext } from './permission.ts';
import { type ContinuationBinding } from './committed-continuations.ts';
/** Authoritative application-clock policy: registration lasts 30 minutes and an
 * old handle redirects for 30 days. Neither clock nor timestamps come from JSON.
 * Coordination holds have NO expiry: only a durable workflow may resolve them.
 */
export declare class OrganizationCloseBlockedError extends LifecycleDeniedError {
    readonly blocker: {
        purpose: string;
        relatedAccountId: string;
    };
    constructor(blocker: {
        purpose: string;
        relatedAccountId: string;
    });
}
export declare const REGISTRATION_TTL_MS: number;
export declare const HANDLE_REDIRECT_TTL_MS: number;
export declare const LIFECYCLE_ACTIONS: ActionCatalogue;
export declare function normalizeHandle(handle: string): string;
type Boundary = {
    pool: Pool;
    clock?: () => Date;
};
export type AuthenticationBarrierReceipt = {
    accountId: string;
    purpose: AuthenticationBarrierCommand['purpose'];
    operationKey: string;
    receiptId: string;
    minimumAuthnEpoch: number;
};
export type LifecycleRequest = Omit<PermissionContext, 'pool'> & {
    actor: AccountActor;
};
export type LifecycleCommand = {
    accountId: string;
    key: string;
};
export type AuthenticationBarrierCommand = LifecycleCommand & {
    purpose: 'consent-reduction' | 'recovery';
    expectedMinimumAuthnEpoch: number;
    proofReference: string;
    proofDigest: string;
    proofExpiresAt: string;
    /** The operator opening of the session that reduces an automated account's consent. */
    openingReceiptId?: string;
};
/** Whether the human of an operator opening still manages the operator: decided with the shared permission
 * evaluator on the opening's recorded principal, before the account lock at the attempt's T, then checked
 * again under the lock. The barrier holds no formula of its own.
 */
export type OpeningManagement = {
    prepare(attempt: CommandAttempt, opening: {
        operatorAccountId: string;
        subjectAccountId: string;
        action: string;
        principal: AccountActor;
    }): Promise<object>;
    authorize(tx: AccessClient, attempt: CommandAttempt, proof: object): Promise<void>;
};
export type HandleTransition = LifecycleCommand & {
    handle: string;
    reservationId: string;
    operationId: string;
    expectedHandle: string | null;
};
/** Exact resulting floor is a decimal string, preserving PostgreSQL bigint.
 * receiptId, accountId and this floor identify the Auth invalidation barrier.
 * kind and priorOperatorAccountId are deliberately retained nonsecret facts.
 */
export type LifecycleFenceReceipt = {
    receiptId: string;
    accountId: string;
    minimumAuthnEpoch: string;
    kind: string;
    priorOperatorAccountId: string | null;
};
export type ProvisioningEvidence = {
    accountId: string;
    registrationId: string;
    authIdentityId: string;
    authnEpoch: number;
};
export type RecoveryEvidence = {
    accountId: string;
    receiptId: string;
    minimumAuthnEpoch: string;
    authnEpoch: number;
    establishmentId: string;
    /** Expiring sources must supply their original expiry (native Auth always does). */
    expiresAt?: string;
};
/** INTERNAL SERVICE CAPABILITY for the later registration/fencing coordinator.
 * Mount neither this factory nor its inputs as public HTTP commands. Evidence
 * resolvers validate trusted coordinator records. Recovery may point-read the
 * Auth-owned witness before checkout, never while holding the account anchor.
 * An unrecognized/serialized proof resolves to null. No public trusted flag exists.
 * There is deliberately no multi-anchor workflow or operator transfer in this API.
 *
 * Coordinator brief: every mutation returns the kernel CommandOutcome, including
 * value, partition/epoch/position, transactionId and replayed. Await COMMIT before
 * Auth revocation/erasure. raiseFence and public tombstone return an independently
 * readable LifecycleFenceReceipt; replay keeps its exact ID and floor and emits
 * no additional event. Only tombstone returns the former operator, for release
 * AFTER tombstoning and Auth erasure. Holds remain unresolved in this layer.
 *
 * Registration steps: registrationTarget(key) -> account ID; reserveHandle ->
 * {handle, accountId, reservationId, expiresAt}; createPending ->
 * {accountId, registrationId, expiresAt}; activate -> {accountId}; claimHandle ->
 * {handle, accountId}. Each step is separately anchored and separately replayable.
 * The coordinator must complete the handle barrier before exposing registration
 * as completed: after provisioning, claimHandle accepts that verified evidence
 * while the account is pending, then activate commits the account separately.
 * A provisioning resolver returns only successfully committed Auth provisioning evidence for the same immutable account and reservation.
 *
 * Membership steps: reserveCoordination returns {accountId, relatedAccountId,
 * purpose, reservationId} on the human's anchor; createOrganization consumes its
 * owner hold and returns {accountId, ownerAccountId}. Public setMembership consumes
 * the member's hold and returns {organizationId, memberAccountId, reservationId,
 * role}. Removal permanently closes that reservation on the organization anchor;
 * it does not release the human's responsibility on another anchor.
 *
 * Recovery: clearFence requires resolver-verified new establishment evidence
 * bound to accountId, receiptId and the exact minimumAuthnEpoch/authnEpoch.
 * It returns {accountId, receiptId, minimumAuthnEpoch}; the floor never
 * decreases. Old proofs cannot clear a later fence, including the same account.
 */
export declare function createLifecycleInternals(config: Boundary & {
    routeKey: Uint8Array;
    provisioningEvidence: (evidence: unknown) => Promise<ProvisioningEvidence | null>;
    recoveryEvidence: (evidence: unknown) => Promise<RecoveryEvidence | null>;
}): {
    /** Stable route AND identity: the coordinator's durable registration key is
     * namespaced independently from handle spelling. Keep routeKey stable. */
    registrationTarget(key: string): string;
    /** Indefinite purpose/account/reservation/operation-bound publication hold.
     * Only the trusted coordinator owns this capability. Cancellation first
     * commits a permanent account-local terminal slot before releasing it. */
    holdHandle(value: HandleTransition): Promise<import("../command/command.ts").CommandOutcome<{
        accountId: string;
        handle: string;
        reservationId: string;
        operationId: string;
    }>>;
    /** Narrow bootstrap capability: the durable initial owner's existing
     * reservation is required, and only the first organization handle is set. */
    bootstrapOrganizationHandle(value: HandleTransition & {
        ownerAccountId: string;
        ownerReservationId: string;
    }): Promise<import("../command/command.ts").CommandOutcome<{
        accountId: string;
        handle: string;
        operationId: string;
    }>>;
    finalizeHandleTransition(value: HandleTransition): Promise<import("../command/command.ts").CommandOutcome<{
        accountId: string;
        handle: string;
    }>>;
    redirectTransitionHandle(value: HandleTransition): Promise<import("../command/command.ts").CommandOutcome<{
        accountId: string;
        handle: string | null;
        reservedUntil: string;
    }>>;
    completeHandleTransition(value: HandleTransition): Promise<import("../command/command.ts").CommandOutcome<{
        accountId: string;
        handle: string;
    }>>;
    cancelHandleTransition(value: HandleTransition): Promise<import("../command/command.ts").CommandOutcome<{
        accountId: string;
        operationId: string;
    }>>;
    releaseHandleTransition(value: HandleTransition): Promise<import("../command/command.ts").CommandOutcome<{
        accountId: string;
        handle: string;
    }>>;
    expireRegistration(input: LifecycleCommand & {
        handle: string;
        reservationId: string;
    }): Promise<import("../command/command.ts").CommandOutcome<LifecycleFenceReceipt>>;
    releaseExpiredRegistrationHandle(input: LifecycleCommand & {
        handle: string;
        reservationId: string;
    }): Promise<import("../command/command.ts").CommandOutcome<{
        accountId: string;
        handle: string;
    }>>;
    reserveHandle(input: {
        handle: string;
        accountId: string;
        key: string;
    }): Promise<import("../command/command.ts").CommandOutcome<{
        handle: string;
        accountId: string;
        reservationId: string;
        expiresAt: string;
    }>>;
    createPending(input: LifecycleCommand & {
        handle: string;
        reservationId: string;
    }): Promise<import("../command/command.ts").CommandOutcome<{
        accountId: string;
        registrationId: string;
        expiresAt: string;
    }>>;
    activate(input: LifecycleCommand & {
        evidence: unknown;
    }): Promise<import("../command/command.ts").CommandOutcome<{
        accountId: string;
    }>>;
    /** Deployment-only upgrade, one supplied account per batch on its own anchor.
     * Resume with the same account/key after interruption; receipts retain the
     * result. Supply only accounts needing the upgrade, never enumerate in a
     * request path. Existing read history, including expired ranges, is final:
     * the initializer skips that identity/action rather than widening validity.
     * This installs no principal grant and never changes authentication state.
     */
    installSelfReadGrant(input: LifecycleCommand): Promise<import("../command/command.ts").CommandOutcome<{
        accountId: string;
        installed: number;
    }>>;
    claimHandle(input: LifecycleCommand & {
        handle: string;
        reservationId: string;
        evidence?: unknown;
    }): Promise<import("../command/command.ts").CommandOutcome<{
        handle: string;
        accountId: string;
    }>>;
    redirectHandle(input: LifecycleCommand & {
        handle: string;
    }): Promise<import("../command/command.ts").CommandOutcome<{
        handle: string;
        accountId: string;
        reservedUntil: string;
    }>>;
    expireHandle(input: {
        handle: string;
        key: string;
    }): Promise<import("../command/command.ts").CommandOutcome<{
        handle: string;
        released: boolean;
    }>>;
    resolveHandle(value: string): Promise<{
        accountId: string;
        redirect: boolean;
    } | null>;
    /** Release the exact member hold and inverse together, after independently
     * reading immutable organization-local terminal evidence. */
    releaseMembershipCoordination(input: {
        organizationId: string;
        memberAccountId: string;
        reservationId: string;
        key: string;
    }): Promise<{
        partition: number;
        epoch: number;
        position: bigint;
        transactionId: string;
        replayed: boolean;
        value: {
            organizationId: string;
            memberAccountId: string;
            reservationId: string;
        };
    }>;
    /** Actor/operator-anchor hold, separate from organization mutation. Holds
     * remain until the durable workflow releases them using terminal proof.
     */
    reserveCoordination(input: LifecycleCommand & {
        relatedAccountId: string;
        purpose: 'membership' | 'operator';
    }): Promise<import("../command/command.ts").CommandOutcome<{
        accountId: string;
        relatedAccountId: string;
        purpose: "operator";
        reservationId: string;
    }> | {
        partition: number;
        epoch: number;
        position: bigint;
        transactionId: string;
        replayed: boolean;
        value: {
            accountId: string;
            relatedAccountId: string;
            purpose: "membership";
            reservationId: string;
        };
    }>;
    /** Abort an unpublished organization reservation on its authoritative anchor.
     * A committed terminal slot permanently prevents delayed publication. Active
     * memberships must first use public setMembership(role: null). No actor
     * connection is held here; the later inverse release reads this proof anew.
     */
    terminalizeMembership(input: {
        organizationId: string;
        memberAccountId: string;
        reservationId: string;
        key: string;
    }): Promise<import("../command/command.ts").CommandOutcome<{
        organizationId: string;
        memberAccountId: string;
        reservationId: string;
        key: string;
        transactionId: string;
    }>>;
    /** INTERNAL coordinator step: the owner's separately committed hold proves
     * eligibility; this one organization command creates identity, first owner
     * and authoritative owner-role grants atomically. Handle work is separate.
     */
    createOrganization(input: {
        organizationId: string;
        ownerAccountId: string;
        ownerReservationId: string;
        key: string;
    }): Promise<import("../command/command.ts").CommandOutcome<{
        accountId: string;
        ownerAccountId: string;
    }>>;
    /** Trusted Auth composition only. Proof resolution happens at each native
     * attempt, including receipt replay; floor comparison holds the account lock.
     * A later floor can never authorize an earlier operation's receipt.
     */
    advanceAuthenticationFloor(value: AuthenticationBarrierCommand, verifyAtAttempt: () => Promise<boolean>, management?: OpeningManagement): Promise<import("../command/command.ts").CommandOutcome<{
        receiptId: string;
        accountId: string;
        minimumAuthnEpoch: string;
        kind: "fence" | "tombstone";
        priorOperatorAccountId: string | null;
    }>>;
    raiseFence(input: LifecycleCommand): Promise<import("../command/command.ts").CommandOutcome<LifecycleFenceReceipt>>;
    confirmBarrier: (value: AuthenticationBarrierReceipt) => Promise<boolean>;
    readFenceReceipt(accountId: string, receiptId: string): Promise<LifecycleFenceReceipt | null>;
    readFenceState(accountId: string): Promise<{
        fenced: boolean;
        receiptId: string | null;
        minimumAuthnEpoch: string;
    } | null>;
    /** Trusted Auth composition only, after the consent reduction and its session revocation committed.
     * Clears the fence that exact consent barrier raised. A fence the barrier did not raise, or one a later floor
     * moved past, stays and the completion still commits; a recovery fence needs its establishment evidence.
     */
    completeConsentBarrier(value: AuthenticationBarrierReceipt): Promise<import("../command/command.ts").CommandOutcome<{
        accountId: string;
        receiptId: string;
        minimumAuthnEpoch: string;
    }>>;
    clearFence(input: LifecycleCommand & {
        evidence: unknown;
    }): Promise<import("../command/command.ts").CommandOutcome<{
        accountId: string;
        receiptId: string;
        minimumAuthnEpoch: string;
    }>>;
};
/** Public command inputs carry NO actor/client/scope overrides. The first
 * parameter is verified kernel request context. Access prepares on every attempt before
 * checkout and the resource check executes on each real runCommand attempt.
 */
export declare function createLifecycleCommands(config: Boundary & {
    access: Access;
}): {
    transitionAccountHandle(context: LifecycleRequest, value: HandleTransition): Promise<import("../command/command.ts").CommandOutcome<{
        accountId: string;
        handle: string;
        operationId: string;
    }>>;
    updateAccount(context: LifecycleRequest, input: LifecycleCommand & {
        patch: unknown;
    }): Promise<import("../command/command.ts").CommandOutcome<{
        accountId: string;
    }>>;
    setMembership(context: LifecycleRequest, input: {
        organizationId: string;
        memberAccountId: string;
        reservationId: string;
        role: 'owner' | 'member' | null;
        key: string;
    }): Promise<import("../command/command.ts").CommandOutcome<{
        organizationId: string;
        memberAccountId: string;
        reservationId: string;
        role: "member" | "owner" | null;
    }>>;
    tombstone(context: LifecycleRequest, input: LifecycleCommand & {
        continuation?: ContinuationBinding;
    }): Promise<import("../command/command.ts").CommandOutcome<LifecycleFenceReceipt>>;
};
