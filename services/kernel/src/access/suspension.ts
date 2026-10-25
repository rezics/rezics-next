import { createHash } from 'node:crypto';
import canonicalize from 'canonicalize';
import type { Pool } from 'pg';
import { runCommand } from '../command/command.ts';
import type { Access, AccessContext, Actor } from '../request/access.ts';
import { derivedId, partitionOf, routeOf } from '../route/route.ts';
import { PLATFORM_RESOURCE } from './bootstrap-governance.ts';
import globalRead from './bootstrap-governance-read.sql';
import { GrantDeniedError } from './grant-commands.ts';
import { resourceAuthorization } from './resource-authorization.ts';
import suspendStatement from './suspension-update.sql';

export type SuspensionContext = AccessContext & { actor: Actor };
export type SuspensionInput = { accountId: string; key: string; reason?: string };
export type SuspensionValue = {
  accountId: string;
  state: 'suspended';
  minimumAuthnEpoch: string;
  receiptId: string;
};

/** Unheld accounts only. A durable coordinator must resolve existing lifecycle
 * responsibilities before this terminal transition; elapsed time grants no bypass.
 * Authorization uses the Global Context, then releases it before target checkout.
 */
export function createSuspensionCommands(config: { pool: Pool; access: Access; clock: () => Date }) {
  return {
    async suspend(context: SuspensionContext, body: SuspensionInput) {
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
        (input.reason !== undefined &&
          (typeof input.reason !== 'string' || input.reason.length < 1 || input.reason.length > 2000)) ||
        Object.keys(input).some((key) => !['accountId', 'key', 'reason'].includes(key))
      )
        throw new GrantDeniedError();
      const partition = partitionOf(route);
      const basis = { actorAccountId: actor.accountId, clientId: actor.clientId, requestedBy: actor.requestedBy };
      const digest = createHash('sha256')
        .update(canonicalize([route, input.accountId, basis, input.reason ?? null])!)
        .digest();
      const authorization = resourceAuthorization({
        access: config.access,
        actor,
        action: 'account:suspend',
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
          receipt: { actorAccountId: actor.accountId, kind: 'access.account.suspend', key: input.key, digest },
        },
        async (tx, { transactionId }) => {
          const receiptId = derivedId(PLATFORM_RESOURCE.id, `${transactionId}:suspension`, route);
          const [receipt] = await suspendStatement.run(tx, {
            route,
            account_id: input.accountId,
            receipt_id: receiptId,
            reason: input.reason ?? '',
            transaction_id: transactionId,
          });
          if (!receipt) throw new GrantDeniedError();
          const value: SuspensionValue = {
            accountId: input.accountId,
            state: 'suspended',
            minimumAuthnEpoch: receipt.minimumAuthnEpoch,
            receiptId,
          };
          return {
            value,
            events: [{ type: 'com.rezics.access.account.suspended.v1', subject: input.accountId, data: value }],
          };
        },
      );
    },
  };
}
