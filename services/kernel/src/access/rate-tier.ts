import { createHash } from 'node:crypto';
import canonicalize from 'canonicalize';
import type { Pool } from 'pg';
import { runCommand, type CommandOutcome } from '../command/command.ts';
import type { Access, AccessContext, Actor } from '../request/access.ts';
import { derivedId, partitionOf, routeOf } from '../route/route.ts';
import { PLATFORM_RESOURCE } from './bootstrap-governance.ts';
import globalRead from './bootstrap-governance-read.sql';
import { GrantDeniedError } from './resource-access-errors.ts';
import { resourceAuthorization } from './resource-authorization.ts';
import accountLock from './rate-tier-account.sql';
import operatorRead from './rate-tier-operator.sql';
import update from './rate-tier-update.sql';

export type AccountRateTier = 'ordinary' | 'trusted' | 'service';
export type RateTierContext = AccessContext & { actor: Actor };
export type RateTierInput = { accountId: string; key: string; tier: AccountRateTier };
export type RateTierValue = { accountId: string; tier: AccountRateTier; receiptId: string };

export class RateTierNotAppliedError extends Error {
  constructor() {
    super('Account rate tier was not applied');
    this.name = 'RateTierNotAppliedError';
  }
}

/** Governance changes one active account's write class. The Global Context
 * authorization is checked on every attempt, including receipt replay. The
 * target partition then locks the account, checks its exact current operator
 * slot, and updates the tier in a fixed number of point statements.
 *
 * Cost: one actor admission seek and the native Global Context formula cost
 * O((1 + K) log G), K <= 1000. The target transaction reads and locks one
 * account, reads one operator slot, and updates that account: O(log R), with a
 * fixed number of statements and no work over other accounts or history.
 */
export function createRateTierCommands(config: { pool: Pool; access: Access; clock: () => Date }) {
  return {
    async setRateTier(context: RateTierContext, body: RateTierInput): Promise<CommandOutcome<RateTierValue>> {
      const input = structuredClone(body);
      const route = routeOf(input.accountId);
      const { actor } = context;
      if (
        actor.kind !== 'account' ||
        context.pool !== config.pool ||
        route === null ||
        typeof input.key !== 'string' ||
        input.key.length < 1 ||
        input.key.length > 255 ||
        !['ordinary', 'trusted', 'service'].includes(input.tier) ||
        Object.keys(input).some((key) => !['accountId', 'key', 'tier'].includes(key))
      )
        throw new GrantDeniedError();

      const partition = partitionOf(route);
      const basis = { actorAccountId: actor.accountId, clientId: actor.clientId, requestedBy: actor.requestedBy };
      const digest = createHash('sha256')
        .update(canonicalize([route, input.accountId, basis, input.tier])!)
        .digest();
      const authorization = resourceAuthorization({
        access: config.access,
        actor,
        action: 'account:set_rate_tier',
        anchor: {
          resource: PLATFORM_RESOURCE,
          async validate(client) {
            const global = await globalRead.run(client, {
              route: PLATFORM_RESOURCE.route,
              resource_id: PLATFORM_RESOURCE.id,
            });
            return global?.global === true;
          },
        },
        context: { pool: context.pool, deadline: context.deadline, partition },
      });

      return runCommand(
        config.pool,
        {
          partition,
          basis,
          deadline: context.deadline,
          clock: config.clock,
          authorization,
          receipt: { actorAccountId: actor.accountId, kind: 'access.account.set_rate_tier', key: input.key, digest },
        },
        async (tx, { transactionId }) => {
          const account = await accountLock.run(tx, { route, account_id: input.accountId });
          if (!account) throw new RateTierNotAppliedError();

          const operator = await operatorRead.run(tx, {
            route,
            account_id: input.accountId,
            reservation_id: account.operatorReservationId ?? '',
            operator_id: account.operatorAccountId ?? '',
          });
          const hasCurrentOperator =
            account.kind === 'actor' &&
            account.operatorAccountId !== null &&
            account.operatorReservationId !== null &&
            operator?.operatorAccountId === account.operatorAccountId &&
            operator.terminal === false;
          if (input.tier === 'service' && !hasCurrentOperator) throw new RateTierNotAppliedError();

          const changed = await update.run(tx, {
            route,
            account_id: input.accountId,
            kind: account.kind,
            operator_id: account.operatorAccountId ?? '',
            reservation_id: account.operatorReservationId ?? '',
            tier: input.tier,
            transaction_id: transactionId,
          });
          if (!changed) throw new RateTierNotAppliedError();

          const value: RateTierValue = {
            accountId: input.accountId,
            tier: input.tier,
            receiptId: derivedId(PLATFORM_RESOURCE.id, `${transactionId}:rate-tier`, route),
          };
          return {
            value,
            events: [{ type: 'com.rezics.access.account.rate-tier-set.v1', subject: input.accountId, data: value }],
          };
        },
      );
    },
  };
}
