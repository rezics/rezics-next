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
import { createAppealEffect } from './appeals.ts';
import { writeNotices } from './notices.ts';
import readDecision from './read-moderation-decision.sql';
import readHistorySource from './moderation-history-source.sql';
import projectHistory from './project-moderation-history.sql';
import currentTarget from './moderation-history-target.sql';

const takedownType = 'com.rezics.content.moderation.takedown.v1';
const appealWindowMs = 183 * 24 * 60 * 60 * 1000;
export const ModerationDecisionSchema = t.Object(
  {
    id: t.String(),
    targetKind: t.Union([t.Literal('board'), t.Literal('thread'), t.Literal('post')]),
    targetId: t.String(),
    action: t.Literal('takedown'),
    statement: t.String(),
    decidedAt: t.String({ format: 'date-time' }),
    appealDeadline: t.Union([t.String({ format: 'date-time' }), t.Null()]),
    appeal: t.Union([
      t.Object(
        {
          id: t.String(),
          outcome: t.Union([t.Literal('upheld'), t.Literal('reversed'), t.Null()]),
          statement: t.Union([t.String(), t.Null()]),
          resolvedAt: t.Union([t.String({ format: 'date-time' }), t.Null()]),
        },
        { additionalProperties: false },
      ),
      t.Null(),
    ]),
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
    const [target] = await currentTarget.run(client, { route, kind: decision.target_kind, id: decision.target_id });
    return target ? { decision, target } : null;
  });
  if (!observed.value || context.actor.kind !== 'account') return null;
  const { decision, target } = observed.value;
  let anchor = observed.anchor;
  if (decision.target_kind === 'board' || target.author_account_id !== context.actor.accountId) {
    if (!target.available) return null;
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
      targetKind: decision.target_kind as 'board' | 'thread' | 'post',
      targetId: decision.target_id,
      action: 'takedown' as const,
      statement: decision.statement,
      decidedAt: decidedAt.toISOString(),
      appealDeadline:
        decision.target_kind === 'board' ? null : new Date(decidedAt.getTime() + appealWindowMs).toISOString(),
      appeal:
        decision.appeal_id === null
          ? null
          : {
              id: decision.appeal_id,
              outcome: decision.outcome as 'upheld' | 'reversed' | null,
              statement: decision.resolver_statement,
              resolvedAt: decision.resolved_at === null ? null : new Date(decision.resolved_at).toISOString(),
            },
    },
    anchor,
  };
}

async function writeOnRoute<T>(
  pool: Pool,
  route: number,
  deadline: number,
  work: (client: AccessClient) => Promise<T>,
): Promise<T> {
  return withConnection(pool, async (connection) => {
    const client = deadlineClient(connection, deadline);
    try {
      await client.query('BEGIN');
      const partitionNo = partitionOf(route);
      const partition = await readPartition(client, partitionNo);
      if (!partition) throw new CommandUnavailableError('deadline', partitionNo);
      if (partition.writeState !== 'active')
        throw new CommandUnavailableError(
          partition.writeState === 'moved' ? 'moved' : 'fenced',
          partitionNo,
          partition.movedTo,
        );
      const value = await work(client);
      await client.query('COMMIT');
      return value;
    } catch (error) {
      try {
        await connection.query('ROLLBACK');
      } catch (rollbackError) {
        discardConnection(connection, rollbackError as Error);
      }
      throw error;
    }
  });
}

export function createModerationDecisionEffect(pool: Pool): Effect {
  const appeals = createAppealEffect(pool);
  return {
    name: 'content_moderation_decision',
    types: [takedownType, ...appeals.types],
    async run(event) {
      if (appeals.types.includes(event.type)) return appeals.run(event);
      if (event.type !== takedownType || !Value.Check(CONTENT_EVENTS[takedownType], event.data))
        throw new TypeError('Invalid moderation decision event');
      const data = event.data as {
        targetKind: 'board' | 'thread' | 'post';
        targetId: string;
        securityRevision: string;
      };
      const route = routeOf(data.targetId);
      const source = /^urn:rezics:log:(\d+)\.([1-9][0-9]*)$/.exec(event.source);
      if (route === null || !source || Number(source[1]) !== partitionOf(route) || !/^\d{19}$/.test(event.sequence))
        throw new TypeError('Invalid moderation decision source');
      const deadline = Date.now() + 30_000;
      const { value: decision } = await snapshot(pool, route, deadline, async (client, partition) => {
        if (
          Number(source[2]) > partition.epoch ||
          (Number(source[2]) === partition.epoch && BigInt(event.sequence) > partition.position)
        )
          throw new Error('Moderation decision source unavailable');
        const [row] = await readHistorySource.run(client, {
          route,
          target_kind: data.targetKind,
          target_id: data.targetId,
          security_revision: data.securityRevision,
        });
        if (!row) throw new Error('Moderation decision source missing');
        return row;
      });
      const boardId = decision.board_id;
      const decidedAt = decision.decided_at;
      if (boardId === null) return;
      if (decidedAt === null) throw new Error('Moderation decision timestamp missing');
      const boardRoute = routeOf(boardId);
      if (boardRoute === null) throw new TypeError('Invalid moderation history board');
      // The source snapshot is released before projecting references onto the board partition.
      await writeOnRoute(pool, boardRoute, deadline, (client) =>
        projectHistory.run(client, {
          route: boardRoute,
          board_id: boardId,
          decision_id: decision.decision_id,
          target_kind: decision.target_kind,
          target_id: decision.target_id,
          decided_at: decidedAt,
        }),
      );
      const authorAccountId = decision.author_account_id;
      if (authorAccountId === null) return;
      const recipientRoute = routeOf(authorAccountId)!;
      await writeOnRoute(pool, recipientRoute, deadline, async (client) => {
        if (await notificationAllowed(client, { recipient: authorAccountId, kind: 'moderation_decision' }))
          await writeNotices(client, [
            {
              recipientId: authorAccountId,
              noticeId: newId(recipientRoute),
              kind: 'moderation_decision',
              actorId: null,
              threadId: decision.thread_id,
              postId: decision.post_id,
              decisionId: decision.decision_id,
              reportId: null,
              sourceId: decision.decision_id,
              createdAt: new Date(decidedAt),
            },
          ]);
      });
    },
  };
}
