import type { Pool } from 'pg';
import type { MembershipWorkInput } from '@rezics/auth-contract';
import type { RealmMembershipTransition, RealmMembershipProof } from '../access/realm-membership-transition.ts';
import type { DurableInitiatorReader, DurableInitiatorRecord, DurableOperationAnchor, InitiatorRestorer } from '../access/durable-initiator.ts';
import type { LifecycleRequest } from '../access/lifecycle.ts';
import type { MembershipBootstrapStep, MembershipReservation } from '../access/membership-inverse.ts';
import type { RealmMembershipCommands } from '../access/membership-work.ts';
import type { RealmRoleReader } from '../access/permission.ts';
import type { Access, AccessClient } from '../request/access.ts';
import { type KeyRing } from '../tokens/seal.ts';
type MembershipInput = Extract<MembershipWorkInput, {
    kind: 'membership';
}>;
/** Shared by the HTTP issuer and the workflow authorizer. */
export declare const REALM_MEMBERSHIP_SEAL_SCOPE = "community.realm.membership";
export type MembershipOperationKind = 'join' | 'leave' | 'removal';
/** Command kind of each acceptance command. It is also the durable operation's kind. */
export declare const MEMBERSHIP_OPERATION_COMMANDS: {
    readonly join: 'community.realm.join';
    readonly leave: 'community.realm.leave';
    readonly removal: 'community.realm.removal';
};
/** The request's facts, committed with the operation. They carry no authority. */
export type MembershipOperationFacts = Readonly<{
    realmId: string;
    spaceId: string;
    memberAccountId: string;
    reservationId: string | null;
    banId: string | null;
}>;
/** Exact immutable source commitment: the operation, its creation target and the request's facts. */
export declare function membershipSourceDigest(operation: DurableOperationAnchor, target: DurableInitiatorRecord['creation']['target'], facts: MembershipOperationFacts): string;
/** The action the initiator holds on the Realm for this operation. */
export declare function membershipOperationAction(kind: MembershipOperationKind, initiatorAccountId: string, memberAccountId: string): 'realm:ban' | 'realm:join' | 'realm:manage';
/** Realm owners are identity grants, not membership rows. */
export declare class RealmMembershipRoleError extends Error {
    readonly code = "realm_owner_membership";
    constructor();
}
export type RealmMembershipDependencies = {
    pool: Pool;
    access: Access;
    clock: () => Date;
    /** Real wall time for request deadlines, supplied by composition. */
    deadlineNow: () => number;
    /** Session key ring shared with HTTP. Authorize denies when it is absent. */
    referenceKeys?: KeyRing;
    /** Restores the initiator of a sealed workflow at every step. Without it, sealed steps fail closed. */
    restorer?: InitiatorRestorer;
};
export declare class LegacyMembershipPendingError extends Error {
    readonly state: 'pending' | 'uncertain';
    constructor(state: 'pending' | 'uncertain');
}
export type RealmMembership = RealmMembershipCommands & {
    roleReader: RealmRoleReader;
};
/** Reads the committed operation and its creation receipt on the caller's connection. */
export declare const readMembershipInitiator: DurableInitiatorReader;
/** Accounts owns the workflow. This adapter publishes and proves the Realm side. */
export declare function createRealmMembership(config: RealmMembershipDependencies): {
    authority: {
        readTerminal: (client: AccessClient, input: MembershipReservation) => Promise<{
            accountId: string;
            principal: {
                kind: 'realm';
                id: string;
            };
            reservationId: string;
            transactionId: string;
        } | null>;
        readChange: (client: AccessClient, input: MembershipBootstrapStep) => Promise<{
            accountId: string;
            principal: {
                kind: 'realm';
                id: string;
            };
            key: string;
            sourceTransactionId: string;
            reservationId: string;
        } | null>;
        readTransition: (client: AccessClient, input: RealmMembershipTransition) => Promise<RealmMembershipProof | null>;
    };
    cancel: (reservation: RealmMembershipTransition, key: string) => Promise<import("../command/command.ts").CommandOutcome<unknown> | RealmMembershipProof>;
    certifyLegacy: (reservation: RealmMembershipTransition, key: string) => Promise<"cancelled" | "published">;
    authorize: (reference: string, input: MembershipWorkInput) => Promise<LifecycleRequest>;
    publish: (request: LifecycleRequest, input: MembershipInput, reservation: MembershipReservation, key: string) => Promise<import("../command/command.ts").CommandOutcome<{
        realmId: string;
        accountId: string;
        reservationId: string;
        role: "member" | null;
        at: string;
        transactionId: string;
        publicationTransactionId?: string;
        transition?: {
            generationId: string;
            operationId: string;
            outcome: 'published';
        };
    }>>;
    terminalize: (reservation: MembershipReservation, key: string) => Promise<import("../command/command.ts").CommandOutcome<{
        realmId: string;
        accountId: string;
        reservationId: string;
        transactionId: string;
        at: string;
    } | {
        realmId: string;
        accountId: string;
        reservationId: string;
        transactionId: string;
        at: string;
        publicationTransactionId: null;
        transition: {
            generationId: string;
            operationId: string;
            outcome: 'cancelled';
        };
    }>>;
    roleReader: import("../request/access.ts").AccessRealmRoleReader;
};
/** One point read of the account's open Realm interval. No member scan. */
export declare function readRealmMembershipInterval(pool: Pool, realmId: string, accountId: string, at: string): Promise<{
    since: string;
    reservationId: string;
} | null>;
export {};
