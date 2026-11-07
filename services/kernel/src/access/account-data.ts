import type { Pool, PoolClient } from 'pg';
import { routeOf } from '../route/route.ts';
import agentPagesPage from './agent-pages-page.sql';
import { decodeListCursor, encodeListCursor } from '../tokens/list-cursor.ts';
import type { KeyRing } from '../tokens/seal.ts';
import { ProblemError } from '../http/problem-error.ts';
import accountRead from './account-read.sql';
import commandStateRead from './account-command-state.sql';
import publicPage from './public-identity-page.sql';
import publicIdentityObservationRead from './public-identity-observation.sql';
import organizationRoleRead from './account-organization-role.sql';
import { accessNativeWork, type AccessWorkAccounting } from './work.ts';
import type {
  AccountLink,
  AccountPublicViews,
  AvatarSummary,
  DeletedPublicIdentity,
  PublicAccount,
  PublicAccountProfile,
  PublicHandleIdentity,
  PublicIdentity,
  PublicIdentityFields,
  PublicSubject,
} from './public-identity.ts';
export type {
  AccountLink,
  AccountPublicViews,
  AvatarSummary,
  DeletedPublicIdentity,
  PublicAccount,
  PublicAccountProfile,
  PublicHandleIdentity,
  PublicIdentity,
  PublicIdentityFields,
  PublicSubject,
};

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
export async function readAccountCommandState(
  client: Queryable,
  route: number,
  accountId: string,
  work?: AccessWorkAccounting,
): Promise<AccountCommandState | null> {
  const input = { route, account_id: accountId };
  const row = await accessNativeWork(work, 'account-state', input, { targets: 1 }, () =>
    commandStateRead.run(client, input),
  );
  return row ? { ...row, minimumAuthnEpoch: BigInt(row.minimumAuthnEpoch) } : null;
}

/** One current public identity plus the native facts needed to reobserve its avatar disclosure. */
export type PublicIdentityObservation =
  | DeletedPublicIdentity
  | (PublicIdentityFields & {
      avatarMediaId: string | null;
      nativeState: 'active' | 'suspended';
      authnFenced: boolean;
    });

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

/**
 * Reads current public identities and only avatar references admitted by the active/unfenced predicate.
 * Result entries follow request order and repeat for duplicate IDs; native seeks are deduplicated.
 */
export async function readPublicIdentityObservations(
  client: Queryable,
  accountIds: readonly string[],
): Promise<PublicIdentityObservation[]> {
  if (accountIds.length < 1 || accountIds.length > 100) throw new ProblemError('invalid_request');

  const requested: { id: string; route: number }[] = [];
  const batches = new Map<number, Set<string>>();
  for (const id of accountIds) {
    const route = routeOf(id);
    if (route === null) throw new ProblemError('invalid_request');
    requested.push({ id, route });
    const ids = batches.get(route) ?? new Set<string>();
    ids.add(id);
    batches.set(route, ids);
  }

  const found = new Map<string, PublicIdentityObservation>();
  for (const [route, ids] of batches) {
    const rows = await publicIdentityObservationRead.run(client, {
      route,
      account_ids: [...ids],
    });
    for (const row of rows) {
      if (row.nativeState === 'deleted') {
        found.set(row.id, {
          id: row.id,
          kind: row.kind === 'organization' ? 'organization' : 'actor',
          state: 'deleted',
        });
        continue;
      }
      if (row.nativeState !== 'active' && row.nativeState !== 'suspended') continue;
      found.set(row.id, {
        id: row.id,
        kind: row.kind === 'organization' ? 'organization' : 'actor',
        handle: row.handle,
        displayName: row.displayName,
        state: 'active',
        automated: row.operatorId !== null,
        operatorId: row.operatorId,
        avatarMediaId: row.avatarMediaId,
        nativeState: row.nativeState,
        authnFenced: row.authnFenced,
      });
    }
  }

  return requested.flatMap(({ id }) => {
    const observation = found.get(id);
    return observation ? [observation] : [];
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
