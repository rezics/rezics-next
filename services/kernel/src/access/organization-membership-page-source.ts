import type { Pool } from 'pg';
import {
  AUTH_MANAGEMENT_CLIENT_ID,
  AUTH_MANAGEMENT_SCOPES,
  type AuthSessionPort,
  type SessionProof,
} from '@rezics/auth-contract';
import { accessCheck, type Access, type Actor } from '../request/access.ts';
import { withConnection } from '../database/pool.ts';
import { ProblemError } from '../http/problem.ts';
import { authoritativeTimeValue, mintReadTime, releaseOperationalTime } from '../command/command.ts';
import { routeOf } from '../route/route.ts';
import { decodeListCursor, encodeListCursor } from '../tokens/list-cursor.ts';
import type { KeyRing } from '../tokens/seal.ts';
import { accessClock } from './access-clock.ts';
import { AccessUnavailableError, requireAccessDeadline } from './unavailable.ts';
import { AuthBindingDeniedError } from './auth-bindings.ts';
import { readAccount, readOrganizationRole, readPublicIdentities } from './account-data.ts';
import membersPage from './management-members.sql';
import ownersRead from './lifecycle-owners.sql';

const PAGE_LIMIT = 20;
const PAGE_FEED = 'auth.organization.membership.page';
const PAGE_START = '00000000-0000-0000-0000-000000000000';

export type MembershipActionAdvice = 'allowed' | 'last-owner' | 'unavailable';
export type MembershipPublicIdentity = {
  id: string;
  kind: 'actor' | 'organization';
  handle: string | null;
  displayName: string | null;
};
export type OrganizationMembershipPage = {
  organizationId: string;
  viewer: {
    accountId: string;
    role: 'owner' | 'member';
    leave: MembershipActionAdvice;
  };
  members:
    | {
        state: 'ready';
        items: {
          accountId: string;
          account: MembershipPublicIdentity | null;
          role: 'owner' | 'member';
          actions: { changeRole: MembershipActionAdvice; remove: MembershipActionAdvice };
        }[];
        next: string | null;
      }
    | { state: 'unavailable' };
};
export type OrganizationMembershipPageSelection = { organizationId: string; cursor?: string };

/** Auth's server-only management proof is the only route into this source. */
export interface OrganizationMembershipPageAccess {
  readOrganizationMembershipPage(
    input: OrganizationMembershipPageSelection & { human: SessionProof; deadline: number },
  ): Promise<OrganizationMembershipPage>;
}

/**
 * Bounded private inventory. The full-key candidate seek reads at most 21 keys,
 * hydrates at most 20 current roles and public identities, and runs at most 20
 * saturated owner-count probes. Inventory admission, role change, removal and
 * member self-leave each prepare their own installed native action predicate.
 * Every read is pool-backed and unlocked; the command remains the write guard.
 */
