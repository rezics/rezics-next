import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { routeOf } from '../route/route.ts';
import { tryAccessApplication } from './adapters/bind.ts';
import type { AccessQueryClient, AvatarSummary } from './contract/index.ts';
import {
  contributionAttribution,
  contributionFromPublicIdentity,
  ContributionAttributionSchema,
  contributionDeleted,
  type ContributionAttribution,
  type ContributionIdentity,
  type DeletedContributionAttribution,
  type LiveContributionAttribution,
} from './contribution-attribution.ts';
import type { PublicViews } from './public-views.ts';
import handleRead from './lifecycle-handle-read.sql';
import publicRead from './account-public-read.sql';
import agentPageRead from './agent-verification-page-read.sql';
import publicPage from './public-identity-page.sql';

export type { AvatarSummary };
export {
  contributionAttribution,
  contributionDeleted,
  contributionFromPublicIdentity,
  ContributionAttributionSchema,
  type ContributionAttribution,
  type ContributionIdentity,
  type DeletedContributionAttribution,
  type LiveContributionAttribution,
};

type Queryable = Pick<Pool | PoolClient, 'query'>;

export type PublicAccount =
  | {
      accountId: string;
      kind: string;
      handle: string | null;
      displayName: string | null;
      avatarUrl: string | null;
      biography: string | null;
      state: string;
      operatorAccountId: string | null;
    }
  | { accountId: string; kind: string; state: 'deleted' };

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

export type AccountLink = { label: string; url: string };
export type AccountPublicViews = PublicViews & { realms: boolean };
export type PublicSubject = { id: string; label: string; type: string };
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

function identitySemantic() {
  return tryAccessApplication()?.ports.identity;
}

function boundAccountAgentId(accountId: string): string | undefined {
  return identitySemantic()?.accountAgentId(accountId);
}

async function boundAgentsForSubjects(client: Queryable, subjects: readonly string[]) {
  return (await identitySemantic()?.accountAgentsForSubjects(client as AccessQueryClient, subjects)) ?? new Map();
}

/** Resolve an active claim or live former-handle forward, then read the account on its own anchor. */
export async function readPublicAccountByHandle(
  client: Pool,
  handle: string,
  at = new Date(),
): Promise<(PublicIdentity | PublicHandleIdentity | PublicAccountProfile)[]> {
  const route = createHash('sha256').update(handle).digest().readUInt16BE(0);
  const claim = await handleRead.run(client, { route, handle });
  if (!claim) return [];
  const forwards = claim.formerUntil !== null && Date.parse(claim.formerUntil) > at.getTime();
  if (claim.state !== 'active' && !forwards) return [];
  const row = await publicRead.run(client, { route: routeOf(claim.accountId)!, account_id: claim.accountId });
  if (!row || row.state === 'pending' || row.state === 'deleted') return [];
  // An active claim names the account's current spelling only; a stale claim must not stand in for it.
  if (claim.state === 'active' && row.handle !== handle) return [];
  if (forwards && (row.state !== 'active' || row.handle === null || row.handle === handle)) return [];
  return publicIdentityForAccount(client, row, forwards ? row.handle! : undefined);
}

/** Resolve a stored catalogue pointer or native graph link, then confirm current account authority. */
export async function readPublicAccountByAgent(
  client: Pool,
  subjectId: string,
): Promise<(PublicIdentity | PublicHandleIdentity | PublicAccountProfile)[]> {
  const route = routeOf(subjectId);
  if (route === null) return [];
  const pointer = await agentPageRead.run(client, {
    route,
    subject_id: subjectId,
  });
  const native = pointer ? undefined : (await boundAgentsForSubjects(client, [subjectId])).get(subjectId);
  // Only an exact, unmerged native graph link admits an unverified agent. A
  // missing catalogue verification never permits inferring its account identity.
  if (!pointer && (!native || native.verified || native.subject !== subjectId || native.agent_id !== subjectId))
    return [];
  const accountId = pointer?.accountId ?? native!.account;
  const accountRoute = routeOf(accountId);
  if (accountRoute === null) return [];
  const row = await publicRead.run(client, {
    route: accountRoute,
    account_id: accountId,
  });
  if (!row || row.state !== 'active') return [];
  if (
    pointer
      ? !row.agentVerified || row.agentSubjectId !== subjectId
      : row.agentVerified || boundAccountAgentId(row.accountId) !== subjectId
  )
    return [];
  const identity = await publicIdentityForAccount(client, row);
  // Native resolution also requires the current visible graph subject.
  return pointer || identity.some((value) => 'subject' in value && value.subject?.id === subjectId) ? identity : [];
}

/** Bounded current attribution for a retained-contribution page, including unavailable owners.
 * Deduplicate seeks without changing identity: no label/handle search or graph redirect is involved.
 * Each native batch contains at most 100 Account anchors; errors retain the owner's normal failure semantics.
 */
