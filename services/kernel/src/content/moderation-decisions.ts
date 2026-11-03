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
import readDecisionSource from './decision-page-source.sql';
import readHistorySource from './moderation-history-source.sql';
import projectHistory from './project-moderation-history.sql';

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

type DecisionSource = NonNullable<Awaited<ReturnType<typeof readDecisionSource.run>>>;

/** Equality includes retained fields, appeal facts and current target placement.
 * Compare source text as well: statement retention may expire without a write. */
function sameDecisionSource(left: DecisionSource, right: DecisionSource) {
  return left.witness === right.witness && left.statement === right.statement;
}

/** Only these retained fields leave the source reader. In particular, the
 * equality witness contains private identities and must never be serialized. */
function decisionValue(decision: DecisionSource) {
  const decidedAt = new Date(decision.decided_at);
  return {
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
  };
}

/** Author access is independent of the visibility of the taken-down target.
 * Foreign authority preparation happens after releasing selection. The final
 * observation checks the actual selected source and partition, then current
 * moderator authority in that same native snapshot. It never grants target text. */
export async function readModerationDecision(
  deps: { pool: Pool; access: Access },
  id: string,
  context: { actor: Actor; deadline: number },
) {
  const result = await composeModerationDecision(deps, id, context, async () => ({
    observe: async () => true,
    value: async () => ({}),
  }));
  return result && { value: result.value, anchor: result.anchor };
}

/** Foreign page preparation and observations must finish before final source
 * checkout. Only the explicit projection leaves this reader; the witness stays
 * private. Existing DTO-only readers use the same source and authority gate. */
export async function composeModerationDecision<T extends object>(
  deps: { pool: Pool; access: Access },
  id: string,
  context: { actor: Actor; deadline: number },
  prepare: (source: DecisionSource) => Promise<{
    observe: () => Promise<boolean>;
    value: (client: AccessClient, source: DecisionSource) => Promise<T>;
  }>,
) {
  const route = routeOf(id);
  if (route === null || context.actor.kind !== 'account') return null;
  const selected = await snapshot(deps.pool, route, context.deadline, (client) =>
    readDecisionSource.run(client, { route, decision_id: id }),
  );
  if (!selected.value) return null;
  const needsModerator =
    selected.value.target_kind === 'board' || selected.value.author_account_id !== context.actor.accountId;
  if (needsModerator && !selected.value.available) return null;
  const page = await prepare(selected.value);
  // Access may acquire other connections. Keep it outside the source checkout;
  // no positive authorization result survives into the final observation.
  const check = needsModerator
    ? await accessCheck(
        deps.access,
        context.actor,
        'moderation:takedown',
        { route, id: selected.value.target_id },
        { pool: deps.pool, deadline: context.deadline },
      )
    : null;
  if (!(await page.observe())) return null;
  const final = await snapshot(deps.pool, route, context.deadline, async (client, partition) => {
    if (partition.epoch !== selected.anchor.epoch) return null;
    const source = await readDecisionSource.run(client, { route, decision_id: id });
    if (!source || !sameDecisionSource(selected.value!, source)) return null;
    if (check && !(await check(client))) return null;
    return { source, page: await page.value(client, source) };
  });
  if (!final.value) return null;
  return { value: { ...decisionValue(final.value.source), ...final.value.page }, anchor: final.anchor };
}

/** Inbox disclosure is limited to the current author of a post or thread.
 * This deliberately does not treat a moderator's inspection grant as notice ownership. */
export async function readModerationDecisionForAuthor(
  deps: { pool: Pool; access: Access },
  id: string,
  context: { actor: Actor; deadline: number },
) {
  if (context.actor.kind !== 'account') return null;
  const accountId = context.actor.accountId;
  const route = routeOf(id);
  if (route === null) return null;
  const reference = () =>
    snapshot(deps.pool, route, context.deadline, async (client) => {
      const source = await readDecisionSource.run(client, { route, decision_id: id });
      return source && source.target_kind !== 'board' && source.author_account_id === accountId ? source : null;
    });
  const before = await reference();
  if (!before.value) return null;
  const current = await readModerationDecision(deps, id, context);
  if (!current?.value) return null;
  const after = await reference();
  if (
    !after.value ||
    before.anchor.epoch !== after.anchor.epoch ||
    current.anchor.epoch !== after.anchor.epoch ||
    !sameDecisionSource(before.value, after.value)
  )
    return null;
  // Match every exposed field too, including retention and the resolver's
  // statement; an intervening read must not substitute another source version.
  const expected = decisionValue(after.value);
  if (
    current.value.id !== expected.id ||
    current.value.targetKind !== expected.targetKind ||
    current.value.targetId !== expected.targetId ||
    current.value.action !== expected.action ||
    current.value.statement !== expected.statement ||
    current.value.decidedAt !== expected.decidedAt ||
    current.value.appealDeadline !== expected.appealDeadline ||
    (current.value.appeal?.id ?? null) !== (expected.appeal?.id ?? null) ||
    (current.value.appeal?.outcome ?? null) !== (expected.appeal?.outcome ?? null) ||
    (current.value.appeal?.statement ?? null) !== (expected.appeal?.statement ?? null) ||
    (current.value.appeal?.resolvedAt ?? null) !== (expected.appeal?.resolvedAt ?? null)
  )
    return null;
  return { value: expected, anchor: after.anchor };
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
