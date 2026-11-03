import { createHmac } from 'node:crypto';
import type { Pool } from 'pg';
import { t } from 'elysia';
import { deadlineClient, within } from '../access/authenticate.ts';
import { CommandUnavailableError } from '../command/command.ts';
import { discardConnection, withConnection } from '../database/pool.ts';
import { ProblemError } from '../http/problem.ts';
import { readPartition } from '../partition/partition.ts';
import { accessCheck, AuthenticationError, type AccessClient, type Actor } from '../request/access.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { decodeCursor, encodeCursor, type CursorBinding } from '../tokens/cursor.ts';
import type { KeyRing } from '../tokens/seal.ts';
import { ModerationDecisionSchema, readModerationDecision } from './moderation-decisions.ts';
import currentTarget from './moderation-history-target.sql';
import page from './page-moderation-history.sql';
import selectedPage from './moderation-history-kind-page.sql';
import type { ModerationDependencies } from './moderation.ts';

export const MODERATION_HISTORY_MAX_LIMIT = 100;

const missing = () => new ProblemError('not_found');
const invalidCursor = () => new ProblemError('invalid_cursor');

export const ModerationHistoryQuerySchema = t.Object(
  {
    cursor: t.Optional(t.String()),
    limit: t.Optional(t.Integer({ minimum: 1, maximum: MODERATION_HISTORY_MAX_LIMIT })),
    targetKind: t.Optional(t.Union([t.Literal('all'), t.Literal('board'), t.Literal('thread'), t.Literal('post')])),
  },
  { additionalProperties: false },
);

export type ModerationHistoryQuery = {
  cursor?: string;
  limit?: number;
  targetKind?: 'all' | 'board' | 'thread' | 'post';
};

export const ModerationHistoryPageSchema = t.Object(
  {
    entries: t.Array(ModerationDecisionSchema),
    nextCursor: t.Union([t.String(), t.Null()]),
  },
  { additionalProperties: false },
);

type HistoryContext = { actor: Actor; deadline: number };
type Candidate = {
  decision_id: string;
  target_kind: 'board' | 'thread' | 'post';
  target_id: string;
  decided_at: string;
};

function cursorRing(routeKey: Uint8Array): KeyRing {
  if (routeKey.byteLength < 32) throw new RangeError('Moderation history route key must contain at least 32 bytes');
  return {
    current: 1,
    keys: new Map([[1, createHmac('sha256', routeKey).update('content.moderation-history.cursor.v1').digest()]]),
  };
}

async function snapshot<T>(
  pool: Pool,
  route: number,
  deadline: number,
  read: (client: AccessClient) => Promise<T>,
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
        const value = await read(client);
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

export async function listModerationHistory(
  deps: Pick<ModerationDependencies, 'pool' | 'access' | 'routeKey'>,
  boardId: string,
  context: HistoryContext,
  query: ModerationHistoryQuery,
) {
  if (context.actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
  const route = routeOf(boardId);
  if (route === null) throw missing();
  const limit = query.limit ?? 20;
  const targetKind = query.targetKind ?? 'all';
  if (!Number.isInteger(limit) || limit < 1 || limit > MODERATION_HISTORY_MAX_LIMIT || !['all', 'board', 'thread', 'post'].includes(targetKind))
    throw new ProblemError('invalid_request');

  const boardCheck = await accessCheck(
    deps.access,
    context.actor,
    'moderation:takedown',
    { route, id: boardId },
    { pool: deps.pool, deadline: context.deadline },
  );
  const checkBoard = async (client: AccessClient) =>
    (await boardCheck(client)) &&
    (await currentTarget.run(client, { route, kind: 'board', id: boardId })).length === 1;
  const initial = await snapshot(deps.pool, route, context.deadline, checkBoard);
  if (!initial.value) throw missing();

  const ring = cursorRing(deps.routeKey);
  const binding: CursorBinding = {
    operation: 'content.board-moderation-history.v1',
    parameters: {
      boardId,
      targetKind,
      limit,
      actor: context.actor.accountId,
      client: context.actor.clientId,
      requestedBy: context.actor.requestedBy,
      authnEpoch: context.actor.authnEpoch,
      scopes: JSON.stringify([...new Set(context.actor.scopes)].sort()),
    },
  };
  let after = { at: 'infinity', id: 'ffffffff-ffff-ffff-ffff-ffffffffffff' };
  if (query.cursor !== undefined) {
    const decoded = decodeCursor(ring, binding, query.cursor);
    if (
      !decoded.ok ||
      decoded.epoch !== initial.anchor.epoch ||
      decoded.after.length !== 2 ||
      typeof decoded.after[0] !== 'string' ||
      typeof decoded.after[1] !== 'string' ||
      !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/.test(decoded.after[0]) ||
      !Number.isFinite(Date.parse(decoded.after[0])) ||
      routeOf(decoded.after[1]) === null
    )
      throw invalidCursor();
    after = { at: decoded.after[0], id: decoded.after[1] };
  }

  const candidates = await snapshot(deps.pool, route, context.deadline, (client) =>
    (targetKind === 'all' ? page : selectedPage).run(client, {
      route,
      board_id: boardId,
      target_kind: targetKind,
      after_decided_at: after.at,
      after_decision_id: after.id,
      limit: limit + 1,
    }),
  );
  const selected = candidates.value.slice(0, limit) as Candidate[];
  const entries = [];
  for (const candidate of selected) {
    const targetRoute = routeOf(candidate.target_id);
    if (targetRoute === null || routeOf(candidate.decision_id) !== targetRoute)
      throw new Error('Moderation history candidate route mismatch');
    const targetCheck = await accessCheck(
      deps.access,
      context.actor,
      'moderation:takedown',
      { route: targetRoute, id: candidate.target_id },
      { pool: deps.pool, deadline: context.deadline },
    );
    const current = await snapshot(deps.pool, targetRoute, context.deadline, async (client) => {
      if (!(await targetCheck(client))) return false;
      const [target] = await currentTarget.run(client, {
        route: targetRoute, kind: candidate.target_kind, id: candidate.target_id,
      });
      return target?.available === true && target.board_id === boardId;
    });
    if (!current.value) continue;

    const exact = await readModerationDecision(
      { pool: deps.pool, access: deps.access },
      candidate.decision_id,
      context,
    );
    if (
      !exact?.value ||
      exact.value.targetKind !== candidate.target_kind ||
      exact.value.targetId !== candidate.target_id
    )
      continue;
    entries.push(exact.value);
  }

  const final = await snapshot(deps.pool, route, context.deadline, checkBoard);
  if (!final.value) throw missing();
  const last = selected.at(-1);
  return {
    value: {
      entries,
      nextCursor:
        candidates.value.length > limit && last
          ? encodeCursor(ring, binding, {
              epoch: final.anchor.epoch,
              after: [last.decided_at, last.decision_id],
            })
          : null,
    },
    anchor: final.anchor,
  };
}
