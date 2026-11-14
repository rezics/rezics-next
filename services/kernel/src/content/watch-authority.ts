import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { resourceAuthorization } from './access-port.ts';
import {
  CommandUnavailableError,
  principalCommandIdentity,
  type CommandAuthorization,
  type CommandTransaction,
} from '../command/command.ts';
import { AccessUnavailableError, throwAccessUnavailable } from '../access/unavailable.ts';
import { withBoundedReadConnection } from '../database/pool.ts';
import { ProblemError } from '../http/problem-error.ts';
import { accessCheck } from './access-port.ts';
import type { Access, Actor } from '../request/access.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import type { KeyRing } from '../tokens/seal.ts';
import { declareCommandHistory } from '../history/application/index.ts';
import { ACCOUNT_ROLE_BITS } from '../history/contract/index.ts';

export type WatchDependencies = Readonly<{ pool: Pool; access: Access; tokens: KeyRing; clock: () => Date }>;
export type WatchKind = 'thread' | 'board';

/** Keep native failure mapping inside the shared lifetime, after it observes query settlement. */
export const watchReadOptions = {
  deadlineError: () => new AccessUnavailableError('deadline'),
  mapError(error: unknown) {
    if (error instanceof CommandUnavailableError) return error;
    try {
      throwAccessUnavailable(error);
    } catch (mapped) {
      return mapped;
    }
    return error;
  },
  // The shared lifetime already excludes settled PostgreSQL ERROR responses.
  isUncertainSettledQueryError: (error: unknown) => !(error instanceof CommandUnavailableError),
};

/** The acting account owns the range, including when an operator opened the session. */
export function watchOwner(actor: Actor, accountId?: string) {
  if (actor.kind !== 'account') throw new ProblemError('authentication_required');
  if (actor.requestedBy !== null && actor.requestedBy !== actor.accountId) throw new ProblemError('not_found');
  if (accountId !== undefined && accountId !== actor.accountId) throw new ProblemError('not_found');
  const route = routeOf(actor.accountId);
  if (route === null) throw new ProblemError('not_found');
  return { actor, route, id: actor.accountId };
}

/** Shared Access validates the actual credential and current account, before cursors or receipts. */
export async function requireWatchOwner(deps: WatchDependencies, actor: Actor, deadline: number, accountId?: string) {
  const owner = watchOwner(actor, accountId);
  const check = await accessCheck(
    deps.access,
    actor,
    'account:read',
    { route: owner.route, id: owner.id },
    {
      pool: deps.pool,
      deadline,
    },
  );
  await withBoundedReadConnection(
    deps.pool,
    deadline,
    async (connection) => {
      if (!(await check(connection))) throw new ProblemError('not_found');
    },
    watchReadOptions,
  );
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

export type WatchRemoveAdvice = 'available' | 'denied';

/** One current account:update observation for the whole page; never a per-row Access fetch. */
export async function watchRemoveAdvice(
  deps: WatchDependencies,
  actor: Actor,
  owner: ReturnType<typeof watchOwner>,
  deadline: number,
): Promise<WatchRemoveAdvice> {
  const update = await accessCheck(
    deps.access,
    actor,
    'account:update',
    { route: owner.route, id: owner.id },
    { pool: deps.pool, deadline },
  );
  return withBoundedReadConnection(
    deps.pool,
    deadline,
    async (connection) => ((await update(connection)) ? 'available' : 'denied'),
    watchReadOptions,
  );
}

export function watchReceipt(actor: Actor, kind: string, key: string, input: unknown) {
  return {
    kind,
    key,
    digest: createHash('sha256')
      .update(JSON.stringify([principalCommandIdentity(actor), input]))
      .digest(),
  };
}

/** Enroll private receipt/event copies in the existing account erasure protocol. */
export async function declareWatchHistory(
  tx: CommandTransaction,
  kind: 'content.board.watch' | 'content.watch.remove',
  owner: ReturnType<typeof watchOwner>,
  changed: boolean,
) {
  const accounts = [{ accountId: owner.id, accountRoute: owner.route, roles: ACCOUNT_ROLE_BITS.owner }];
  await declareCommandHistory(tx, kind, {
    response: { artifactType: 'command-receipt/v1', accounts },
    events: changed ? [{ artifactType: 'outbox-event/v1', accounts }] : [],
  });
}
