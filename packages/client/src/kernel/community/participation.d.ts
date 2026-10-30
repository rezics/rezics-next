import type { Pool } from 'pg';
import { type AuthoritativeTime, type CommandTransaction } from '../command/command.ts';
import { type Access, type AccessClient, type Actor, type Resource } from '../request/access.ts';
export type RealmParticipationReadDecision = {
    readable?: boolean;
};
export type RealmParticipationCheck = (client: AccessClient, input: Readonly<{
    realmId: string;
    actor: Actor;
    readDecision?: RealmParticipationReadDecision;
}>, time?: AuthoritativeTime) => Promise<boolean>;
export type RealmParticipationResult = Readonly<{
    realmId: string | null;
    allowed: boolean;
    readable: boolean | undefined;
}>;
/** Prepare participation and its separate Realm read result before the caller
 * checks out its content anchor. Both decisions belong to the supplied command T.
 */
export declare function prepareRealmParticipationResult(pool: Pool, check: RealmParticipationCheck | undefined, actor: Actor, realmId: string | null, time: AuthoritativeTime, deadline: number): Promise<RealmParticipationResult>;
/** The native participation eligibility shared by checks and parent validation. */
export declare function realmParticipationAnchor(resource: Resource): {
    resource: {
        eligibility: import("../access/eligibility.ts").ResourceEligibility;
        route: number;
        id: string;
        anonymousEligibility?: import("../access/eligibility.ts").ResourceEligibility;
    };
    visibility: () => "protected" | "public" | null;
};
/** Checks participation and the independent Realm read anchor at one T.
 * The participation action uses its exact denial check. A protected Realm also
 * requires realm:read, while the single Realm head read supplies public eligibility.
 * Outside a command, both checks share one read time from the kernel clock.
 */
export declare function createRealmParticipationCheck(input: {
    pool: Pool;
    access: Access;
    clock?: () => Date;
}): RealmParticipationCheck;
/** Installs the Realm's member-group role only while the Realm is protected.
 * The command must already be authorized against this exact Realm.
 */
export declare function ensureRealmMemberGrant(tx: CommandTransaction, input: Readonly<{
    realmId: string;
}>): Promise<void>;
