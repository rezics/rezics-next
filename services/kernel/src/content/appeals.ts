import type { Pool } from 'pg';
import { Value } from 'typebox/value';
import { deadlineClient, within } from '../access/authenticate.ts';
import { readAccount } from '../access/account-data.ts';
import { notificationAllowed } from '../access/preferences.ts';
import { resourceAuthorization } from '../access/resource-authorization.ts';
import {
  CommandUnavailableError,
  authoritativeTimeValue,
  principalCommandIdentity,
  runCommand,
  type CommandAuthorization,
  type CommandEvent,
} from '../command/command.ts';
import { discardConnection, withConnection } from '../database/pool.ts';
import type { Effect } from '../events/effects.ts';
import { ProblemError } from '../http/problem.ts';
import { requestDigest } from '../http/request.ts';
import { readPartition } from '../partition/partition.ts';
import {
  AuthenticationError,
  accessCheck,
  accessCommandAuthorization,
  type Access,
  type AccessClient,
  type Actor,
} from '../request/access.ts';
import { newId, partitionOf, routeOf } from '../route/route.ts';
import { decodeCursor, encodeCursor } from '../tokens/cursor.ts';
import type { KeyRing } from '../tokens/seal.ts';
import { CONTENT_EVENTS } from './events.ts';
import { liftTakedown } from './lift-takedown.ts';
import { writeNotices } from './notices.ts';
import type { RequestContext } from './model.ts';
import readDecision from './read-moderation-decision.sql';
import author from './author-moderation-decision.sql';
import insert from './insert-appeal.sql';
import read from './read-appeal.sql';
import resolve from './resolve-appeal.sql';
import project from './project-appeal.sql';
import boardPage from './page-board-appeals.sql';
import threadPage from './page-thread-appeals.sql';

const createdType = 'com.rezics.content.moderation.appeal-created.v1';
const resolvedType = 'com.rezics.content.moderation.appeal-resolved.v1';
export type AppealDependencies = { pool: Pool; access: Access; tokens?: KeyRing; clock?: () => Date };
type ReadContext = { actor: Actor; deadline: number };
const missing = () => new ProblemError('not_found');

async function snapshot<T>(pool: Pool, route: number, deadline: number, work: (client: AccessClient) => Promise<T>) {
  return within(deadline, () =>
    withConnection(pool, async (connection) => {
      const client = deadlineClient(connection, deadline);
      try {
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        const partition = await readPartition(client, partitionOf(route));
        if (!partition) throw new CommandUnavailableError('deadline', partitionOf(route));
        if (partition.writeState === 'moved')
          throw new CommandUnavailableError('moved', partitionOf(route), partition.movedTo);
        const value = await work(client);
        await client.query('COMMIT');
        return {
          value,
          anchor: { partition: partitionOf(route), epoch: partition.epoch, position: partition.position },
        };
      } catch (error) {
        try {
          await connection.query('ROLLBACK');
        } catch (rollback) {
          discardConnection(connection, rollback as Error);
        }
        throw error;
      }
    }),
  );
}

export async function createAppeal(
  deps: AppealDependencies,
  actor: Actor,
  id: string,
  statement: string,
  context: RequestContext,
) {
  const route = routeOf(id);
  if (route === null || actor.kind !== 'account') throw missing();
  // The self-account anchor admits the authenticated author independently of the
  // taken-down target's disclosure. Ownership is rechecked before receipt replay.
  const selfRoute = routeOf(actor.accountId)!;
  const admission = resourceAuthorization({
    access: deps.access,
    actor,
    action: 'account:read',
    anchor: {
      resource: { route: selfRoute, id: actor.accountId },
      validate: async (client) => !!(await readAccount(client, selfRoute, actor.accountId)),
    },
    context: { pool: deps.pool, deadline: context.deadline, partition: partitionOf(route) },
  });
  let decision: Awaited<ReturnType<typeof readDecision.run>>;
  let target: Awaited<ReturnType<typeof author.run>>[number] | undefined;
  const authorization: CommandAuthorization = {
    ...admission,
    async authorize(tx, attempt, proof) {
      await admission.authorize(tx, attempt, proof);
      decision = await readDecision.run(tx, { route, decision_id: id });
      if (!decision) throw missing();
      [target] = await author.run(tx, { route, target_kind: decision.target_kind, target_id: decision.target_id });
      if (!target || target.author_account_id !== actor.accountId) throw missing();
      return 'execute';
    },
  };
  return runCommand(
    deps.pool,
    {
      ...principalCommandIdentity(actor),
      partition: partitionOf(route),
      deadline: context.deadline,
      clock: deps.clock,
      authorization,
      receipt: {
        kind: 'content.appeal',
        key: context.idempotencyKey,
        digest: requestDigest('content.appeal', actor, { id, statement }),
      },
    },
    async (tx, command) => {
      if (!decision || !target) throw missing();
      if (decision.appeal_id !== null) throw new ProblemError('conflict');
      const at = authoritativeTimeValue(command.time);
      if (Date.parse(at) > new Date(decision.decided_at).getTime() + 183 * 86400000)
        throw new ProblemError('unsupported_query', { detail: 'The appeal deadline has passed.' });
      const appealId = newId(route);
      const added = await insert.run(tx, {
        route,
        appeal_id: appealId,
        decision_id: id,
        appellant: actor.accountId,
        statement,
        thread_id: target.thread_id,
        board_id: target.board_id,
        created_at: at,
      });
      if (!added) throw new ProblemError('conflict');
      return { value: { id: appealId }, events: [{ type: createdType, subject: appealId, data: { appealId } }] };
    },
  );
}

