import { type AuthoritativeTime } from '../command/command.ts';
import type { Access, AccessClient, Resource } from '../request/access.ts';
export declare const REALM_OWNER_ROLE = "community.realm.owner";
type Input = {
    resource: Resource;
    accountId: string;
    at: AuthoritativeTime;
};
type RoleReadInput = Input & {
    /** Trusted service composition. Without it only built-in definitions apply.
     * A role name in a grant row never installs a role or supplies its actions. */
    access?: Access;
};
/** Private direct-role data for a read already authorized by the caller. Five exact
 * temporal key probes, at most five rows; no account, group or membership expansion.
 * Account lifecycle is deliberately not authorization in this data port.
 */
export declare function readRealmOwnershipRoles(client: AccessClient, input: RoleReadInput): Promise<readonly {
    role: string;
    rank: number;
    valid: string;
}[]>;
/** Lock the native creation anchor, never a parallel owner registry. The caller
 * must already have authorized this exact resource in the live command at T.
 */
export declare function lockRealmOwnership(client: AccessClient, input: Input): Promise<void>;
/** Native explicit-holder invariant. The lock and the bounded holder predicate
 * stay in the same SERIALIZABLE command as the removal. Never call this as a
 * preflight on a pool: that would release the invariant before publication.
 * Both probes use the same authoritative T. The remaining holder must have an
 * open-ended interval; a scheduled expiry cannot guarantee owner continuity.
 * SERIALIZABLE retries recheck the predicates after concurrent grant changes.
 */
export declare function assertRealmOwnerMayLeave(client: AccessClient, input: Input): Promise<void>;
export {};
