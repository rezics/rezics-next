import type { Pool, PoolClient } from 'pg';
import type { KeyRing } from '../tokens/seal.ts';
import accountRead from './account-read.sql.d.ts';
import organizationRoleRead from './account-organization-role.sql.d.ts';
import { type AccessWorkAccounting } from './work.ts';
import type { AccountLink, AccountPublicViews, AvatarSummary, DeletedPublicIdentity, PublicAccount, PublicAccountProfile, PublicHandleIdentity, PublicIdentity, PublicIdentityFields, PublicSubject } from './public-identity.ts';
export type { AccountLink, AccountPublicViews, AvatarSummary, DeletedPublicIdentity, PublicAccount, PublicAccountProfile, PublicHandleIdentity, PublicIdentity, PublicIdentityFields, PublicSubject, };
type Queryable = Pick<Pool | PoolClient, 'query'>;
type AccountRow = NonNullable<Awaited<ReturnType<typeof accountRead.run>>>;
/** Private authoritative row, including lifecycle's fenced flag; never a public profile. */
export type Account = Omit<AccountRow, 'minimumAuthnEpoch'> & {
    minimumAuthnEpoch: bigint;
};
export type AccountKind = Account['kind'];
export type AccountState = Account['state'];
export type AccountCommandState = Readonly<{
    kind: AccountKind;
    state: AccountState;
    fenced: boolean;
    minimumAuthnEpoch: bigint;
}>;
export type OrganizationRole = NonNullable<Awaited<ReturnType<typeof organizationRoleRead.run>>>['role'];
/** Minimal native Account projection for command and private-read authorization. */
export declare function readAccountCommandState(client: Queryable, route: number, accountId: string, work?: AccessWorkAccounting): Promise<AccountCommandState | null>;
/** One current public identity plus the native facts needed to reobserve its avatar disclosure. */
export type PublicIdentityObservation = DeletedPublicIdentity | (PublicIdentityFields & {
    avatarMediaId: string | null;
    nativeState: 'active' | 'suspended';
    authnFenced: boolean;
});
/** Internal Access/kernel point read: state, authentication floor and fence share one anchored row.
 * Trusted Auth composition must return unavailable for a fenced account before establishing a session.
 */
export declare function readAccount(client: Queryable, route: number, accountId: string, work?: AccessWorkAccounting): Promise<Account | null>;
/** Public, bounded batch projection; callers pass request-ordered route and account ID arrays. */
export declare function readPublicIdentities(client: Queryable, routes: readonly number[], accountIds: readonly string[]): Promise<PublicIdentity[]>;
/**
 * Reads current public identities and only avatar references admitted by the active/unfenced predicate.
 * Result entries follow request order and repeat for duplicate IDs; native seeks are deduplicated.
 */
export declare function readPublicIdentityObservations(client: Queryable, accountIds: readonly string[]): Promise<PublicIdentityObservation[]>;
/** Reads a single member's role at the caller's authoritative request time on the organization anchor. */
export declare function readOrganizationRole(client: Queryable, route: number, organizationId: string, memberAccountId: string, at: Date): Promise<OrganizationRole | null>;
export type AgentPagesPage = {
    agentPages: {
        handle: string;
        kind: AccountKind;
        lastModified: string;
    }[];
    next: string | null;
};
/** One range of the index containing only indexable handle pages, with one lookahead entry. */
export declare function readAgentPages(client: Queryable, tokens: KeyRing, input: {
    cursor?: string;
    limit?: number;
    viewer?: string | null;
}, at?: Date): Promise<AgentPagesPage>;
