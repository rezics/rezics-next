import type { Pool } from 'pg';
import {
  AUTH_PAGE_OPERATION_CLIENT_ID,
  AUTH_PAGE_OPERATION_SCOPES,
  type AuthSessionPort,
  type SessionProof,
} from '@rezics/auth-contract';
import { authoritativeTimeValue, mintReadTime, releaseOperationalTime } from '../command/command.ts';
import { withConnection } from '../database/pool.ts';
import { readPartition } from '../partition/partition.ts';
import { accessCheck, type Access } from '../request/access.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { withReadTransaction } from '../semantic/read.ts';
import { accessClock } from './access-clock.ts';
import { readAccount } from './account-data.ts';
import { deadlineClient, within } from './authenticate.ts';
import { AuthBindingDeniedError } from './auth-bindings.ts';
import { deriveAccess } from './derived-access.ts';
import { permissionEvidenceDeadline } from './permission.ts';
import { CommandUnavailableError, requireAccessDeadline } from './unavailable.ts';
import { managedAuthWorkflowDescriptor } from './workflow-approvals.ts';

export type AccountDeletionAdvice = { kind: 'available' | 'refused' | 'changed' | 'unavailable' };
/** Private exact-human read. No target or authority selector, and no workflow port. */
export interface AccountDeletionPageAccess {
  readAccountDeletionAdvice(input: { human: SessionProof; deadline: number }): Promise<AccountDeletionAdvice>;
}

export function createAccountDeletionPageAccess(deps: {
  pool: Pool;
  access: Access;
  accessTokenForProof: AuthSessionPort['internal']['accessTokenForProof'];
}): AccountDeletionPageAccess {
  return {
    async readAccountDeletionAdvice({ human, deadline }) {
      return within(deadline, async () => {
        requireAccessDeadline(deadline);
        const profile = { client_id: AUTH_PAGE_OPERATION_CLIENT_ID, scope: [...AUTH_PAGE_OPERATION_SCOPES.delete] };
        const route = routeOf(human.account_id);
        if (
          route === null ||
          human.client_id !== profile.client_id ||
          JSON.stringify(human.scope) !== JSON.stringify(profile.scope) ||
          human.amr.length !== 1 ||
          !['pwd', 'pop'].includes(human.amr[0]!)
        )
          throw new AuthBindingDeniedError();
        const context = { pool: deps.pool, deadline };
        const actor = await deps.access.authenticate(await deps.accessTokenForProof(human), context);
        if (
          actor.kind !== 'account' ||
          actor.accountId !== human.account_id ||
          actor.clientId !== human.client_id ||
          actor.authnEpoch !== human.authn_epoch ||
          actor.requestedBy !== null ||
          JSON.stringify(actor.scopes) !== JSON.stringify(human.scope)
        )
          throw new AuthBindingDeniedError();
        const time = await withConnection(deps.pool, (client) =>
          mintReadTime(deadlineClient(client, deadline), accessClock(deps.access)),
        );
        try {
          const snapshot = async (client: Parameters<typeof readAccount>[0]) => {
            const home = await readPartition(client, partitionOf(route));
            if (!home) throw new CommandUnavailableError('contention', partitionOf(route));
            const homeStamp = JSON.stringify([home.node, home.epoch, home.writeState, home.movedTo]);
            if (home.writeState !== 'active') return { admitted: false, home, homeStamp, stamp: '' };
            const account = await readAccount(client, route, human.account_id);
            const admitted =
              !!account &&
              account.kind === 'actor' &&
              account.operatorAccountId === null &&
              account.state === 'active' &&
              !account.fenced &&
              Number.isSafeInteger(actor.authnEpoch) &&
              actor.authnEpoch >= 1 &&
              BigInt(actor.authnEpoch) >= account.minimumAuthnEpoch;
            return {
              admitted,
              home,
              homeStamp,
              // Include the entire exact row: lifecycle, floor and target operands
              // must survive the released preparation, as must the home identity.
              stamp: JSON.stringify([home.node, home.epoch, account], (_, value) =>
                typeof value === 'bigint' ? value.toString() : value,
              ),
            };
          };
          const before = await withReadTransaction(deps.pool, snapshot, deadline);
          if (before.home.writeState !== 'active')
            throw new CommandUnavailableError(before.home.writeState, partitionOf(route), before.home.movedTo);
          if (!before.admitted) throw new AuthBindingDeniedError();
          if (!deps.access.prepare) return { kind: 'unavailable' };
          const access = deriveAccess(deps.access, {
            async prepare(...args) {
              const evidence = await deps.access.prepare!(...args);
              if (permissionEvidenceDeadline(evidence) === undefined)
                throw new Error('Native deletion advice evidence unavailable');
              return evidence;
            },
          });
          const descriptor = managedAuthWorkflowDescriptor('delete', human.account_id);
          const reviewAfterFailure = async (error: unknown): Promise<AccountDeletionAdvice> => {
            const after = await withReadTransaction(deps.pool, snapshot, deadline);
            if (before.homeStamp !== after.homeStamp || (after.admitted && before.stamp !== after.stamp))
              return { kind: 'changed' };
            throw error;
          };
          // No source connection is held across foreign preparation. This is
          // ordinary read authorization, never a command guard or an approval.
          let check: Awaited<ReturnType<typeof accessCheck>>;
          try {
            check = await accessCheck(
              access,
              actor,
              descriptor.action,
              { route, id: descriptor.target },
              { ...context, time },
            );
          } catch (error) {
            return await reviewAfterFailure(error);
          }
          try {
            await deps.accessTokenForProof(human);
          } catch (error) {
            // A moved home can also invalidate Auth's currentness read. Preserve
            // the safe changed-review outcome without disclosing the target.
            return await reviewAfterFailure(error);
          }
          return await withReadTransaction(
            deps.pool,
            async (client): Promise<AccountDeletionAdvice> => {
              const after = await snapshot(client);
              if (!after.admitted || before.homeStamp !== after.homeStamp || before.stamp !== after.stamp)
                return { kind: 'changed' };
              const allowed = await check(client, time);
              // The native formula owns permission operands/currentness at the
              // same authoritative read instant. No approval reference escapes.
              authoritativeTimeValue(time);
              requireAccessDeadline(deadline);
              return { kind: allowed ? 'available' : 'refused' };
            },
            deadline,
          );
        } finally {
          releaseOperationalTime(time);
        }
      });
    },
  };
}
