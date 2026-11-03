import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { resourceAuthorization } from '../access/index.ts';
import { deadlineClient, within } from '../access/authenticate.ts';
import { principalCommandIdentity, type CommandAuthorization } from '../command/command.ts';
import { withConnection } from '../database/pool.ts';
import { ProblemError } from '../http/problem.ts';
import { accessCheck, type Access, type Actor } from '../request/access.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import type { KeyRing } from '../tokens/seal.ts';

export type WatchDependencies = Readonly<{ pool: Pool; access: Access; tokens: KeyRing; clock?: () => Date }>;
export type WatchKind = 'thread' | 'board';

/** The acting account owns the range, including when an operator opened the session. */
export function watchOwner(actor: Actor, accountId?: string) {
  if (actor.kind !== 'account') throw new ProblemError('authentication_required');
  if (accountId !== undefined && accountId !== actor.accountId) throw new ProblemError('not_found');
  const route = routeOf(actor.accountId);
  if (route === null) throw new ProblemError('not_found');
  return { actor, route, id: actor.accountId };
}

/** Shared Access validates the actual credential and current account, before cursors or receipts. */
export async function requireWatchOwner(deps: WatchDependencies, actor: Actor, deadline: number, accountId?: string) {
  const owner = watchOwner(actor, accountId);
  const check = await accessCheck(deps.access, actor, 'account:read', { route: owner.route, id: owner.id }, {
    pool: deps.pool,
    deadline,
  });
  await within(deadline, () => withConnection(deps.pool, async (connection) => {
    if (!(await check(deadlineClient(connection, deadline)))) throw new ProblemError('not_found');
  }));
  return owner;
}

export function watchAuthorization(deps: WatchDependencies, actor: Actor, deadline: number): CommandAuthorization {
  const owner = watchOwner(actor);
  return resourceAuthorization({
    access: deps.access,
    actor,
    action: 'account:update',
    anchor: { resource: { route: owner.route, id: owner.id }, validate: async () => true },
    context: { pool: deps.pool, deadline, partition: partitionOf(owner.route) },
  });
}

export function watchReceipt(actor: Actor, kind: string, key: string, input: unknown) {
  return {
    kind,
    key,
    digest: createHash('sha256').update(JSON.stringify([principalCommandIdentity(actor), input])).digest(),
  };
}
