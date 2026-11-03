import { createHash, createHmac } from 'node:crypto';
import canonicalize from 'canonicalize';
import { resourceAuthorization } from '../access/index.ts';
import { GrantDeniedError } from '../access/grant-commands.ts';
import { deadlineClient } from '../access/authenticate.ts';
import {
  authoritativeTimeValue, principalCommandIdentity, runCommand,
  type AuthoritativeTime, type CommandTransaction,
} from '../command/command.ts';
import { withConnection } from '../database/pool.ts';
import { accessExplicitCheck, type Actor, type AccessExplicitCheck, type AccessClient } from '../request/access.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import type { ContentCommandDependencies } from './commands.ts';
import type { RequestContext } from './model.ts';

export class BoardSlowModeError extends Error {
  constructor(readonly retryAt: string, readonly intervalSeconds: number) {
    super('Board posting interval has not elapsed');
  }
}

export class BoardSlowModeInputError extends Error {}
const kind = 'content.board.slow-mode.set';
const resource = (boardId: string) => {
  const route = routeOf(boardId);
  if (route === null) throw new BoardSlowModeInputError();
  return { route, id: boardId };
};
const actorKey = (deps: ContentCommandDependencies, boardId: string, actor: Actor) => {
  if (actor.kind !== 'account') throw new GrantDeniedError();
  return createHmac('sha256', deps.routeKey).update(`content.board.slow-mode\n${boardId}\n${actor.accountId}`).digest();
};

async function setting(client: AccessClient, boardId: string) {
  const board = resource(boardId);
  const result = await client.query<{ interval_seconds: number }>(
    'SELECT interval_seconds FROM content.board_slow_mode WHERE route=$1 AND board_id=$2',
    [board.route, board.id],
  );
  return result.rows[0]?.interval_seconds ?? 0;
}

/** Prepare outside the write checkout; re-evaluate the explicit board capability at its original T. */
export function boardSlowAdmission(deps: ContentCommandDependencies, actor: Actor, context: RequestContext) {
  const checks = new WeakMap<AuthoritativeTime, AccessExplicitCheck>();
  return {
    async prepare(boardId: string, time: AuthoritativeTime) {
      checks.set(time, await accessExplicitCheck(deps.access, actor, 'moderation:takedown', resource(boardId), {
        pool: deps.pool, deadline: context.deadline,
      }));
    },
    async reserve(tx: CommandTransaction, boardId: string, time: AuthoritativeTime) {
      const seconds = await setting(tx, boardId);
      if (!seconds) return;
      const check = checks.get(time);
      if (!check) throw new GrantDeniedError();
      const exemption = await check(tx, time);
      if (exemption.allowed && exemption.explicit) return;
      const board = resource(boardId);
      const key = actorKey(deps, boardId, actor);
      const at = authoritativeTimeValue(time);
      // The unique board/actor key serializes distinct content routes. A serializable
      // loser retries through runCommand with fresh Access evidence. Rollback releases
      // the reservation together with all content, grants, receipt and events.
      const admitted = await tx.query(
        `INSERT INTO content.board_slow_actor(route,board_id,actor_key,posted_at)
         VALUES ($1,$2,$3,$4::timestamptz)
         ON CONFLICT (route,board_id,actor_key) DO UPDATE SET posted_at=EXCLUDED.posted_at
         WHERE content.board_slow_actor.posted_at + $5::integer * interval '1 second' <= EXCLUDED.posted_at
         RETURNING posted_at`,
        [board.route, board.id, key, at, seconds],
      );
      if (admitted.rowCount) return;
      const retry = await tx.query<{ retry_at: string }>(
        `SELECT ceil(extract(epoch FROM (posted_at + $4::integer * interval '1 second')) * 1000)::bigint::text AS retry_at
         FROM content.board_slow_actor WHERE route=$1 AND board_id=$2 AND actor_key=$3`,
        [board.route, board.id, key, seconds],
      );
      throw new BoardSlowModeError(new Date(Number(retry.rows[0]!.retry_at)).toISOString(), seconds);
    },
  };
}

export async function setBoardSlowMode(
  deps: ContentCommandDependencies, actor: Actor, boardId: string, intervalSeconds: number, context: RequestContext,
) {
  if (actor.kind !== 'account') throw new GrantDeniedError();
  if (!Number.isInteger(intervalSeconds) || intervalSeconds < 0 || intervalSeconds > 86400)
    throw new BoardSlowModeInputError();
  const board = resource(boardId);
  const identity = principalCommandIdentity(actor);
  const authorization = resourceAuthorization({
    access: deps.access, actor, action: 'moderation:takedown',
    anchor: {
      resource: board,
      async validate(client) {
        const row = await client.query('SELECT 1 FROM content.board WHERE route=$1 AND board_id=$2 AND visibility<>\'taken_down\'', [board.route, board.id]);
        return row.rowCount === 1;
      },
    },
    context: { pool: deps.pool, deadline: context.deadline, partition: partitionOf(board.route) },
  });
  return runCommand(deps.pool, {
    ...identity, partition: partitionOf(board.route), deadline: context.deadline, clock: deps.clock, authorization,
    receipt: { kind, key: context.idempotencyKey, digest: createHash('sha256').update(canonicalize([boardId, intervalSeconds])!).digest() },
  }, async (tx) => {
    await tx.query(
      `INSERT INTO content.board_slow_mode(route,board_id,interval_seconds) VALUES ($1,$2,$3)
       ON CONFLICT (route,board_id) DO UPDATE SET interval_seconds=EXCLUDED.interval_seconds`,
      [board.route, board.id, intervalSeconds],
    );
    return {
      value: { intervalSeconds },
      events: [{ type: 'com.rezics.content.board.slow-mode.changed.v1', subject: boardId, data: { boardId, intervalSeconds } }],
    };
  });
}

/** Caller must disclose the current board both before and after this bounded read. */
export async function readBoardSlowMode(
  deps: ContentCommandDependencies, actor: Actor, boardId: string, deadline: number,
) {
  const board = resource(boardId);
  const check = actor.kind === 'account'
    ? await accessExplicitCheck(deps.access, actor, 'moderation:takedown', board, { pool: deps.pool, deadline })
    : null;
  return withConnection(deps.pool, async (connection) => {
    const client = deadlineClient(connection, deadline);
    const intervalSeconds = await setting(client, boardId);
    const exemption = check ? await check(client) : null;
    const exempt = exemption?.allowed === true && exemption.explicit;
    const last = actor.kind === 'account' && intervalSeconds && !exempt
      ? await client.query<{ retry_at: string }>(
          `SELECT ceil(extract(epoch FROM (posted_at + $4::integer * interval '1 second')) * 1000)::bigint::text AS retry_at
           FROM content.board_slow_actor WHERE route=$1 AND board_id=$2 AND actor_key=$3
             AND posted_at + $4::integer * interval '1 second' > $5::timestamptz`,
          [board.route, board.id, actorKey(deps, boardId, actor), intervalSeconds, (deps.clock?.() ?? new Date()).toISOString()],
        )
      : null;
    return { intervalSeconds, retryAt: last?.rows[0] ? new Date(Number(last.rows[0].retry_at)).toISOString() : null, exempt };
  });
}
