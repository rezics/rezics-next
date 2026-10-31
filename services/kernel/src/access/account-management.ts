import { t } from 'elysia';
import type { Static } from 'typebox';
import type { Pool } from 'pg';
import { withConnection } from '../database/pool.ts';
import { mintReadTime, authoritativeTimeValue } from '../command/command.ts';
import { accessCheck, type Access, type Actor } from '../request/access.ts';
import { routeOf } from '../route/route.ts';
import { ProblemError } from '../http/problem.ts';
import { decodeListCursor, encodeListCursor } from '../tokens/list-cursor.ts';
import type { KeyRing } from '../tokens/seal.ts';
import { readAccount, readOrganizationRole, readPublicIdentities } from './account-data.ts';
import { readMembershipInverse, MembershipInverseIncompleteError } from './membership-inverse.ts';
import operatorPage from './operator-page.sql';
import membersPage from './management-members.sql';
import relationRead from './management-relation.sql';

const closed = { additionalProperties: false } as const;
const id = t.String({ format: 'uuid' });
const nullableText = t.Union([t.String(), t.Null()]);
const identity = t.Object(
  {
    id,
    kind: t.Union([t.Literal('actor'), t.Literal('organization')]),
    handle: nullableText,
    displayName: nullableText,
  },
  closed,
);
const role = t.Union([t.Literal('owner'), t.Literal('member')]);
const next = nullableText;
const responsibility = t.Object(
  {
    reservationId: id,
    accountId: id,
    account: t.Union([identity, t.Null()]),
    state: t.Union([t.Literal('current'), t.Literal('reconciling')]),
  },
  closed,
);
const responsibilityPageSchema = t.Object({ items: t.Array(responsibility), next }, closed);
export const managedAccountsSchema = t.Object(
  {
    account: identity,
    organizations: t.Object(
      {
        state: t.Union([t.Literal('ready'), t.Literal('preparing')]),
        items: t.Array(t.Object({ account: identity, role }, closed)),
        next,
      },
      closed,
    ),
    responsibilities: responsibilityPageSchema,
  },
  closed,
);
const managedAuthOperationId = t.Union([
  t.Literal('auth.account.rename'),
  t.Literal('auth.organization.membership'),
  t.Literal('auth.operator.transfer'),
  t.Literal('auth.organization.delete'),
]);
export type ManagedAuthOperationId = Static<typeof managedAuthOperationId>;
const managedAuthActions = t.Union([
  t.Object(
    {
      state: t.Literal('ready'),
      operations: t.Array(
        t.Object(
          { operationId: managedAuthOperationId, action: t.String(), resource: t.Object({ route: t.Number(), id }, closed) },
          closed,
        ),
      ),
    },
    closed,
  ),
  t.Object({ state: t.Literal('unavailable') }, closed),
]);
export const accountManagementSchema = t.Object(
  {
    account: identity,
    self: t.Boolean(),
    authActions: t.Optional(managedAuthActions),
    role: t.Union([role, t.Null()]),
    operator: t.Union([identity, t.Null()]),
    relation: t.Union([t.Object({ operatorAccountId: id, reservationId: id, version: t.String() }, closed), t.Null()]),
    members: t.Object(
      {
        state: t.Union([t.Literal('ready'), t.Literal('denied')]),
        items: t.Array(t.Object({ accountId: id, account: t.Union([identity, t.Null()]), role }, closed)),
        next,
      },
      closed,
    ),
    responsibilities: t.Union([responsibilityPageSchema, t.Null()]),
  },
  closed,
);
export type ManagedAccountsPage = Static<typeof managedAccountsSchema>;
export type AccountManagementPage = Static<typeof accountManagementSchema>;
type Identity = Static<typeof identity>;
type Dependencies = { pool: Pool; access: () => Access; tokens: KeyRing; clock: () => Date };
export type ManagementQuery = { organizationsCursor?: string; membersCursor?: string; operatorsCursor?: string };
const limit = 20;
const start = '00000000-0000-0000-0000-000000000000';

