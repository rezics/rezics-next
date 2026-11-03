import type { Pool } from 'pg';
import { type AuthoritativeTime, type CommandAttempt, type CommandAuthorization, type CommandTransaction } from '../command/command.ts';
import type { Access, AccessClient, Resource } from '../request/access.ts';
export { RealmLastOwnerError } from './resource-access-errors.ts';
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
export type RealmErasureSuccessionInput = Readonly<{
    resource: Resource;
    accountId: string;
}>;
export type RealmErasureSuccessionQualification = 'owner-or-replay' | 'not-owner';
export type RealmErasureSuccessionSource = Readonly<{
    route: number;
    accountId: string;
    version: number;
    at: string;
}>;
declare const preparedRealmErasure: unique symbol;
/** Opaque, constructor-local evidence from one genuine executor attempt. */
export type PreparedRealmErasureSuccession = Readonly<{
    [preparedRealmErasure]: true;
}>;
type DecisionBasis = Readonly<{
    /** Historical replay is durable output, never a new current-tx applied proof. */
    replayed: boolean;
    resource: Resource;
    source: RealmErasureSuccessionSource;
    operationId: string;
    decidedAt: string;
}>;
/** Content consumes a terminal decision inside the SAME Realm transaction, before commit.
 * Orphan generation and claim deadline are Content-owned, not fields invented by Access.
 */
export type RealmErasureSuccessionResult = (DecisionBasis & Readonly<{
    status: 'owned';
    accountId: string;
    disposition: 'retained' | 'selected';
}>) | (DecisionBasis & Readonly<{
    status: 'orphaned';
}>) | Readonly<{
    status: 'pending';
    reason: 'more' | 'role-source' | 'account-source';
}>;
export type RealmErasureSuccessionAuthorization = CommandAuthorization & {
    prepare(attempt: CommandAttempt): Promise<PreparedRealmErasureSuccession>;
};
export type AppliedRealmErasureSuccession = Readonly<{
    state: 'owned' | 'orphaned';
    orphanedAt: string | null;
    claimEligibleAt: string | null;
}>;
export declare function readAppliedRealmErasureSuccession(tx: CommandTransaction, input: Readonly<{
    realmId: string;
    accountId: string;
}>): Promise<AppliedRealmErasureSuccession | null>;
/** Trusted native composition only. No Actor, Global action, approval or participant ACK.
 * The constructor's authorization uses the installed executor's prepare/authorize/finalize
 * lifecycle; it neither forges completed authorization branding nor holds a source checkout
 * while acquiring the Realm writer. Content remains the sole lifecycle consumer.
 */
export declare function createRealmOwnershipCommands(config: {
    pool: Pool;
    access: Access;
    clock?: () => Date;
}): {
    qualifyErasureSuccession: (input: RealmErasureSuccessionInput, context: Readonly<{
        deadline: number;
    }>) => Promise<RealmErasureSuccessionQualification>;
    prepareErasureSuccession: (attempt: CommandAttempt, input: RealmErasureSuccessionInput) => Promise<PreparedRealmErasureSuccession>;
    applyErasureSuccession: (tx: CommandTransaction, proof?: PreparedRealmErasureSuccession) => Promise<RealmErasureSuccessionResult>;
    erasureSuccessionAuthorization: (input: RealmErasureSuccessionInput) => RealmErasureSuccessionAuthorization;
};
