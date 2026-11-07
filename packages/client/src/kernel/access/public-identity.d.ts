import type { Pool, PoolClient } from 'pg';
import type { AvatarSummary } from './contract/index.ts';
import { contributionAttribution, contributionFromPublicIdentity, ContributionAttributionSchema, contributionDeleted, type ContributionAttribution, type ContributionIdentity, type DeletedContributionAttribution, type LiveContributionAttribution } from './contribution-attribution.ts';
import type { PublicViews } from './public-views.ts';
export type { AvatarSummary };
export { contributionAttribution, contributionDeleted, contributionFromPublicIdentity, ContributionAttributionSchema, type ContributionAttribution, type ContributionIdentity, type DeletedContributionAttribution, type LiveContributionAttribution, };
type Queryable = Pick<Pool | PoolClient, 'query'>;
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
};
export type PublicIdentity = PublicIdentityFields | DeletedPublicIdentity;
export type PublicIdentityFields = {
    id: string;
    kind: 'actor' | 'organization';
    handle: string | null;
    displayName: string | null;
    state: 'active';
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
/** Resolve an active claim or live former-handle forward, then read the account on its own anchor. */
export declare function readPublicAccountByHandle(client: Pool, handle: string, at?: Date): Promise<(PublicIdentity | PublicHandleIdentity | PublicAccountProfile)[]>;
/** Resolve a stored catalogue pointer or native graph link, then confirm current account authority. */
export declare function readPublicAccountByAgent(client: Pool, subjectId: string): Promise<(PublicIdentity | PublicHandleIdentity | PublicAccountProfile)[]>;
/** Bounded current attribution for a retained-contribution page, including unavailable owners.
 * Deduplicate seeks without changing identity: no label/handle search or graph redirect is involved.
 * Each native batch contains at most 100 Account anchors; errors retain the owner's normal failure semantics.
 */
export declare function readContributionAttributions(client: Queryable, accountIds: readonly string[]): Promise<Map<string, ContributionAttribution>>;
/** Resolve retained attribution through the exact bounded native owner relation.
 * Public profile absence is not deletion; only the anchored account tombstone is.
 * This does not compose avatar, biography, graph labels or account-page disclosure.
 */
export declare function agentContributionAttribution(client: Queryable, subjectId: string): Promise<ContributionAttribution>;
/** Public allowlist; pending rows are hidden and deleted rows disclose only an identity tombstone. */
export declare function readPublicAccount(client: Queryable, route: number, accountId: string): Promise<PublicAccount | null>;
