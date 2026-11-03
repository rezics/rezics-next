import { readAvatarSummaries, type AvatarSummary } from '../content/avatar.ts';
import type { PublicViews } from './public-views.ts';
import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { routeOf } from '../route/route.ts';
import handleRead from './lifecycle-handle-read.sql';
import agentPagesPage from './agent-pages-page.sql';
import { decodeListCursor, encodeListCursor } from '../tokens/list-cursor.ts';
import type { KeyRing } from '../tokens/seal.ts';
import { ProblemError } from '../http/problem.ts';
import accountRead from './account-read.sql';
import publicPage from './public-identity-page.sql';
import publicRead from './account-public-read.sql';
import agentPageRead from './agent-verification-page-read.sql';
import organizationRoleRead from './account-organization-role.sql';
import { accountAgentId, accountAgentsForSubjects } from '../semantic/agents.ts';
import { accessNativeWork, type AccessWorkAccounting } from './work.ts';

type Queryable = Pick<Pool | PoolClient, 'query'>;
type AccountRow = NonNullable<Awaited<ReturnType<typeof accountRead.run>>>;

/** Private authoritative row, including lifecycle's fenced flag; never a public profile. */
export type Account = Omit<AccountRow, 'minimumAuthnEpoch'> & {
  minimumAuthnEpoch: bigint;
};
export type AccountKind = Account['kind'];
export type AccountState = Account['state'];
export type OrganizationRole = NonNullable<Awaited<ReturnType<typeof organizationRoleRead.run>>>['role'];

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
export type PublicSubject = { id: string; label: string; type: string };
export type PublicHandleIdentity = PublicIdentityFields & {
  movedTo?: string;
  subject: PublicSubject | null;
  verified: boolean;
};

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
  const native = pointer ? undefined : (await accountAgentsForSubjects(client, [subjectId])).get(subjectId);
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
      : row.agentVerified || accountAgentId(row.accountId) !== subjectId
  )
    return [];
  const identity = await publicIdentityForAccount(client, row);
  // Native resolution also requires the current visible graph subject.
  return pointer || identity.some((value) => 'subject' in value && value.subject?.id === subjectId) ? identity : [];
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
  const subjectId = row.agentVerified ? row.agentSubjectId : accountAgentId(row.accountId);
  let subject: PublicSubject | null = null;
  if (subjectId !== null) {
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
  const avatar = row.avatar ? ((await readAvatarSummaries(client, [row.avatar])).get(row.avatar) ?? null) : null;
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

/** Internal Access/kernel point read: state, authentication floor and fence share one anchored row.
 * Trusted Auth composition must return unavailable for a fenced account before establishing a session.
 */
export async function readAccount(
  client: Queryable,
  route: number,
  accountId: string,
  work?: AccessWorkAccounting,
): Promise<Account | null> {
  const input = { route, account_id: accountId };
  const row = await accessNativeWork(work, 'account-state', input, { targets: 1 }, () =>
    accountRead.run(client, input),
  );
  if (!row) return null;
  return { ...row, minimumAuthnEpoch: BigInt(row.minimumAuthnEpoch) };
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

/** Public, bounded batch projection; callers pass request-ordered route and account ID arrays. */
export async function readPublicIdentities(
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

/** Reads a single member's role at the caller's authoritative request time on the organization anchor. */
export async function readOrganizationRole(
  client: Queryable,
  route: number,
  organizationId: string,
  memberAccountId: string,
  at: Date,
): Promise<OrganizationRole | null> {
  const row = await organizationRoleRead.run(client, {
    route,
    organization_id: organizationId,
    member_account_id: memberAccountId,
    at: at.toISOString(),
  });
  return row?.role ?? null;
}

// Future Access commands own operator eligibility/transfer/deletion, automation membership rules,
// the last-owner invariant, handle-claim workflows and the Access-before-Auth fence sequence.
// This adapter deliberately exposes reads only; cross-account facts are not local schema guarantees.

export type AgentPagesPage = {
  agentPages: { handle: string; kind: AccountKind; lastModified: string }[];
  next: string | null;
};
/** One range of the index containing only indexable handle pages, with one lookahead entry. */
export async function readAgentPages(
  client: Queryable,
  tokens: KeyRing,
  input: { cursor?: string; limit?: number; viewer?: string | null },
  at = new Date(),
): Promise<AgentPagesPage> {
  const limit = input.limit ?? 1000;
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new ProblemError('invalid_request');
  const binding = {
    route: 'GET /v1/agent-pages',
    viewer: input.viewer ?? null,
    query: { limit },
  };
  let afterRoute = -1;
  let afterAccountId = '00000000-0000-0000-0000-000000000000';
  if (input.cursor !== undefined) {
    const decoded = await decodeListCursor(tokens, binding, input.cursor, at);
    if (
      !decoded.ok ||
      decoded.epoch !== 1 ||
      decoded.after.length !== 2 ||
      typeof decoded.after[0] !== 'number' ||
      decoded.after[0] < 0 ||
      decoded.after[0] > 65535 ||
      typeof decoded.after[1] !== 'string' ||
      routeOf(decoded.after[1]) !== decoded.after[0]
    )
      throw new ProblemError('invalid_cursor');
    afterRoute = decoded.after[0];
    afterAccountId = decoded.after[1];
  }
  const page = await agentPagesPage.run(client, {
    after_route: afterRoute,
    after_account_id: afterAccountId,
    limit: limit + 1,
  });
  const selected = page.slice(0, limit);
  const last = selected.at(-1);
  return {
    agentPages: selected.map(({ handle, kind, lastModified }) => {
      // Only the erased identity skeleton can lose its public timestamp.
      if (lastModified === null) throw new Error('Live account public timestamp is missing');
      return { handle: handle!, kind, lastModified };
    }),
    next:
      page.length > limit && last
        ? await encodeListCursor(tokens, binding, { epoch: 1, after: [last.route, last.accountId] }, at)
        : null,
  };
}
