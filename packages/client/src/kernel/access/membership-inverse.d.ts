import type { Pool } from 'pg';
import type { AccessClient } from '../request/access.ts';
import { type RealmTransitionAuthority } from './realm-membership-transition.ts';
export declare const MEMBERSHIP_LIMIT = 1000;
export type MembershipPrincipal = {
    kind: 'organization' | 'realm';
    id: string;
};
export type MembershipReservation = {
    accountId: string;
    principal: MembershipPrincipal;
    reservationId: string;
    transition?: {
        generationId: string;
        operationId: string;
    };
};
export type MembershipAdmission = {
    accountId: string;
    principal: MembershipPrincipal;
    key: string;
};
export type MembershipRelease = MembershipReservation & {
    key: string;
};
/** A source membership transaction is the resumable item cursor, not a claim of
 * whole-stream completeness. The coordinator persists its outer source cursor
 * only after this command commits; repeats return the same native receipt. */
export type MembershipBootstrapStep = MembershipAdmission & {
    sourceTransactionId: string;
};
export declare class MembershipLimitError extends Error {
    readonly code = "membership_limit";
    constructor();
}
export declare const MEMBERSHIP_INVERSE_DEPLOYMENT_BARRIER = "Stop all old membership writers before migration; backfill each authoritative membership change through stable source cursors, reconcile outstanding reservations, then certify each actor anchor complete before enabling inverse reads. Mixed-version writers are forbidden.";
export declare function MembershipInverseIncompleteError(): {
    new (): {
        readonly code: "membership_inverse_incomplete";
        name: string;
        message: string;
        stack?: string;
        cause?: unknown;
    };
    isError(error: unknown): error is Error;
    isError(value: unknown): value is Error;
    captureStackTrace(targetObject: object, constructorOpt?: Function): void;
    captureStackTrace(targetObject: object, constructorOpt?: Function): void;
    prepareStackTrace(err: Error, stackTraces: NodeJS.CallSite[]): any;
    stackTraceLimit: number;
};
export type MembershipInverseIncompleteError = InstanceType<ReturnType<typeof MembershipInverseIncompleteError>>;
/** Point-read the same registration/cut barrier without expanding the inverse.
 * A bounded personal inventory must check this even when its raw page is empty.
 */
export declare function requireMembershipInverseReady(client: AccessClient, input: {
    accountId: string;
    authnEpoch: number;
}): Promise<void>;
/** Exact actor-anchor superset read: never use its rows to prove membership.
 * Authorization must separately verify matched authoritative group memberships
 * at the attempt's T. Missing coverage, malformed rows and overflow deny access;
 * no LIMIT or role expansion can omit candidates or silently spend more slots.
 */
export declare function readMembershipInverse(client: AccessClient, input: {
    accountId: string;
}): Promise<readonly MembershipPrincipal[]>;
/** Trusted, deployment-owned Realm authority port. It must read exactly the
 * supplied Realm/member/reservation slot on this released connection and return
 * only committed, immutable terminal evidence; no timeout or missing row proves
 * termination. A Realm module must install this adapter before Realm release or
 * bootstrap is available. Reserve itself needs no Realm checkout or placement.
 */
export type RealmMembershipAuthority = Partial<RealmTransitionAuthority> & {
    readTerminal(client: AccessClient, input: MembershipReservation): Promise<(MembershipReservation & {
        transactionId: string;
    }) | null>;
    readChange(client: AccessClient, input: MembershipBootstrapStep): Promise<(MembershipBootstrapStep & {
        reservationId?: string | null;
    }) | null>;
};
/** INTERNAL service capability, like createLifecycleInternals; never mount this
 * factory or accept its configuration from HTTP. Inputs contain canonical actor
 * and group IDs, a durable idempotency key, and (release only) the exact returned
 * reservation ID. No LifecycleRequest is accepted: these are trusted workflow
 * steps, not permission-bearing public commands. Public membership publication
 * still uses LifecycleRequest and Access authorization on the organization.
 *
 * reserve -> authoritative join; authoritative leave/terminalization -> release.
 * Native lifecycle executor supplies identity-bound digest, fence, receipt,
 * authoritative T and outbox. Duplicate group admission shares its reservation,
 * even across role changes. Only the first admission spends a slot. Following a
 * Realm has no entry point here. All proof reads finish before actor checkout.
 *
 * bootstrapStep is one verified source change per command, resumable by its
 * stable source transaction/key. It does NOT mark completeness. Existing actors
 * stay closed until the separately deployed backfill coordinator satisfies
 * MEMBERSHIP_INVERSE_DEPLOYMENT_BARRIER. New accounts start complete only after
 * that deployment writer barrier. There is no request-time membership scan.
 */
export declare function createMembershipInverseCommands(config: {
    pool: Pool;
    clock?: () => Date;
    realmAuthority?: RealmMembershipAuthority;
    /** Preserve the existing lifecycle coordinator's receipt/event contract. */
    releaseCommandKind?: 'membership-coordination-released';
}): {
    reserve(input: MembershipAdmission): Promise<import("../command/command.ts").CommandOutcome<MembershipReservation & {
        sourceTransactionId?: string;
    }>>;
    release(input: MembershipRelease): Promise<import("../command/command.ts").CommandOutcome<{
        organizationId?: string;
        memberAccountId?: string;
        accountId: string;
        principal: {
            kind: 'organization' | 'realm';
            id: string;
        };
        reservationId: string;
        proofTransactionId: string;
    }>>;
    bootstrapStep(input: MembershipBootstrapStep): Promise<import("../command/command.ts").CommandOutcome<MembershipReservation & {
        sourceTransactionId?: string;
    }>>;
};
