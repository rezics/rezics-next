import type { Pool, PoolClient } from 'pg';
import { readCurrentResourceRolePage } from '../access/current-resource-roles.ts';
import { deadlineClient } from '../access/authenticate.ts';
import { readPublicIdentities, type PublicIdentity } from '../access/account-data.ts';
import { mintReadTime, releaseOperationalTime } from '../command/command.ts';
import { discardConnection, withConnection } from '../database/pool.ts';
import { readPartition } from '../partition/partition.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { decodeCursor, encodeCursor } from '../tokens/cursor.ts';
import type { KeyRing } from '../tokens/seal.ts';
import memberActions from './member-page-actions.sql';
import currentMembers from './member-page-current.sql';
import selectMembers from './member-page-select.sql';
import { PublicationCursorError } from './publication.ts';

export const REALM_MEMBER_PAGE_SIZE = 20;
export const MAX_REALM_MEMBER_PAGE_BYTES = 600_000;

const FIRST_ACCOUNT = '00000000-0000-0000-0000-000000000000';
const MAX_PUBLIC_NAME_UNITS = 4096;
const MAX_PUBLIC_NAME_JSON_BYTES = 24_576;
const MAX_IDENTITIES = REALM_MEMBER_PAGE_SIZE + 1;

export class MemberPageUnavailableError extends Error {
  constructor(options?: ErrorOptions) {
    super('Realm member page is unavailable', options);
    this.name = 'MemberPageUnavailableError';
  }
}

export type MemberAnchor = {
  accountId: string;
  reservationId: string;
  transactionId: string;
};

export type MemberSelection =
  | {
      state: 'ready';
      members: readonly MemberAnchor[];
      next: string | null;
      selected: { accountId: string; membership: 'member' | 'none' } | null;
    }
  | {
      state: 'preparing';
      members: readonly [];
      next: string | null;
      selected: null;
    };

type CurrentMemberRow = {
  accountId: string;
  reservationId: string;
  transactionId: string;
  committed: boolean;
  terminalized: boolean;
};

type MemberCursorBinding = {
  operation: string;
  parameters: { realmId: string; viewer: string; limit: number };
};

function uniqueIds(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function checkedAnchor(row: Record<string, unknown>, realmRoute: number): MemberAnchor {
  if (
    typeof row.accountId !== 'string' ||
    typeof row.reservationId !== 'string' ||
    typeof row.transactionId !== 'string'
  )
    throw new MemberPageUnavailableError();
  const accountRoute = routeOf(row.accountId);
  if (accountRoute === null || routeOf(row.reservationId) !== accountRoute || routeOf(row.transactionId) !== realmRoute)
    throw new MemberPageUnavailableError();
  return { accountId: row.accountId, reservationId: row.reservationId, transactionId: row.transactionId };
}

function cursorBinding(realmId: string, viewerAccountId: string): MemberCursorBinding {
  return {
    operation: 'community.realm.members',
    parameters: { realmId, viewer: viewerAccountId, limit: REALM_MEMBER_PAGE_SIZE },
  };
}

async function readCurrentMembers(
  client: Pick<Pool | PoolClient, 'query'>,
  input: { route: number; realmId: string; accountIds: readonly string[]; at: string },
): Promise<Map<string, CurrentMemberRow>> {
  const accountIds = uniqueIds(input.accountIds);
  if (accountIds.length > MAX_IDENTITIES || accountIds.some((accountId) => routeOf(accountId) === null))
    throw new MemberPageUnavailableError();
  if (!accountIds.length) return new Map();
  const rows = await currentMembers.run(client, {
    route: input.route,
    realm_id: input.realmId,
    account_ids: accountIds,
    at: input.at,
  });
  const result = new Map<string, CurrentMemberRow>();
  const requested = new Set(accountIds);
  for (const row of rows) {
    const anchor = checkedAnchor(row, input.route);
    if (
      !requested.has(anchor.accountId) ||
      result.has(anchor.accountId) ||
      typeof row.committed !== 'boolean' ||
      typeof row.terminalized !== 'boolean'
    )
      throw new MemberPageUnavailableError();
    result.set(anchor.accountId, {
      ...anchor,
      committed: row.committed,
      terminalized: row.terminalized,
    });
  }
  return result;
}

async function readTransaction<T>(pool: Pool, deadline: number, run: (client: PoolClient) => Promise<T>): Promise<T> {
  return withConnection(pool, async (client) => {
    const bounded = deadlineClient(client, deadline);
    await bounded.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    try {
      const result = await run(bounded);
      await bounded.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        discardConnection(client, rollbackError as Error);
      }
      throw error;
    }
  });
}

