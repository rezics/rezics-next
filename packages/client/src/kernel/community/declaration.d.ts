import { COMMUNITY_EVENTS } from './events.ts';
import { type RealmMembershipDependencies } from './membership.ts';
import { createRealmParticipationCheck } from './participation.ts';
import type { CommunityAmbient } from './contract/index.ts';
export { systemCommunityAmbient, type CommunityAmbient } from './ambient.ts';
/**
 * Community's worker-side and shared declaration: one value composition consumes.
 * Constructing it runs nothing. The work module registers only when the work runtime composes it,
 * and the event catalogue reads `events`. Membership and participation are the access capability;
 * `effects` is the declared effect list. Every reader Community hands out shares `ambient.deadlineNow`.
 */
export declare function createCommunityDeclaration(ambient: CommunityAmbient): Readonly<{
    name: 'community';
    ambient: Readonly<{
        deadlineNow: import("./contract/vocabulary.ts").CommunityDeadlineNow;
    }>;
    work: import("../work/registry.ts").WorkModule;
    events: typeof COMMUNITY_EVENTS;
    effects: import("./contract/ports.ts").CommunityDeclaredEffects;
    createMembership(dependencies: Omit<RealmMembershipDependencies, 'deadlineNow'>): {
        authority: {
            readTerminal: (client: import("../request/access.ts").AccessClient, input: import("../access/membership-inverse.ts").MembershipReservation) => Promise<{
                accountId: string;
                principal: {
                    kind: 'realm';
                    id: string;
                };
                reservationId: string;
                transactionId: string;
            } | null>;
            readChange: (client: import("../request/access.ts").AccessClient, input: import("../access/membership-inverse.ts").MembershipBootstrapStep) => Promise<{
                accountId: string;
                principal: {
                    kind: 'realm';
                    id: string;
                };
                key: string;
                sourceTransactionId: string;
                reservationId: string;
            } | null>;
            readTransition: (client: import("../request/access.ts").AccessClient, input: import("../access/realm-membership-transition.ts").RealmMembershipTransition) => Promise<import("../access/realm-membership-transition.ts").RealmMembershipProof | null>;
        };
        cancel: (reservation: import("../access/realm-membership-transition.ts").RealmMembershipTransition, key: string) => Promise<import("../command/command.ts").CommandOutcome<unknown> | import("../access/realm-membership-transition.ts").RealmMembershipProof>;
        certifyLegacy: (reservation: import("../access/realm-membership-transition.ts").RealmMembershipTransition, key: string) => Promise<"cancelled" | "published">;
        authorize: (reference: string, input: import("@rezics/auth-contract").MembershipWorkInput) => Promise<import("../access/lifecycle.ts").LifecycleRequest>;
        publish: (request: import("../access/lifecycle.ts").LifecycleRequest, input: {
            kind: 'membership';
            principal: import("@rezics/auth-contract").MembershipPrincipal;
            memberAccountId: string;
            role: 'owner' | 'member' | null;
            reservationId?: string;
            authorization: string;
        }, reservation: import("../access/membership-inverse.ts").MembershipReservation, key: string) => Promise<import("../command/command.ts").CommandOutcome<{
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
        terminalize: (reservation: import("../access/membership-inverse.ts").MembershipReservation, key: string) => Promise<import("../command/command.ts").CommandOutcome<{
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
    createParticipation(input: Omit<Parameters<typeof createRealmParticipationCheck>[0], 'deadlineNow'>): import("./participation.ts").RealmParticipationCheck;
}>;
export type CommunityDeclaration = ReturnType<typeof createCommunityDeclaration>;