function presentation(account: {
  accountId: string;
  kind: string;
  handle: string | null;
  displayName: string | null;
}): Identity {
  return {
    id: account.accountId,
    kind: account.kind as Identity['kind'],
    handle: account.handle,
    displayName: account.displayName,
  };
}
async function identities(pool: Pool, ids: string[]): Promise<Map<string, Identity>> {
  if (!ids.length) return new Map();
  const rows = await readPublicIdentities(
    pool,
    ids.map((id) => routeOf(id)!),
    ids,
  );
  return new Map(
    rows.flatMap((row) =>
      row.state === 'deleted'
        ? []
        : [
            [
              row.id,
              {
                id: row.id,
                kind: row.kind,
                handle: row.handle,
                displayName: row.displayName,
              },
            ] as const,
          ],
    ),
  );
}

/** Private self inventory and current management observations. Coordination holds never prove authority. */
export async function createManagementRead(deps: Dependencies, actor: Actor, deadline: number) {
  if (actor.kind !== 'account') throw new ProblemError('forbidden');
  const actorId = actor.accountId;
  const context = { pool: deps.pool, deadline };
  const time = await withConnection(deps.pool, (client) => mintReadTime(client, deps.clock));
  const at = new Date(authoritativeTimeValue(time));
  const human = await readAccount(deps.pool, routeOf(actorId)!, actorId);
  if (!human || human.kind !== 'actor' || human.state !== 'active' || human.fenced || human.operatorAccountId !== null)
    throw new ProblemError('forbidden');
  async function allowed(accountId: string, action: string) {
    const check = await accessCheck(
      deps.access(),
      actor,
      action,
      { route: routeOf(accountId)!, id: accountId },
      context,
    );
    return withConnection(deps.pool, (client) => check(client, time));
  }
  if (!(await allowed(actorId, 'account:read'))) throw new ProblemError('forbidden');
  async function currentRole(organizationId: string) {
    return readOrganizationRole(deps.pool, routeOf(organizationId)!, organizationId, actorId, at);
  }
  async function manager(operatorId: string) {
    const operator = await readAccount(deps.pool, routeOf(operatorId)!, operatorId);
    if (!operator || operator.state !== 'active' || operator.fenced || operator.operatorAccountId !== null)
      return false;
    if (operator.kind === 'actor' && operatorId !== actorId) return false;
    if (operator.kind === 'organization' && !(await currentRole(operatorId))) return false;
    return allowed(operatorId, 'account:manage');
  }
  async function after(feed: string, target: string, cursor?: string) {
    if (!cursor) return start;
    const decoded = await decodeListCursor(
      deps.tokens,
      {
        route: feed,
        viewer: actorId,
        query: { target, limit },
      },
      cursor,
      at,
    );
    if (
      !decoded.ok ||
      decoded.epoch !== 1 ||
      decoded.after.length !== 1 ||
      typeof decoded.after[0] !== 'string' ||
      routeOf(decoded.after[0]) === null
    )
      throw new ProblemError('invalid_cursor');
    return decoded.after[0];
  }
  async function continuation(feed: string, target: string, last: string) {
    return encodeListCursor(
      deps.tokens,
      { route: feed, viewer: actorId, query: { target, limit } },
      { epoch: 1, after: [last] },
      at,
    );
  }
  async function responsibilities(
    operatorId: string,
    cursor?: string,
  ): Promise<Static<typeof responsibilityPageSchema>> {
    const feed = 'account.management.responsibilities';
    const rows = await operatorPage.run(deps.pool, {
      route: routeOf(operatorId)!,
      operator_id: operatorId,
      after: await after(feed, operatorId, cursor),
      limit: limit + 1,
    });
    const page = rows.slice(0, limit);
    const publicAccounts = await identities(
      deps.pool,
      page.map((item) => item.subjectAccountId),
    );
    const items: Static<typeof responsibility>[] = [];
    for (const row of page) {
      const relation = await relationRead.run(deps.pool, {
        route: routeOf(row.subjectAccountId)!,
        account_id: row.subjectAccountId,
      });
      items.push({
        reservationId: row.reservationId,
        accountId: row.subjectAccountId,
        account: publicAccounts.get(row.subjectAccountId) ?? null,
        state:
          relation?.operatorAccountId === operatorId && relation.reservationId === row.reservationId
            ? 'current'
            : 'reconciling',
      });
    }
    return {
      items,
      next: rows.length > limit ? await continuation(feed, operatorId, page.at(-1)!.reservationId) : null,
    };
  }
  return {
    async inventory(query: ManagementQuery): Promise<ManagedAccountsPage> {
      let candidates: string[];
      try {
        candidates = (
          await withConnection(deps.pool, (client) => readMembershipInverse(client, { accountId: actorId }))
        )
          .filter((item) => item.kind === 'organization')
          .map((item) => item.id)
          .sort();
      } catch (error) {
        if (!(error instanceof MembershipInverseIncompleteError)) throw error;
        return {
          account: presentation(human),
          organizations: { state: 'preparing', items: [], next: null },
          responsibilities: await responsibilities(actorId, query.operatorsCursor),
        };
      }
      const feed = 'account.management.organizations';
      const cursor = await after(feed, actorId, query.organizationsCursor);
      const remaining = candidates.filter((id) => id > cursor);
      const page = remaining.slice(0, limit);
      const publicAccounts = await identities(deps.pool, page);
      const items: ManagedAccountsPage['organizations']['items'] = [];
      for (const organizationId of page) {
        const role = await currentRole(organizationId);
        const account = publicAccounts.get(organizationId);
        if (role && account?.kind === 'organization') items.push({ account, role });
      }
      return {
        account: presentation(human),
        organizations: {
          state: 'ready',
          items,
          next: remaining.length > limit ? await continuation(feed, actorId, page.at(-1)!) : null,
        },
        responsibilities: await responsibilities(actorId, query.operatorsCursor),
      };
    },
    async detail(accountId: string, query: ManagementQuery): Promise<AccountManagementPage> {
      const target = await readAccount(deps.pool, routeOf(accountId)!, accountId);
      if (!target || target.state !== 'active' || target.fenced) throw new ProblemError('not_found');
      const self = accountId === actorId;
      const role = target.kind === 'organization' ? await currentRole(accountId) : null;
      const relation = await relationRead.run(deps.pool, { route: routeOf(accountId)!, account_id: accountId });
      if (
        !self &&
        !(target.kind === 'organization' ? role : target.operatorAccountId && (await manager(target.operatorAccountId)))
      )
        throw new ProblemError('forbidden');
      const canManage = target.kind === 'organization' ? await manager(accountId) : self;
      const members: AccountManagementPage['members'] = {
        state: canManage ? 'ready' : 'denied',
        items: [],
        next: null,
      };
      if (target.kind === 'organization' && canManage) {
        const feed = 'account.management.members';
        const rows = await membersPage.run(deps.pool, {
          route: routeOf(accountId)!,
          organization_id: accountId,
          after: await after(feed, accountId, query.membersCursor),
          limit: limit + 1,
        });
        const page = rows.slice(0, limit);
        const accounts = await identities(
          deps.pool,
          page.map((item) => item.accountId),
        );
        for (const row of page) {
          const held = await readOrganizationRole(deps.pool, routeOf(accountId)!, accountId, row.accountId, at);
          if (held)
            members.items.push({ accountId: row.accountId, account: accounts.get(row.accountId) ?? null, role: held });
        }
        members.next = rows.length > limit ? await continuation(feed, accountId, page.at(-1)!.accountId) : null;
      }
      const operator = target.operatorAccountId
        ? ((await identities(deps.pool, [target.operatorAccountId])).get(target.operatorAccountId) ?? null)
        : null;
      return {
        account: presentation(target),
        self,
        role,
        operator,
        relation:
          relation?.operatorAccountId && relation.reservationId
            ? {
                operatorAccountId: relation.operatorAccountId,
                reservationId: relation.reservationId,
                version: relation.version,
              }
            : null,
        members,
        responsibilities:
          canManage && !target.operatorAccountId ? await responsibilities(accountId, query.operatorsCursor) : null,
      };
    },
  };
}