/** Selects raw current Realm keys first; identity hydration never changes the cursor. */
export async function selectRealmMembers(
  input: {
    pool: Pool;
    tokens: KeyRing;
    deadline: number;
  },
  request: {
    realmId: string;
    viewerAccountId: string;
    at: string;
    cursor?: string;
    selectedAccountId?: string;
  },
): Promise<MemberSelection> {
  const route = routeOf(request.realmId);
  if (route === null || routeOf(request.viewerAccountId) === null) throw new PublicationCursorError('invalid');
  if (request.selectedAccountId !== undefined && routeOf(request.selectedAccountId) === null)
    throw new PublicationCursorError('invalid');

  const binding = cursorBinding(request.realmId, request.viewerAccountId);
  let after = FIRST_ACCOUNT;
  let cursorEpoch: number | undefined;
  if (request.cursor !== undefined) {
    const decoded = decodeCursor(input.tokens, binding, request.cursor);
    if (!decoded.ok) throw new PublicationCursorError(decoded.reason);
    if (decoded.after.length !== 1 || typeof decoded.after[0] !== 'string' || routeOf(decoded.after[0]) === null)
      throw new PublicationCursorError('invalid');
    after = decoded.after[0];
    cursorEpoch = decoded.epoch;
  }

  try {
    return await readTransaction(input.pool, input.deadline, async (client) => {
      const partition = await readPartition(client, partitionOf(route));
      if (!partition || partition.writeState === 'moved') throw new MemberPageUnavailableError();
      if (cursorEpoch !== undefined && cursorEpoch !== partition.epoch) throw new PublicationCursorError('stale');

      const rawRows = await selectMembers.run(client, {
        route,
        realm_id: request.realmId,
        after,
        at: request.at,
      });
      if (rawRows.length > REALM_MEMBER_PAGE_SIZE) throw new MemberPageUnavailableError();
      const raw = rawRows.map((row) => {
        if (typeof row.hasMore !== 'boolean') throw new MemberPageUnavailableError();
        return { ...checkedAnchor(row, route), hasMore: row.hasMore };
      });
      const ids = uniqueIds([
        ...raw.map((member) => member.accountId),
        ...(request.selectedAccountId === undefined ? [] : [request.selectedAccountId]),
      ]);
      const current = await readCurrentMembers(client, {
        route,
        realmId: request.realmId,
        accountIds: ids,
        at: request.at,
      });

      if (
        raw.some((member) => {
          const observed = current.get(member.accountId);
          return (
            !observed ||
            !observed.committed ||
            observed.terminalized ||
            observed.reservationId !== member.reservationId ||
            observed.transactionId !== member.transactionId
          );
        })
      )
        return { state: 'preparing', members: [], next: request.cursor ?? null, selected: null };

      const selectedAnchor = request.selectedAccountId ? current.get(request.selectedAccountId) : undefined;
      if (selectedAnchor && (!selectedAnchor.committed || selectedAnchor.terminalized))
        return { state: 'preparing', members: [], next: request.cursor ?? null, selected: null };

      const members = raw.map(({ hasMore: _hasMore, ...member }) => member);
      const last = raw.at(-1);
      const next = last?.hasMore
        ? encodeCursor(input.tokens, binding, { epoch: partition.epoch, after: [last.accountId] })
        : null;
      return {
        state: 'ready',
        members,
        next,
        selected:
          request.selectedAccountId === undefined
            ? null
            : { accountId: request.selectedAccountId, membership: selectedAnchor ? 'member' : 'none' },
      };
    });
  } catch (error) {
    if (error instanceof PublicationCursorError || error instanceof MemberPageUnavailableError) throw error;
    throw new MemberPageUnavailableError({ cause: error });
  }
}

/** Rechecks the exact raw keys and selected account after identity/action hydration. */
export async function confirmRealmMemberSelection(
  input: { pool: Pool; deadline: number },
  request: {
    realmId: string;
    at: string;
    members: readonly MemberAnchor[];
    selected: { accountId: string; membership: 'member' | 'none' } | null;
  },
): Promise<boolean> {
  const route = routeOf(request.realmId);
  if (route === null) throw new MemberPageUnavailableError();
  const ids = uniqueIds([
    ...request.members.map((member) => member.accountId),
    ...(request.selected === null ? [] : [request.selected.accountId]),
  ]);
  try {
    return await readTransaction(input.pool, input.deadline, async (client) => {
      const current = await readCurrentMembers(client, {
        route,
        realmId: request.realmId,
        accountIds: ids,
        at: request.at,
      });
      const sameMember = (expected: MemberAnchor) => {
        const actual = current.get(expected.accountId);
        return (
          actual !== undefined &&
          actual.committed &&
          !actual.terminalized &&
          actual.reservationId === expected.reservationId &&
          actual.transactionId === expected.transactionId
        );
      };
      if (request.members.some((member) => !sameMember(member))) return false;
      if (request.selected === null) return true;
      const selected = current.get(request.selected.accountId);
      if (request.selected.membership === 'none') return selected === undefined;
      return selected !== undefined && sameMember(selected);
    });
  } catch (error) {
    if (error instanceof MemberPageUnavailableError) throw error;
    throw new MemberPageUnavailableError({ cause: error });
  }
}

