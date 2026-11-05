import type { Pool } from 'pg';
import type { AuthSessionPort, SessionProof } from '@rezics/auth-contract';
import { AUTH_MANAGEMENT_CLIENT_ID, AUTH_MANAGEMENT_SCOPES } from '@rezics/auth-contract';
import { accessCheck, type Access, type Actor } from '../request/access.ts';
import { withConnection } from '../database/pool.ts';
import { mintReadTime, authoritativeTimeValue, releaseOperationalTime } from '../command/command.ts';
import { routeOf } from '../route/route.ts';
import { accessClock } from './access-clock.ts';
import { AccessUnavailableError, requireAccessDeadline } from '../request/unavailable.ts';
import { AuthBindingDeniedError } from './auth-bindings.ts';
import actorSource from './management-membership-source-actor.sql';
import accountSource from './management-membership-source-account.sql';
import organizationSource from './management-membership-source.sql';

export type OrganizationMembershipSelection = { organizationId: string; memberAccountId: string };
export type OrganizationMembershipCommandState = OrganizationMembershipSelection & {
  membership: null | { role: 'owner' | 'member'; reservationId: string };
};
/** Trusted Auth composition only. human must be a live Auth proof, never HTTP input. */
export interface ManagementMembershipAccess {
  readOrganizationMembershipCommandState(
    input: OrganizationMembershipSelection & { human: SessionProof; deadline: number },
  ): Promise<OrganizationMembershipCommandState>;
}

/** Bounded command metadata under the SAME native formula as setMembership.
 * Each pass releases its time mint and preparation before source checkout. Two
 * current passes check source identity and authority; no receipt is readback.
 * Cost: fixed exact account/member/slot points plus the installed formula's
 * bounded actor/principal neighborhood. No list, inverse enumeration or profile.
 */
export async function readOrganizationMembershipCommandState(
  deps: { pool: Pool; access: Access; clock?: () => Date },
  actor: Actor,
  selection: OrganizationMembershipSelection,
  context: { deadline: number },
): Promise<OrganizationMembershipCommandState> {
  const { pool, access } = deps;
  const { organizationId, memberAccountId } = selection;
  if (actor.kind !== 'account') throw new AuthBindingDeniedError();
  const { accountId, authnEpoch } = actor;
  const route = routeOf(organizationId);
  const memberRoute = routeOf(memberAccountId);
  if (route === null || memberRoute === null) throw new AuthBindingDeniedError();
  const selected = { organizationId, memberAccountId };
  async function current() {
    requireAccessDeadline(context.deadline);
    const time = await withConnection(pool, (client) => mintReadTime(client, deps.clock ?? accessClock(access)));
    try {
      const human = await actorSource.run(pool, { route: routeOf(accountId)!, account_id: accountId });
      if (
        !human ||
        human.kind !== 'actor' ||
        human.state !== 'active' ||
        human.fenced ||
        human.operatorAccountId !== null ||
        BigInt(authnEpoch) < BigInt(human.floor)
      )
        throw new AuthBindingDeniedError();
      const check = await accessCheck(
        access,
        actor,
        'organization:membership',
        { route: route!, id: organizationId },
        {
          pool,
          deadline: context.deadline,
          time,
        },
      );
      // Member-anchor evidence is read independently, before organization checkout.
      const member = await accountSource.run(pool, {
        route: memberRoute!,
        member_id: memberAccountId,
        organization_id: organizationId,
      });
      const source = await withConnection(pool, async (client) => {
        if (!(await check(client, time))) throw new AuthBindingDeniedError();
        const org = await organizationSource.run(client, {
          route: route!,
          organization_id: organizationId,
          member_id: memberAccountId,
          at: authoritativeTimeValue(time),
          reservation_id: member?.reservationId ?? null,
        });
        if (!org || org.kind !== 'organization' || org.state !== 'active' || org.fenced)
          throw new AuthBindingDeniedError();
        if (
          !member ||
          !member.complete ||
          member.state !== 'active' ||
          member.fenced ||
          (member.reservationId !== null && !member.reservationTransactionId)
        )
          throw new AccessUnavailableError('overloaded');
        if (
          org.role !== null &&
          ((org.role !== 'owner' && org.role !== 'member') ||
            !org.reservationId ||
            org.reservationId !== member.reservationId ||
            !member.reservationTransactionId)
        )
          throw new AccessUnavailableError('overloaded');
        if (!(await check(client, time))) throw new AuthBindingDeniedError();
        requireAccessDeadline(context.deadline);
        return { org, member, human };
      });
      // Re-read the human anchor after releasing organization checkout: an Access
      // preparation must not conceal a concurrent session-floor/fencing change.
      const finalHuman = await actorSource.run(pool, {
        route: routeOf(accountId)!,
        account_id: accountId,
      });
      if (JSON.stringify(human) !== JSON.stringify(finalHuman)) throw new AccessUnavailableError('contention');
      requireAccessDeadline(context.deadline);
      return source;
    } finally {
      releaseOperationalTime(time);
    }
  }
  const before = await current();
  const final = await current();
  if (JSON.stringify(before) !== JSON.stringify(final)) throw new AccessUnavailableError('contention');
  return {
    ...selected,
    membership:
      final.org.role === null
        ? null
        : {
            role: final.org.role as 'owner' | 'member',
            reservationId: final.org.reservationId!,
          },
  };
}

/** Bind Auth's actual live proof through its signer and installed native Access.
 * A profile/ID comparison never grants membership or substitutes for the formula.
 */
export function createManagementMembershipAccess(deps: {
  pool: Pool;
  access: Access;
  clock?: () => Date;
  accessTokenForProof: AuthSessionPort['internal']['accessTokenForProof'];
}): ManagementMembershipAccess {
  return {
    async readOrganizationMembershipCommandState({ human, deadline, ...selection }) {
      const actor = await deps.access.authenticate(await deps.accessTokenForProof(human), {
        pool: deps.pool,
        deadline,
      });
      if (
        human.client_id !== AUTH_MANAGEMENT_CLIENT_ID ||
        JSON.stringify(human.scope) !== JSON.stringify(AUTH_MANAGEMENT_SCOPES.membership) ||
        actor.accountId !== human.account_id ||
        actor.clientId !== human.client_id ||
        actor.authnEpoch !== human.authn_epoch ||
        actor.requestedBy !== null ||
        JSON.stringify(actor.scopes) !== JSON.stringify(human.scope)
      )
        throw new AuthBindingDeniedError();
      return readOrganizationMembershipCommandState(deps, actor, selection, { deadline });
    },
  };
}