export async function readContributionAttributions(
  client: Queryable,
  accountIds: readonly string[],
): Promise<Map<string, ContributionAttribution>> {
  const result = new Map<string, ContributionAttribution>();
  const anchors: { id: string; route: number }[] = [];
  for (const id of new Set(accountIds)) {
    result.set(id, null);
    const route = routeOf(id);
    if (route !== null) anchors.push({ id, route });
  }
  for (let offset = 0; offset < anchors.length; offset += 100) {
    const page = anchors.slice(offset, offset + 100);
    const identities = await readPublicIdentityPage(
      client,
      page.map(({ route }) => route),
      page.map(({ id }) => id),
    );
    for (const identity of identities) result.set(identity.id, contributionFromPublicIdentity(identity));
  }
  return result;
}

/** Resolve retained attribution through the exact bounded native owner relation.
 * Public profile absence is not deletion; only the anchored account tombstone is.
 * This does not compose avatar, biography, graph labels or account-page disclosure.
 */
export async function agentContributionAttribution(
  client: Queryable,
  subjectId: string,
): Promise<ContributionAttribution> {
  const route = routeOf(subjectId);
  if (route === null) return null;
  const pointer = await agentPageRead.run(client, { route, subject_id: subjectId });
  const native = pointer ? undefined : (await boundAgentsForSubjects(client, [subjectId])).get(subjectId);
  const accountId = pointer?.accountId ?? native?.account;
  if (!accountId) return null;
  const accountRoute = routeOf(accountId);
  if (accountRoute === null) return null;
  const row = await publicRead.run(client, { route: accountRoute, account_id: accountId });
  if (!row) return null;
  // A stale catalogue page cannot assign a live contribution to a different current binding.
  if (row.state !== 'deleted' && pointer && (!row.agentVerified || row.agentSubjectId !== subjectId)) return null;
  return contributionAttribution(row);
}

/** Public allowlist; pending rows are hidden and deleted rows disclose only an identity tombstone. */
export async function readPublicAccount(
  client: Queryable,
  route: number,
  accountId: string,
): Promise<PublicAccount | null> {
  const row = await publicRead.run(client, { route, account_id: accountId });
  if (!row || row.state === 'pending') return null;
  if (row.state === 'deleted') return { accountId: row.accountId, kind: row.kind, state: 'deleted' };
  return {
    accountId: row.accountId,
    kind: row.kind,
    handle: row.handle,
    displayName: row.displayName,
    avatarUrl: row.avatarUrl,
    biography: row.biography,
    state: row.state,
    operatorAccountId: row.operatorAccountId,
  };
}

async function readPublicIdentityPage(
  client: Queryable,
  routes: readonly number[],
  accountIds: readonly string[],
): Promise<PublicIdentity[]> {
  const anchors = new Map<number, string[]>();
  for (const [index, route] of routes.entries()) {
    const ids = anchors.get(route) ?? [];
    ids.push(accountIds[index]!);
    anchors.set(route, ids);
  }
  const found = new Map<string, PublicIdentity>();
  for (const [route, ids] of anchors) {
    const rows = await publicPage.run(client, { route, account_ids: ids });
    for (const row of rows)
      found.set(
        `${route}:${row.id}`,
        row.state === 'deleted'
          ? { id: row.id, kind: row.kind, state: 'deleted' }
          : {
              ...row,
              kind: row.kind === 'organization' ? 'organization' : 'actor',
              state: 'active',
            },
      );
  }
  return routes.flatMap((route, index) => {
    const row = found.get(`${route}:${accountIds[index]}`);
    return row ? [row] : [];
  });
}

async function publicIdentityForAccount(
  client: Pool,
  row: NonNullable<Awaited<ReturnType<typeof publicRead.run>>>,
  movedTo?: string,
): Promise<(PublicIdentity | PublicHandleIdentity | PublicAccountProfile)[]> {
  if (row.state === 'deleted') return [{ id: row.accountId, kind: row.kind, state: 'deleted' }];
  const identity: PublicIdentityFields & { movedTo?: string } = {
    id: row.accountId,
    kind: row.kind === 'organization' ? 'organization' : 'actor',
    handle: row.handle,
    displayName: row.displayName,
    state: 'active',
    automated: row.operatorAccountId !== null,
    operatorId: row.operatorAccountId,
    ...(movedTo ? { movedTo } : {}),
  };
  const subjectId = row.agentVerified ? row.agentSubjectId : boundAccountAgentId(row.accountId);
  let subject: PublicSubject | null = null;
  if (subjectId !== undefined && subjectId !== null) {
    const [{ readItemTypes, readLabels }, { subjectLabel }] = await Promise.all([
      import('../semantic/subject.ts'),
      import('../semantic/link-keys.ts'),
    ]);
    const [labels, types] = await Promise.all([readLabels(client, [subjectId]), readItemTypes(client, [subjectId])]);
    const labelSet = labels.get(subjectId);
    const type = types.get(subjectId);
    const label = labelSet ? subjectLabel(labelSet) : '';
    if (type && label) subject = { id: subjectId, label, type };
  }
  const avatar = row.avatar
    ? ((await tryAccessApplication()?.readAvatarSummaries(client, [row.avatar]))?.get(row.avatar) ?? null)
    : null;
  return [
    {
      ...identity,
      bio: row.biography,
      links: row.links as AccountLink[],
      avatar,
      publicViews: row.publicViews as AccountPublicViews,
      ...(row.kind === 'organization' ? { speakersListed: row.speakersListed } : {}),
      subject,
      verified: row.agentVerified,
    },
  ];
}
