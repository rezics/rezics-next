import type { Pool } from 'pg';
import { ProblemError } from '../http/problem.ts';
import { resourceAuthorization } from '../access/index.ts';
import { GrantDeniedError } from '../access/grant-commands.ts';
import { authoritativeTimeValue, noEffect, runCommand } from '../command/command.ts';
import type { Access, AccountActor } from '../request/access.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { ContextNotFoundError } from './context.ts';
import { GLOBAL_CONTEXT } from './definitions.ts';
import { RECORD_DELETED, RECORD_RESTORED } from './events.ts';
import { readSemanticLifecycle } from './lifecycle-state.ts';
import readContext from './lifecycle-read-context.sql';
import writeContext from './context-lifecycle-write.sql';

export class ContextLifecycleConflictError extends Error {
  constructor() {
    super('Context restoration window has ended');
    this.name = 'ContextLifecycleConflictError';
  }
}

/** Lifecycle commands authorize the stable identity, including its tombstone. Normal readers use active anchors. */
export async function changeContextLifecycle(
  pool: Pool,
  options: {
    context: string;
    state: 'active' | 'deleted';
    actor: AccountActor;
    access: Access;
    idempotencyKey: string;
    digest: Uint8Array;
    deadline: number;
    clock: () => Date;
  },
) {
  const { context, actor, state } = options;
  const route = routeOf(context);
  if (route === null) throw new ContextNotFoundError();
  const resource = { route, id: context };
  const action = state === 'deleted' ? 'context:delete' : 'context:restore';
  const authorization = resourceAuthorization({
    access: options.access,
    actor,
    action,
    anchor: {
      resource,
      async validate(client, time) {
        const evidence = await readSemanticLifecycle(client, {
          target: { kind: 'context', context },
          accountId: actor.accountId,
          nativeT: time,
        });
        if (!evidence) throw new ProblemError('not_found');
        // Direct current owner evidence is an additional prerequisite, never an Access allow decision.
        return context !== GLOBAL_CONTEXT && evidence.owner?.kind === 'owner_grant';
      },
    },
    context: { pool, deadline: options.deadline, partition: partitionOf(route) },
  });
  const command = await runCommand(
    pool,
    {
      partition: partitionOf(route),
      deadline: options.deadline,
      clock: options.clock,
      receipt: { actorAccountId: actor.accountId, kind: action, key: options.idempotencyKey, digest: options.digest },
      basis: { actorAccountId: actor.accountId, clientId: actor.clientId, requestedBy: actor.requestedBy },
      authorization,
    },
    async (tx, { time }) => {
      const row = await readContext.run(tx, { route, context_id: context });
      if (!row) throw new ContextNotFoundError();
      if (row.kind !== 'community') throw new GrantDeniedError();
      const value = { id: context, state };
      if (row.state === state) return noEffect(value);
      const [changed] = await writeContext.run(tx, {
        route,
        context_id: context,
        state,
        at: authoritativeTimeValue(time),
      });
      if (!changed) throw new ContextLifecycleConflictError();
      return {
        value,
        events: [
          {
            type: state === 'deleted' ? RECORD_DELETED : RECORD_RESTORED,
            subject: context,
            data: { kind: 'context', id: context, version: changed.version },
          },
        ],
      };
    },
  );
  return {
    context: command.value,
    component: { partition: command.partition, epoch: command.epoch, position: command.position },
    replayed: command.replayed,
  };
}
