import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { routeOf } from '../route/route.ts';
import handleRead from './account-handle-read.sql';
import accountRead from './account-read.sql';
import publicPage from './public-identity-page.sql';
import publicRead from './account-public-read.sql';
import organizationRoleRead from './account-organization-role.sql';

type Queryable = Pick<Pool | PoolClient, 'query'>;
type AccountRow = NonNullable<Awaited<ReturnType<typeof accountRead.run>>>;

/** Private authoritative row, including lifecycle's fenced flag; never a public profile. */
export type Account = Omit<AccountRow, 'minimumAuthnEpoch'> & { minimumAuthnEpoch: bigint };
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

export type PublicIdentity = {
  id: string;
  kind: 'actor' | 'organization';
  handle: string | null;
  displayName: string | null;
  state: 'active' | 'deleted';
  automated: boolean;
  operatorId: string | null;
};

export type AccountLink = { label: string; url: string };
export type PublicAccountProfile = PublicIdentity & {
  bio: string | null;
  links: AccountLink[];
  avatar: {
    media: string;
    width: number;
    height: number;
    placeholder: { thumbhash: string; color: string };
    variants: { format: 'avif' | 'webp'; width: number }[];
    focalPoint: { x: number; y: number } | null;
    credit: { rightsHolder: string; via: { name: string; url: string }; license: string };
  } | null;
  subject: { id: string; label: string; type: string } | null;
};

/** Resolve only an active claim, then read the account on its own anchor. */
export async function readPublicAccountByHandle(
  client: Queryable,
  handle: string,
): Promise<(PublicIdentity | PublicAccountProfile)[]> {
  const route = createHash('sha256').update(handle).digest().readUInt16BE(0);
  const claim = await handleRead.run(client, { route, handle });
  if (!claim) return [];
  const row = await publicRead.run(client, { route: routeOf(claim.accountId)!, account_id: claim.accountId });
  if (!row || row.state === 'pending') return [];
  const deleted = row.state === 'deleted';
  const identity: PublicIdentity = {
    id: row.accountId,
    kind: row.kind === 'organization' ? 'organization' : 'actor',
    handle: row.handle,
    displayName: row.displayName,
    state: deleted ? 'deleted' : 'active',
    automated: !deleted && row.operatorAccountId !== null,
    operatorId: row.operatorAccountId,
  };
  if (deleted) return [identity];
  return [{ ...identity, bio: row.biography, links: row.links as AccountLink[], avatar: null, subject: null }];
}

/** Internal Access/kernel point read: state, authentication floor and fence share one anchored row.
 * Trusted Auth composition must return unavailable for a fenced account before establishing a session.
 */
export async function readAccount(client: Queryable, route: number, accountId: string): Promise<Account | null> {
  const row = await accountRead.run(client, { route, account_id: accountId });
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
      found.set(`${route}:${row.id}`, {
        ...row,
        kind: row.kind === 'organization' ? 'organization' : 'actor',
        state: row.state === 'deleted' ? 'deleted' : 'active',
      });
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
