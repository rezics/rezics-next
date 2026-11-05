import { createHash } from 'node:crypto';
import canonicalize from 'canonicalize';
import type { Pool } from 'pg';
import { GrantDeniedError } from '../access/grant-commands.ts';
import { principalCommandIdentity, runCommand, type CommandAuthorization } from '../command/command.ts';
import { accessCommandAuthorization, type Access, type Actor } from '../request/access.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { StripeUnavailableError, type Order } from './model.ts';
import { lockOrder } from './store.ts';
import accountLock from './order-reconcile-account.sql';

export type OrderReconciliation = Readonly<{ orderId: string; reconciliation: 'queued' }>;

/** One buyer command commits a repair wake-up, never provider or benefit state. */
export async function reconcileOrder(
  config: { pool: Pool; access: Access; deadline: number; repairAvailable: boolean },
  actor: Actor,
  orderId: string,
  key: string,
) {
  if (actor.kind !== 'account' || !actor.scopes.includes('order:reconcile')) throw new GrantDeniedError();
  const route = routeOf(actor.accountId);
  if (route === null || routeOf(orderId) !== route) throw new GrantDeniedError();
  const resource = { route, id: actor.accountId };
  const parent = await accessCommandAuthorization(
    config.access,
    actor,
    'order:reconcile',
    resource,
    config,
    () => new GrantDeniedError(),
  );
  let current: Order | null = null;
  const authorization: CommandAuthorization = {
    ...parent,
    async authorize(tx, attempt, evidence) {
      current = null;
      // Account before order, on every physical retry and before every receipt.
      const account = await accountLock.run(tx, { route, account_id: actor.accountId });
      if (
        !account ||
        account.kind !== 'actor' ||
        account.state !== 'active' ||
        account.fenced ||
        BigInt(account.minimumAuthnEpoch) > BigInt(actor.authnEpoch)
      )
        throw new GrantDeniedError();
      const mode = await parent.authorize(tx, attempt, evidence);
      if (mode !== 'execute') throw new GrantDeniedError();
      current = await lockOrder(tx, route, orderId);
      if (!current || current.buyerAccountId !== actor.accountId) throw new GrantDeniedError();
      return mode;
    },
  };
  const identity = principalCommandIdentity(actor);
  const kind = 'commerce.order.reconcile';
  return runCommand<OrderReconciliation>(
    config.pool,
    {
      ...identity,
      partition: partitionOf(route),
      deadline: config.deadline,
      receipt: {
        kind,
        key,
        digest: createHash('sha256')
          .update(canonicalize([identity, kind, { orderId }])!)
          .digest(),
      },
      authorization,
    },
    async (_tx, command) => {
      // Receipt replay precedes eligibility: a later worker revision cannot invalidate it.
      // Missing creation correlation belongs to the existing recovery path, never a new charge.
      if (!config.repairAvailable || !current?.checkoutSessionId)
        throw new StripeUnavailableError('Recorded Checkout Session unavailable');
      return {
        value: { orderId, reconciliation: 'queued' },
        events: [
          {
            type: 'com.rezics.commerce.order.repair_requested.v1',
            subject: orderId,
            data: { orderId, name: command.transactionId },
          },
        ],
      };
    },
  );
}
