import type { Pool } from 'pg';
import type { AccessClient } from '../request/access.ts';
import type { MembershipReservation } from './membership-inverse.ts';
export type RealmMembershipTransition = MembershipReservation & {
    transition: {
        generationId: string;
        operationId: string;
    };
};
export type RealmMembershipProof = RealmMembershipTransition & {
    transactionId: string;
    outcome: 'published' | 'cancelled';
    publicationTransactionId: string | null;
};
export type RealmTransitionAuthority = {
    readTransition(client: AccessClient, input: RealmMembershipTransition): Promise<RealmMembershipProof | null>;
};
export declare function transitionParameters(input: RealmMembershipTransition): {
    route: number;
    account_id: string;
    realm_id: string;
    reservation_id: string;
    generation_id: string;
    operation_id: string;
};
export declare function first<T>(value: T | readonly T[] | null): T | null;
/** A released exact preflight, never held across the foreign command. Source
 * proof uniqueness serializes a delayed publisher against consume/cancellation. */
export declare function isRealmTransitionOpen(pool: Pool, input: RealmMembershipTransition, deadline?: number): Promise<boolean>;
export declare function createRealmMembershipTransitions(config: {
    pool: Pool;
    authority: RealmTransitionAuthority;
    clock?: () => Date;
}): {
    proof: (input: RealmMembershipTransition, deadline?: number) => Promise<RealmMembershipProof | null>;
    consume(input: RealmMembershipTransition & {
        key: string;
        proofTransactionId?: string;
    }): Promise<import("../command/command.ts").CommandOutcome<{
        accountId: string;
        principal: import("./membership-inverse.ts").MembershipPrincipal;
        reservationId: string;
        transition: {
            generationId: string;
            operationId: string;
        } & {
            generationId: string;
            operationId: string;
        };
        proofTransactionId: string;
        outcome: "cancelled" | "published";
    }>>;
};