/** Accounts' admitted bounded ID projection routes exact IDs to their own account homes. */
export async function readRealmMemberIdentities(
  pool: Pool,
  accountIds: readonly string[],
  deadline: number,
): Promise<Map<string, PublicIdentity>> {
  const ids = uniqueIds(accountIds);
  if (ids.length > MAX_IDENTITIES || ids.some((accountId) => routeOf(accountId) === null))
    throw new MemberPageUnavailableError();
  if (!ids.length) return new Map();
  try {
    return await withConnection(pool, async (client) => {
      const rows = await readPublicIdentities(
        deadlineClient(client, deadline),
        ids.map((accountId) => routeOf(accountId)!),
        ids,
      );
      const result = new Map<string, PublicIdentity>();
      const requested = new Set(ids);
      for (const identity of rows) {
        if (!requested.has(identity.id) || result.has(identity.id)) throw new MemberPageUnavailableError();
        result.set(identity.id, identity);
      }
      return result;
    });
  } catch (error) {
    throw new MemberPageUnavailableError({ cause: error });
  }
}

export type MemberActionObservation = { banned: boolean; protectedRole: boolean | null };

/** Reads exact Community ban facts and a bounded current Access role prefix. */
export async function readRealmMemberActions(
  input: { pool: Pool; deadline: number },
  request: { realmId: string; accountIds: readonly string[]; at: string },
): Promise<Map<string, MemberActionObservation>> {
  const route = routeOf(request.realmId);
  const ids = uniqueIds(request.accountIds);
  if (route === null || ids.length > MAX_IDENTITIES || ids.some((accountId) => routeOf(accountId) === null))
    throw new MemberPageUnavailableError();
  if (!ids.length) return new Map();
  try {
    return await readTransaction(input.pool, input.deadline, async (client) => {
      const bounded = deadlineClient(client, input.deadline);
      const result = new Map<string, MemberActionObservation>();
      const rows = await memberActions.run(bounded, {
        route,
        realm_id: request.realmId,
        account_ids: ids,
        at: request.at,
      });
      for (const row of rows) {
        if (
          typeof row.accountId !== 'string' ||
          !ids.includes(row.accountId) ||
          typeof row.banned !== 'boolean' ||
          result.has(row.accountId)
        )
          throw new MemberPageUnavailableError();
        result.set(row.accountId, { banned: row.banned, protectedRole: false });
      }
      if (result.size !== ids.length) throw new MemberPageUnavailableError();
      const at = await mintReadTime(bounded);
      try {
        const protectedAccounts = new Set<string>();
        let incomplete = false;
        for (const role of ['community.realm.owner', 'community.realm.moderator']) {
          const page = await readCurrentResourceRolePage(bounded, {
            resource: { route, id: request.realmId },
            roles: [role],
            at,
            after: null,
            limit: 100,
          });
          if (page.status !== 'ready') throw new MemberPageUnavailableError();
          for (const current of page.rows) {
            if (current.subjectKind === 'identity' && current.subjectRole === '' && ids.includes(current.subjectId))
              protectedAccounts.add(current.subjectId);
          }
          incomplete ||= page.after !== null;
        }
        for (const accountId of ids) {
          result.set(accountId, {
            banned: result.get(accountId)!.banned,
            protectedRole: protectedAccounts.has(accountId) ? true : incomplete ? null : false,
          });
        }
      } finally {
        releaseOperationalTime(at);
      }
      return result;
    });
  } catch (error) {
    if (error instanceof MemberPageUnavailableError) throw error;
    throw new MemberPageUnavailableError({ cause: error });
  }
}

export function publicMemberIdentity(accountId: string, source: PublicIdentity | undefined) {
  if (!source) return { identity: null, displayName: 'Member' } as const;
  if (source.id !== accountId) throw new MemberPageUnavailableError();
  if (source.state === 'deleted')
    return { identity: { id: source.id, kind: source.kind, state: 'deleted' as const }, displayName: 'Member' };
  const sourceName = source.displayName;
  const boundedName =
    sourceName !== null &&
    sourceName.trim().length > 0 &&
    sourceName.length <= MAX_PUBLIC_NAME_UNITS &&
    Buffer.byteLength(JSON.stringify(sourceName), 'utf8') <= MAX_PUBLIC_NAME_JSON_BYTES
      ? sourceName
      : null;
  const displayName = boundedName;
  const handle = source.handle !== null && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(source.handle) ? source.handle : null;
  return {
    identity: {
      id: accountId,
      kind: source.kind,
      state: 'active' as const,
      handle,
      displayName,
    },
    displayName: boundedName ?? 'Member',
  };
}

export function assertRealmMemberPageBytes<T>(response: T): T {
  const encoded = JSON.stringify(response);
  if (encoded === undefined || Buffer.byteLength(encoded, 'utf8') > MAX_REALM_MEMBER_PAGE_BYTES)
    throw new MemberPageUnavailableError();
  return response;
}
