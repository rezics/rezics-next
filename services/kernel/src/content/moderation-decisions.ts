import type { Pool } from 'pg';
import { t } from 'elysia';
import { Value } from 'typebox/value';
import { deadlineClient, within } from '../access/authenticate.ts';
import { notificationAllowed } from '../access/preferences.ts';
import { CommandUnavailableError } from '../command/command.ts';
import { discardConnection, withConnection } from '../database/pool.ts';
import type { Effect } from '../events/effects.ts';
import { readPartition, type Partition } from '../partition/partition.ts';
import { accessCheck, type Access, type AccessClient, type Actor } from '../request/access.ts';
import { newId, partitionOf, routeOf } from '../route/route.ts';
import { CONTENT_EVENTS } from './events.ts';
import { writeNotices } from './notices.ts';
import readDecision from './read-moderation-decision.sql';
import findDecision from './find-moderation-decision.sql';
import author from './author-moderation-decision.sql';

const takedownType = 'com.rezics.content.moderation.takedown.v1';
const appealWindowMs = 183 * 24 * 60 * 60 * 1000;
export const ModerationDecisionSchema = t.Object(
  {
    id: t.String(),
    targetKind: t.Union([t.Literal('thread'), t.Literal('post')]),
    targetId: t.String(),
    action: t.Literal('takedown'),
    statement: t.String(),
    decidedAt: t.String({ format: 'date-time' }),
    appealDeadline: t.String({ format: 'date-time' }),
  },
  { additionalProperties: false },
);

/** All source reads use the target's independently anchored snapshot. */
async function snapshot<T>(
  pool: Pool,
  route: number,
  deadline: number,
  read: (client: AccessClient, partition: Partition) => Promise<T>,
) {
  return within(deadline, () =>
    withConnection(pool, async (connection) => {
      const client = deadlineClient(connection, deadline);
      try {
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        const partitionNo = partitionOf(route);
        const partition = await readPartition(client, partitionNo);
        if (!partition) throw new CommandUnavailableError('deadline', partitionNo);
        if (partition.writeState === 'moved')
          throw new CommandUnavailableError('moved', partitionNo, partition.movedTo);
        const value = await read(client, partition);
        await client.query('COMMIT');
        return { value, anchor: { partition: partitionNo, epoch: partition.epoch, position: partition.position } };
      } catch (error) {
        try {
          await connection.query('ROLLBACK');
        } catch (rollbackError) {
          discardConnection(connection, rollbackError as Error);
        }
        throw error;
      }
    }),
  );
}

/** Author access is independent of the visibility of the taken-down target. */
export async function readModerationDecision(
  deps: { pool: Pool; access: Access },
  id: string,
  context: { actor: Actor; deadline: number },
) {
  const route = routeOf(id);
  if (route === null) return null;
  const observed = await snapshot(deps.pool, route, context.deadline, async (client) => {
    const decision = await readDecision.run(client, { route, decision_id: id });
    if (!decision) return null;
    const [target] = await author.run(client, {
      route,
      target_kind: decision.target_kind,
      target_id: decision.target_id,
    });
    return target ? { decision, target } : null;
  });
  if (!observed.value || context.actor.kind !== 'account') return null;
  const { decision, target } = observed.value;
  let anchor = observed.anchor;
  if (target.author_account_id !== context.actor.accountId) {
    // Preparation may acquire a connection; release the source checkout first.
    const check = await accessCheck(
      deps.access,
      context.actor,
      'moderation:takedown',
      { route, id: decision.target_id },
      { pool: deps.pool, deadline: context.deadline },
    );
    const authorized = await snapshot(deps.pool, route, context.deadline, (client) => check(client));
    if (!authorized.value) return null;
    anchor = authorized.anchor;
  }
  const decidedAt = new Date(decision.decided_at);
  return {
    value: {
      id: decision.decision_id,
      targetKind: decision.target_kind as 'thread' | 'post',
      targetId: decision.target_id,
      action: 'takedown' as const,
      statement: decision.statement,
      decidedAt: decidedAt.toISOString(),
      appealDeadline: new Date(decidedAt.getTime() + appealWindowMs).toISOString(),
    },
    anchor,
  };
}

export function createModerationDecisionEffect(pool: Pool): Effect {
  return {
    name: 'content_moderation_decision',
    types: [takedownType],
    async run(event) {
      if (event.type !== takedownType || !Value.Check(CONTENT_EVENTS[takedownType], event.data))
        throw new TypeError('Invalid moderation decision event');
      const data = event.data as {
        targetKind: 'board' | 'thread' | 'post';
        targetId: string;
        securityRevision: string;
      };
      if (data.targetKind === 'board') return;
      const route = routeOf(data.targetId);
      const source = /^urn:rezics:log:(\d+)\.([1-9][0-9]*)$/.exec(event.source);
      if (route === null || !source || Number(source[1]) !== partitionOf(route) || !/^\d{19}$/.test(event.sequence))
        throw new TypeError('Invalid moderation decision source');
      const deadline = Date.now() + 30_000;
      const { value } = await snapshot(pool, route, deadline, async (client, partition) => {
        if (
          Number(source[2]) > partition.epoch ||
          (Number(source[2]) === partition.epoch && BigInt(event.sequence) > partition.position)
        )
          throw new Error('Moderation decision source unavailable');
        const decision = await findDecision.run(client, {
          route,
          target_kind: data.targetKind,
          target_id: data.targetId,
          security_revision: data.securityRevision,
        });
        if (!decision) throw new Error('Moderation decision source missing');
        const [target] = await author.run(client, { route, target_kind: data.targetKind, target_id: data.targetId });
        return target ? { decision, target } : null;
      });
      if (!value) return;
      const { decision, target } = value;
      // Release the source partition before checking the recipient and writing its notice.
      await withConnection(pool, async (connection) => {
        const client = deadlineClient(connection, deadline);
        try {
          await client.query('BEGIN');
          const recipientRoute = routeOf(target.author_account_id)!;
          const partitionNo = partitionOf(recipientRoute);
          const partition = await readPartition(client, partitionNo);
          if (!partition) throw new CommandUnavailableError('deadline', partitionNo);
          if (partition.writeState !== 'active')
            throw new CommandUnavailableError(
              partition.writeState === 'moved' ? 'moved' : 'fenced',
              partitionNo,
              partition.movedTo,
            );
          if (await notificationAllowed(client, { recipient: target.author_account_id, kind: 'moderation_decision' }))
            await writeNotices(client, [
              {
                recipientId: target.author_account_id,
                noticeId: newId(recipientRoute),
                kind: 'moderation_decision',
                actorId: null,
                threadId: target.thread_id,
                postId: target.post_id,
                decisionId: decision.decision_id,
                reportId: null,
                sourceId: decision.decision_id,
                createdAt: new Date(decision.decided_at),
              },
            ]);
          await client.query('COMMIT');
        } catch (error) {
          try {
            await connection.query('ROLLBACK');
          } catch (rollbackError) {
            discardConnection(connection, rollbackError as Error);
          }
          throw error;
        }
      });
    },
  };
}