export async function readOrganizationMembershipPage(
  deps: { pool: Pool; access: Access; tokens: KeyRing; clock?: () => Date },
  actor: Actor,
  selection: OrganizationMembershipPageSelection,
  context: { deadline: number },
): Promise<OrganizationMembershipPage> {
  const { pool, access, tokens } = deps;
  const { organizationId } = selection;
  if (actor.kind !== 'account') throw new AuthBindingDeniedError();
  const organizationRoute = routeOf(organizationId);
  const viewerRoute = routeOf(actor.accountId);
  if (organizationRoute === null || viewerRoute === null) throw new AuthBindingDeniedError();
  requireAccessDeadline(context.deadline);

  const time = await withConnection(pool, (client) => mintReadTime(client, deps.clock ?? accessClock(access)));
  try {
    const at = new Date(authoritativeTimeValue(time));
    const human = await readAccount(pool, viewerRoute, actor.accountId);
    const organization = await readAccount(pool, organizationRoute, organizationId);
    if (
      !human ||
      human.kind !== 'actor' ||
      human.state !== 'active' ||
      human.fenced ||
      human.operatorAccountId !== null ||
      !Number.isSafeInteger(actor.authnEpoch) ||
      actor.authnEpoch < 1 ||
      BigInt(actor.authnEpoch) < human.minimumAuthnEpoch
    )
      throw new AuthBindingDeniedError();
    if (!organization || organization.kind !== 'organization' || organization.state !== 'active' || organization.fenced)
      throw new AuthBindingDeniedError();

    const viewerRole = await readOrganizationRole(pool, organizationRoute, organizationId, actor.accountId, at);
    if (!viewerRole) throw new AuthBindingDeniedError();

    const actionResource = { route: organizationRoute, id: organizationId };
    async function allowed() {
      requireAccessDeadline(context.deadline);
      const check = await accessCheck(access, actor, 'organization:membership', actionResource, {
        pool,
        deadline: context.deadline,
        time,
      });
      return withConnection(pool, (client) => check(client, time));
    }

    // This read admission is separate from the action observations below. A
    // current role or a row in the inventory never creates operation authority.
    const inventoryAllowed = await allowed();
    let members: OrganizationMembershipPage['members'] = { state: 'unavailable' };
    if (inventoryAllowed) {
      let after = PAGE_START;
      if (selection.cursor !== undefined) {
        const decoded = await decodeListCursor(
          tokens,
          {
            route: PAGE_FEED,
            viewer: actor.accountId,
            query: { organizationId, sort: 'memberAccountId:asc', limit: PAGE_LIMIT },
          },
          selection.cursor,
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
        after = decoded.after[0];
      }
      const candidates = await membersPage.run(pool, {
        route: organizationRoute,
        organization_id: organizationId,
        after,
        limit: PAGE_LIMIT + 1,
      });
      const page = candidates.slice(0, PAGE_LIMIT);
      const current: { accountId: string; role: 'owner' | 'member' }[] = [];
      for (const candidate of page) {
        requireAccessDeadline(context.deadline);
        const role = await readOrganizationRole(pool, organizationRoute, organizationId, candidate.accountId, at);
        if (role) current.push({ accountId: candidate.accountId, role });
      }
      const identities = current.length
        ? await readPublicIdentities(
            pool,
            current.map(({ accountId }) => routeOf(accountId)!),
            current.map(({ accountId }) => accountId),
          )
        : [];
      const identityById = new Map(
        identities.flatMap((identity) =>
          identity.state === 'deleted'
            ? []
            : [
                [
                  identity.id,
                  {
                    id: identity.id,
                    kind: identity.kind,
                    handle: identity.handle,
                    displayName: identity.displayName,
                  },
                ] as const,
              ],
        ),
      );

      const changeRoleAllowed = viewerRole === 'owner' && (await allowed());
      const removeAllowed = viewerRole === 'owner' && (await allowed());
      const items: Extract<OrganizationMembershipPage['members'], { state: 'ready' }>['items'] = [];
      for (const row of current) {
        requireAccessDeadline(context.deadline);
        const owners = await ownersRead.run(pool, {
          route: organizationRoute,
          organization_id: organizationId,
          member_id: row.accountId,
          at: at.toISOString(),
        });
        const ownerEvidenceCurrent = !!owners && owners.owners > 0 && owners.target === (row.role === 'owner' ? 1 : 0);
        const lastOwner = ownerEvidenceCurrent && row.role === 'owner' && owners.owners === 1;
        const changeRole: MembershipActionAdvice =
          !changeRoleAllowed || !ownerEvidenceCurrent ? 'unavailable' : lastOwner ? 'last-owner' : 'allowed';
        const remove: MembershipActionAdvice =
          !removeAllowed || !ownerEvidenceCurrent ? 'unavailable' : lastOwner ? 'last-owner' : 'allowed';
        items.push({
          accountId: row.accountId,
          account: identityById.get(row.accountId) ?? null,
          role: row.role,
          actions: { changeRole, remove },
        });
      }
      const next =
        candidates.length > PAGE_LIMIT
          ? await encodeListCursor(
              tokens,
              {
                route: PAGE_FEED,
                viewer: actor.accountId,
                query: { organizationId, sort: 'memberAccountId:asc', limit: PAGE_LIMIT },
              },
              { epoch: 1, after: [page.at(-1)!.accountId] },
              at,
            )
          : null;
      members = { state: 'ready', items, next };
    }

    let leave: MembershipActionAdvice = 'unavailable';
    if (viewerRole === 'member') {
      const leaveAllowed = await allowed();
      const owners = await ownersRead.run(pool, {
        route: organizationRoute,
        organization_id: organizationId,
        member_id: actor.accountId,
        at: at.toISOString(),
      });
      if (owners && owners.owners > 0 && owners.target === 0 && leaveAllowed) leave = 'allowed';
    }
    requireAccessDeadline(context.deadline);
    return {
      organizationId,
      viewer: { accountId: actor.accountId, role: viewerRole, leave },
      members,
    };
  } catch (error) {
    if (error instanceof AuthBindingDeniedError) throw error;
    if (error instanceof AccessUnavailableError) throw error;
    requireAccessDeadline(context.deadline);
    throw error;
  } finally {
    releaseOperationalTime(time);
  }
}

/** Bind Auth's exact management proof before using the installed Access formula. */
export function createOrganizationMembershipPageAccess(deps: {
  pool: Pool;
  access: Access;
  tokens: KeyRing;
  clock?: () => Date;
  accessTokenForProof: AuthSessionPort['internal']['accessTokenForProof'];
}): OrganizationMembershipPageAccess {
  return {
    async readOrganizationMembershipPage({ human, deadline, ...selection }) {
      const actor = await deps.access.authenticate(await deps.accessTokenForProof(human), {
        pool: deps.pool,
        deadline,
      });
      if (
        human.client_id !== AUTH_MANAGEMENT_CLIENT_ID ||
        JSON.stringify(human.scope) !== JSON.stringify(AUTH_MANAGEMENT_SCOPES.membership) ||
        actor.kind !== 'account' ||
        actor.accountId !== human.account_id ||
        actor.clientId !== human.client_id ||
        actor.authnEpoch !== human.authn_epoch ||
        actor.requestedBy !== null ||
        JSON.stringify(actor.scopes) !== JSON.stringify(human.scope)
      )
        throw new AuthBindingDeniedError();
      return readOrganizationMembershipPage(deps, actor, selection, { deadline });
    },
  };
}