export async function resolveAppeal(
  deps: AppealDependencies,
  actor: Actor,
  id: string,
  input: { outcome: 'uphold' | 'reverse'; statement: string },
  context: RequestContext,
) {
  const route = routeOf(id);
  if (route === null || actor.kind !== 'account') throw missing();
  const reference = await snapshot(deps.pool, route, context.deadline, (client) =>
    read.run(client, { route, appeal_id: id }),
  );
  if (!reference.value) throw missing();
  const admission = await accessCommandAuthorization(
    deps.access,
    actor,
    'moderation:takedown',
    { route, id: reference.value.target_id },
    { pool: deps.pool, deadline: context.deadline },
    missing,
  );
  const authorization: CommandAuthorization = {
    ...admission,
    async authorize(tx, attempt, proof) {
      await admission.authorize(tx, attempt, proof);
      if (reference.value!.decider_account_id === actor.accountId) throw new ProblemError('forbidden');
      return 'execute';
    },
  };
  return runCommand(
    deps.pool,
    {
      ...principalCommandIdentity(actor),
      partition: partitionOf(route),
      deadline: context.deadline,
      clock: deps.clock,
      authorization,
      receipt: {
        kind: 'content.resolve-appeal',
        key: context.idempotencyKey,
        digest: requestDigest('content.resolve-appeal', actor, { id, ...input }),
      },
    },
    async (tx, command) => {
      const changed = await resolve.run(tx, {
        route,
        appeal_id: id,
        outcome: input.outcome === 'uphold' ? 'upheld' : 'reversed',
        resolver: actor.accountId,
        statement: input.statement,
        resolved_at: authoritativeTimeValue(command.time),
      });
      if (!changed) throw new ProblemError('conflict');
      const events: CommandEvent[] = [];
      if (input.outcome === 'reverse')
        await liftTakedown(
          tx,
          { target: { kind: reference.value!.target_kind as 'thread' | 'post', id: reference.value!.target_id } },
          { events },
        );
      events.push({ type: resolvedType, subject: id, data: { appealId: id } });
      return { value: { id }, events };
    },
  );
}

async function canAct(
  deps: AppealDependencies,
  row: NonNullable<Awaited<ReturnType<typeof read.run>>>,
  context: ReadContext,
) {
  const route = routeOf(row.appeal_id)!;
  const check = await accessCheck(
    deps.access,
    context.actor,
    'moderation:takedown',
    { route, id: row.target_id },
    { pool: deps.pool, deadline: context.deadline },
  );
  return snapshot(deps.pool, route, context.deadline, (client) => check(client));
}

