import type { Pool, PoolClient } from 'pg';
import accountRead from './account-read.sql';
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
