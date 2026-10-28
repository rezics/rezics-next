import { type AvatarSummary } from '../content/avatar.ts';
import type { PublicViews } from './public-views.ts';
import type { Pool, PoolClient } from 'pg';
import type { KeyRing } from '../tokens/seal.ts';
import accountRead from './account-read.sql';
import organizationRoleRead from './account-organization-role.sql';
type Queryable = Pick<Pool | PoolClient, 'query'>;
type AccountRow = NonNullable<Awaited<ReturnType<typeof accountRead.run>>>;
/** Private authoritative row, including lifecycle's fenced flag; never a public profile. */
export type Account = Omit<AccountRow, 'minimumAuthnEpoch'> & {
    minimumAuthnEpoch: bigint;
};
export type AccountKind = Account['kind'];
export type AccountState = Account['state'];
export type OrganizationRole = NonNullable<Awaited<ReturnType<typeof organizationRoleRead.run>>>['role'];
export type PublicAccount = {
    accountId: string;
    kind: string;
    handle: string | null;
    displayName: string | null;
    avatarUrl: string | null;
    biography: string | null;
    state: string;
    operatorAccountId: string | null;
} | {
    accountId: string;
    kind: string;
    state: 'deleted';
};
export type DeletedPublicIdentity = {
    id: string;
    kind: 'actor' | 'organization';
    state: 'deleted';
    handle?: never;
    displayName?: never;
    automated?: never;
    operatorId?: never;
};
export type PublicIdentity = PublicIdentityFields | DeletedPublicIdentity;
export type PublicIdentityFields = {
    id: string;
    kind: 'actor' | 'organization';
    handle: string | null;
    displayName: string | null;
    state: 'active' | 'deleted';
    automated: boolean;
    operatorId: string | null;
};
export type AccountLink = {
    label: string;
    url: string;
};
export type AccountPublicViews = PublicViews & {
    realms: boolean;
};
export type PublicAccountProfile = PublicIdentityFields & {
    movedTo?: string;
    bio: string | null;
    links: AccountLink[];
    avatar: AvatarSummary | null;
    publicViews: AccountPublicViews;
    speakersListed?: boolean;
    subject: PublicSubject | null;
    verified: boolean;
};
export type PublicSubject = {
    id: string;
    label: string;
    type: string;
};
export type PublicHandleIdentity = PublicIdentityFields & {
    movedTo?: string;
    subject: PublicSubject | null;
    verified: boolean;
};
/** Resolve an active claim or live former-handle forward, then read the account on its own anchor. */
export declare function readPublicAccountByHandle(client: Pool, handle: string, at?: Date): Promise<(PublicIdentity | PublicHandleIdentity | PublicAccountProfile)[]>;
/** Resolve a verified catalogue subject through its pointer, then confirm it against the account authority. */
export declare function readPublicAccountByAgent(client: Pool, subjectId: string): Promise<(PublicIdentity | PublicHandleIdentity | PublicAccountProfile)[]>;
/** Internal Access/kernel point read: state, authentication floor and fence share one anchored row.
 * Trusted Auth composition must return unavailable for a fenced account before establishing a session.
 */
export declare function readAccount(client: Queryable, route: number, accountId: string): Promise<Account | null>;
/** Public allowlist; pending rows are hidden and deleted rows disclose only an identity tombstone. */
export declare function readPublicAccount(client: Queryable, route: number, accountId: string): Promise<PublicAccount | null>;
/** Public, bounded batch projection; callers pass request-ordered route and account ID arrays. */
export declare function readPublicIdentities(client: Queryable, routes: readonly number[], accountIds: readonly string[]): Promise<PublicIdentity[]>;
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
export {};
