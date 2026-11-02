import type { Pool } from 'pg';
import {
  AUTH_PAGE_OPERATION_CLIENT_ID,
  AUTH_PAGE_OPERATION_SCOPES,
  type AuthSessionPort,
  type SessionProof,
} from '@rezics/auth-contract';
import type { Access } from '../request/access.ts';
import { withConnection } from '../database/pool.ts';
import { authoritativeTimeValue, mintReadTime, releaseOperationalTime } from '../command/command.ts';
import { readPartition } from '../partition/partition.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { withReadTransaction } from '../semantic/read.ts';
import { accessClock } from './access-clock.ts';
import { readAccount, readOrganizationRole } from './account-data.ts';
import { readManagedAuthActions } from './account-management-auth-actions.ts';
import { deadlineClient, within } from './authenticate.ts';
import { AuthBindingDeniedError } from './auth-bindings.ts';
import { CommandUnavailableError, requireAccessDeadline } from './unavailable.ts';

export type OrganizationDeletionRead =
  | { kind: 'ready'; account: { id: string; kind: 'organization'; handle: string | null; displayName: string | null } }
  | { kind: 'hidden' | 'denied' | 'missing' | 'unavailable' };
export interface OrganizationDeletionAccess {
  readOrganizationForDeletion(input: {
    human: SessionProof;
    organizationId: string;
    deadline: number;
  }): Promise<OrganizationDeletionRead>;
}
/** The management ENTRY authority already evaluates the installed deletion
 * formula. Reuse its private account source and native authority, without the
 * generic management endpoint's account:read profile or its member inventories.
 */
export function createOrganizationDeletionAccess(deps: {
  pool: Pool;
  access: Access;
  accessTokenForProof: AuthSessionPort['internal']['accessTokenForProof'];
}): OrganizationDeletionAccess {
  return {
    async readOrganizationForDeletion({ human, organizationId, deadline }) {
      return within(deadline, async () => {
        requireAccessDeadline(deadline);
        const actor = await deps.access.authenticate(await deps.accessTokenForProof(human), {
          pool: deps.pool,
          deadline,
        });
        if (
          human.client_id !== AUTH_PAGE_OPERATION_CLIENT_ID ||
          human.scope.length !== 1 ||
          human.scope[0] !== AUTH_PAGE_OPERATION_SCOPES.delete[0] ||
          human.amr.length !== 1 ||
          !['pwd', 'pop'].includes(human.amr[0]!) ||
          actor.kind !== 'account' ||
          actor.accountId !== human.account_id ||
          actor.clientId !== human.client_id ||
          actor.authnEpoch !== human.authn_epoch ||
          actor.requestedBy !== null ||
          JSON.stringify(actor.scopes) !== JSON.stringify(human.scope) ||
          routeOf(organizationId) === null ||
          organizationId === actor.accountId
        )
          throw new AuthBindingDeniedError();
        const time = await withConnection(deps.pool, (client) =>
          mintReadTime(deadlineClient(client, deadline), accessClock(deps.access)),
        );
        try {
          const snapshot = () =>
            withReadTransaction(
              deps.pool,
              async (client) => {
                const homes = [];
                for (const id of [actor.accountId, organizationId]) {
                  const partition = partitionOf(routeOf(id)!);
                  const home = await readPartition(client, partition);
                  if (!home) throw new CommandUnavailableError('contention', partition);
                  if (home.writeState !== 'active')
                    throw new CommandUnavailableError(home.writeState, partition, home.movedTo);
                  homes.push([home.node, home.epoch]);
                }
                const caller = await readAccount(client, routeOf(actor.accountId)!, actor.accountId);
                const account = await readAccount(client, routeOf(organizationId)!, organizationId);
                const role =
                  account?.kind === 'organization'
                    ? await readOrganizationRole(
                        client,
                        account.route,
                        organizationId,
                        actor.accountId,
                        new Date(authoritativeTimeValue(time)),
                      )
                    : null;
                return { homes, caller, account, role };
              },
              deadline,
            );
          const before = await snapshot();
          const caller = before.caller;
          if (
            !caller ||
            caller.kind !== 'actor' ||
            caller.state !== 'active' ||
            caller.fenced ||
            caller.operatorAccountId !== null ||
            !Number.isSafeInteger(actor.authnEpoch) ||
            actor.authnEpoch < 1 ||
            BigInt(actor.authnEpoch) < caller.minimumAuthnEpoch
          )
            throw new AuthBindingDeniedError();
          const target = before.account;
          if (!target || target.state !== 'active' || target.fenced) return { kind: 'missing' };
          if (target.kind !== 'organization' || target.operatorAccountId !== null) return { kind: 'denied' };
          if (!before.role) return { kind: 'hidden' };
          const actions = await readManagedAuthActions(
            deps,
            actor,
            { account: target, relation: null },
            { deadline, time },
          );
          if (actions.state === 'unavailable') return { kind: 'unavailable' };
          const after = await snapshot();
          // The same private rows, lifecycle/floor and home epochs must survive
          // released Access preparation; include labels in that comparison.
          const stable = (value: unknown) =>
            JSON.stringify(value, (_, item) => (typeof item === 'bigint' ? item.toString() : item));
          if (stable(before) !== stable(after)) return { kind: 'unavailable' };
          if (!actions.operations.some((entry) => entry.operationId === 'auth.organization.delete'))
            return { kind: 'denied' };
          requireAccessDeadline(deadline);
          return {
            kind: 'ready',
            account: {
              id: organizationId,
              kind: 'organization',
              handle: target.handle,
              displayName: target.displayName,
            },
          };
        } finally {
          releaseOperationalTime(time);
        }
      });
    },
  };
}