export async function listAppeals(
  deps: AppealDependencies,
  target: { kind: 'board' | 'thread'; id: string },
  context: ReadContext,
  query: { cursor?: string; limit?: number },
) {
  const route = routeOf(target.id);
  if (context.actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
  if (route === null) throw missing();
  const check = await accessCheck(
    deps.access,
    context.actor,
    'moderation:read_reports',
    { route, id: target.id },
    { pool: deps.pool, deadline: context.deadline },
  );
  const initial = await snapshot(deps.pool, route, context.deadline, (client) => check(client));
  if (!initial.value) throw missing();
  const ring = deps.tokens;
  if (!ring) throw new ProblemError('dependency_unavailable');
  const binding = {
    operation: 'content.pending-appeals',
    parameters: { kind: target.kind, id: target.id, actor: context.actor.accountId },
  };
  let after: { at: string; id: string } | null = null;
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
      throw new ProblemError('invalid_cursor');
    after = { at: decoded.after[0], id: decoded.after[1] };
  }
  const limit = query.limit ?? 20;
  const candidates = await snapshot(deps.pool, route, context.deadline, (client) =>
    (target.kind === 'board' ? boardPage : threadPage).run(client, {
      route,
      id: target.id,
      created_at: after?.at ?? 'infinity',
      appeal_id: after?.id ?? '00000000-0000-0000-0000-000000000000',
      limit: limit + 1,
    }),
  );
  const selected = candidates.value.slice(0, limit);
  const appeals = [];
  for (const candidate of selected) {
    const row = (
      await snapshot(deps.pool, routeOf(candidate.appeal_id)!, context.deadline, (client) =>
        read.run(client, { route: routeOf(candidate.appeal_id)!, appeal_id: candidate.appeal_id }),
      )
    ).value;
    if (!row || row.outcome !== null || (target.kind === 'board' ? row.board_id : row.thread_id) !== target.id)
      continue;
    if (!(await canAct(deps, row, context)).value) continue;
    appeals.push({
      id: row.appeal_id,
      decisionId: row.decision_id,
      appellantId: row.appellant_account_id,
      statement: row.statement,
      createdAt: new Date(row.created_at).toISOString(),
      decision: {
        statement: row.decision_statement,
        target: { kind: row.target_kind as 'post' | 'thread', id: row.target_id },
      },
      canResolve: row.decider_account_id !== context.actor.accountId,
    });
  }
  const final = await snapshot(deps.pool, route, context.deadline, (client) => check(client));
  if (!final.value) throw missing();
  const last = selected.at(-1);
  if (last && last.created_at === null) throw new Error('Appeal cursor time is missing');
  return {
    value: {
      appeals,
      next:
        candidates.value.length > limit && last
          ? encodeCursor(ring, binding, { epoch: final.anchor.epoch, after: [last.created_at!, last.appeal_id] })
          : null,
    },
    anchor: final.anchor,
  };
}

/** Cross-partition delivery releases the source snapshot before projecting on
 * the board route or notifying on the appellant route. Replays are monotone. */
export function createAppealEffect(pool: Pool): Effect {
  return {
    name: 'content_moderation_appeal',
    types: [createdType, resolvedType],
    async run(event) {
      if (
        (event.type !== createdType && event.type !== resolvedType) ||
        !Value.Check(CONTENT_EVENTS[event.type], event.data)
      )
        throw new TypeError('Invalid appeal event');
      const { appealId } = event.data as { appealId: string };
      const route = routeOf(appealId);
      const source = /^urn:rezics:log:(\d+)\.([1-9][0-9]*)$/.exec(event.source);
      if (route === null || !source || Number(source[1]) !== partitionOf(route) || !/^\d{19}$/.test(event.sequence))
        throw new TypeError('Invalid appeal source');
      const deadline = Date.now() + 30_000;
      const { value: row, anchor } = await snapshot(pool, route, deadline, (client) =>
        read.run(client, { route, appeal_id: appealId }),
      );
      if (
        Number(source[2]) > anchor.epoch ||
        (Number(source[2]) === anchor.epoch && BigInt(event.sequence) > anchor.position)
      )
        throw new Error('Appeal source unavailable');
      if (!row || (event.type === resolvedType && row.outcome === null)) throw new Error('Appeal source missing');
      async function write(destination: number, work: (client: AccessClient) => Promise<unknown>) {
        await withConnection(pool, async (connection) => {
          const client = deadlineClient(connection, deadline);
          try {
            await client.query('BEGIN');
            const partition = await readPartition(client, partitionOf(destination));
            if (!partition) throw new CommandUnavailableError('deadline', partitionOf(destination));
            if (partition.writeState !== 'active')
              throw new CommandUnavailableError(
                partition.writeState === 'moved' ? 'moved' : 'fenced',
                partitionOf(destination),
                partition.movedTo,
              );
            await work(client);
            await client.query('COMMIT');
          } catch (error) {
            try {
              await connection.query('ROLLBACK');
            } catch (rollback) {
              discardConnection(connection, rollback as Error);
            }
            throw error;
          }
        });
      }
      const boardRoute = routeOf(row.board_id)!;
      await write(boardRoute, (client) =>
        project.run(client, {
          route: boardRoute,
          board_id: row.board_id,
          appeal_id: appealId,
          created_at: new Date(row.created_at).toISOString(),
          pending: row.outcome === null,
        }),
      );
      if (event.type !== resolvedType) return;
      const recipientRoute = routeOf(row.appellant_account_id)!;
      await write(recipientRoute, async (client) => {
        if (await notificationAllowed(client, { recipient: row.appellant_account_id, kind: 'moderation_decision' }))
          await writeNotices(client, [
            {
              recipientId: row.appellant_account_id,
              noticeId: newId(recipientRoute),
              kind: 'moderation_decision',
              actorId: null,
              threadId: row.thread_id,
              postId: row.target_kind === 'post' ? row.target_id : null,
              decisionId: row.decision_id,
              reportId: null,
              sourceId: appealId,
              createdAt: new Date(row.resolved_at!),
            },
          ]);
      });
    },
  };
}
