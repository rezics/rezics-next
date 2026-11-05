import { type AccessWorkProducer } from './work.ts';
import { type ContentEditionBuyerFactReader } from './authenticated-benefit.ts';
import { type PermissionAccount } from './account-authority.ts';
import { type Account } from './account-data.ts';
import { type AuthoritativeTime } from '../command/command.ts';
import { type ResourcePage, type AccessRealmRoleReader, type ReadDecisions, type Access, type AccessClient, type AccessContext, type AccessCheck, type AccountActor, type ActionCatalogue, type Actor, type Resource } from '../request/access.ts';
import { type ResourceRoleCatalogue } from './resource-roles.ts';
import { type KindOriginalProducer } from './kind-audience-original.ts';
/** Kernel-owned request evidence, populated by the one authoritative actor point read.
 * Identity and this record must come from verified Auth/Access, never request JSON.
 */
export type PermissionContext = AccessContext & {
    account?: Account | null;
};
export type PermissionConfig = {
    /** Private installed-authenticator association for Kind originals only. */
    kindOriginal?: KindOriginalProducer;
    actions: ActionCatalogue;
    resourceRoles?: ResourceRoleCatalogue | undefined;
    /** Retrieve the already-read account from the request; do not query again here. */
    accountEvidence: (actor: AccountActor, context: PermissionContext) => PermissionAccount | null | undefined;
    authenticate?: Access['authenticate'];
    /** Private, per-factory standing evidence shared with the main Access adapter. */
    standingAccounts?: WeakMap<AccountActor, PermissionAccount>;
    /** Server-owned Realm integration. Read only this Realm/member anchor on the
     * supplied released connection. Return positive and negative proofs for the existing ACL subject roles
     * using native current/next temporal seeks, never an interval-history scan.
     * Proof validity ends at the next authoritative temporal transition.
     * Following is not membership. Missing verifier or required proof denies.
     */
    realmRoleReader?: RealmRoleReader;
    contentEditionBuyerFactReader?: ContentEditionBuyerFactReader;
    contentEditionBuyerFactWork?: AccessWorkProducer<Parameters<ContentEditionBuyerFactReader>[0], Awaited<ReturnType<ContentEditionBuyerFactReader>>>;
    /** Outside a command, bind this instant. Absent uses PostgreSQL clock_timestamp(). */
    clock?: () => Date;
};
export type MembershipRoleProof = {
    role: 'owner' | 'member';
    member: boolean;
    valid: string;
};
export type RealmRoleReader = AccessRealmRoleReader;
export declare function readDecisionTime(handle: ReadDecisions): AuthoritativeTime | undefined;
export declare function authorizePreparedReadGate(handle: ReadDecisions, client: AccessClient, action: string, clientAction: string, resource: Resource): Promise<boolean>;
/** Internal evidence lifetime for separately anchored command proofs. This is
 * read from the opaque registry, never from caller-supplied authorization JSON.
 */
export declare function permissionEvidenceDeadline(evidence: unknown): number | undefined;
/** Exact native identity projection; reconstructed Actors and JSON have no entry. */
export declare function permissionHistoryAccounts(evidence: unknown, actor: Actor, action: string, resource: Resource, page?: ResourcePage): readonly Readonly<{
    accountRoute: number;
    accountId: string;
    roles: number;
}>[] | undefined;
/** Runs only the final resource-anchored statement on the command's own client.
 * Reuse through accessCheck so every actual command attempt checks current rows/time.
 */
export declare function checkPermission(client: AccessClient, actor: Actor, action: string, resource: Resource, evidence?: unknown, time?: AuthoritativeTime, clock?: () => Date): Promise<boolean>;
/** Thin Access adapter. Auth and the kernel request hook are separate bindings. */
export declare function createAccess(config: PermissionConfig): Access;
/** Prepare each proposed permission before checkout, then check all of them on
 * every attempt. This deliberately provides no grant mutation or HTTP helper.
 * The command separately checks its registered grant-management action.
 */
export declare function checkDelegationBounds(access: Access, actor: Actor, actions: readonly string[], resource: Resource, context: AccessContext): Promise<AccessCheck>;
