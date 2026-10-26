import type { Pool, PoolClient } from 'pg';
import { runCommand } from '../command/command.ts';
import { ProblemError } from '../http/problem.ts';
import { requestDigest } from '../http/request.ts';
import type { Access, AccessContext, Actor } from '../request/access.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { resourceAuthorization } from './resource-authorization.ts';
import read from './preferences-read.sql';
import set from './preferences-set.sql';

export type AccountPreferences = { spoilerLevel: 0 | 1 | 2; suitability: 'blur' | 'show'; version: number };
export const DEFAULT_ACCOUNT_PREFERENCES: Readonly<AccountPreferences> = Object.freeze({
  spoilerLevel: 0,
  suitability: 'blur',
  version: 0,
});
export type PreferenceChange = {
  expectedVersion: number;
  spoilerLevel?: 0 | 1 | 2;
  suitability?: 'blur' | 'show';
};

/** One account-key seek, at most one row; missing storage means the defaults. */
export async function readAccountPreferences(
  client: Pick<Pool | PoolClient, 'query'>,
  accountId: string,
): Promise<AccountPreferences> {
  const route = routeOf(accountId);
  if (route === null) throw new ProblemError('invalid_request');
  const row = await read.run(client, { route, account_id: accountId });
  return row
    ? { ...row, spoilerLevel: row.spoilerLevel as 0 | 1 | 2, suitability: row.suitability as 'blur' | 'show' }
    : { ...DEFAULT_ACCOUNT_PREFERENCES };
}

/** Serializable read/compare/write touches one preference row and the command receipt.
 * The acting account alone owns this state, including in an operator-opened session.
 */
export function createPreferenceCommands(config: { pool: Pool; access: Access; clock: () => Date }) {
  return {
    async setPreferences(
      context: AccessContext & { actor: Actor },
      input: PreferenceChange & { accountId: string; key: string },
    ) {
      input = structuredClone(input);
      const { actor } = context;
      if (actor.kind !== 'account' || actor.accountId !== input.accountId || context.pool !== config.pool)
        throw new ProblemError('forbidden');
      const route = routeOf(input.accountId);
      if (
        route === null ||
        !Number.isInteger(input.expectedVersion) ||
        input.expectedVersion < 0 ||
        input.expectedVersion > 2147483646 ||
        (input.spoilerLevel !== undefined && ![0, 1, 2].includes(input.spoilerLevel)) ||
        (input.suitability !== undefined && !['blur', 'show'].includes(input.suitability)) ||
        Object.keys(input).some(
          (key) => !['accountId', 'key', 'expectedVersion', 'spoilerLevel', 'suitability'].includes(key),
        )
      )
        throw new ProblemError('invalid_request');
      const partition = partitionOf(route);
      const authorization = resourceAuthorization({
        access: config.access,
        actor,
        action: 'account:update',
        anchor: { resource: { route, id: input.accountId }, validate: async () => true },
        context: { pool: context.pool, deadline: context.deadline, partition },
      });
      return runCommand(
        config.pool,
        {
          partition,
          basis: { actorAccountId: actor.accountId, clientId: actor.clientId, requestedBy: actor.requestedBy },
          deadline: context.deadline,
          clock: config.clock,
          authorization,
          receipt: {
            actorAccountId: actor.accountId,
            kind: 'access.account.preferences',
            key: input.key,
            digest: requestDigest('account.set_preferences', actor, input),
          },
        },
        async (tx) => {
          const current = await readAccountPreferences(tx, input.accountId);
          if (current.version !== input.expectedVersion) throw new ProblemError('conflict');
          const next = {
            ...current,
            spoilerLevel: input.spoilerLevel ?? current.spoilerLevel,
            suitability: input.suitability ?? current.suitability,
          };
          if (next.spoilerLevel !== current.spoilerLevel || next.suitability !== current.suitability) {
            const changed = await set.run(tx, {
              route,
              account_id: input.accountId,
              spoiler_level: next.spoilerLevel,
              suitability: next.suitability,
              expected_version: input.expectedVersion,
            });
            if (!changed) throw new ProblemError('conflict');
            next.version = changed.version;
          }
          return {
            value: next,
            events: [
              {
                type: 'com.rezics.access.account-updated.v1',
                subject: input.accountId,
                data: { accountId: input.accountId },
              },
            ],
          };
        },
      );
    },
  };
}
