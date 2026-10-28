import { createHash } from 'node:crypto';
import canonicalize from 'canonicalize';
import type { Pool } from 'pg';
import { commandAccessContext, requireCommandAdmission } from '../access/command-admission.ts';
import { GrantDeniedError } from '../access/grant-commands.ts';
import { createResourcePublicEligibility } from '../access/public-eligibility.ts';
import { resourceAuthorization } from '../access/resource-authorization.ts';
import {
  authoritativeTimeValue,
  principalCommandIdentity,
  runCommand,
  type AuthoritativeTime,
} from '../command/command.ts';
import { accessCheck, type Access, type AccessCheck, type Actor } from '../request/access.ts';
import { prepareRealmParticipationResult, type RealmParticipationCheck } from '../community/participation.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { REACTION_KINDS } from './events.ts';
import { ContentNotFoundError } from './commands.ts';
import { subjectReadEligibility } from '../semantic/eligibility.ts';
import { GLOBAL_CONTEXT } from '../semantic/definitions.ts';
import readSubjectRedirect from '../semantic/read-redirect.sql';
import {
  mediaParentBoard,
  mediaParentSnapshot,
  realmParticipationMatches,
  type RealmParticipationProof,
} from './media-parent.ts';
import type { RequestContext } from './model.ts';
import { withConnection } from '../database/pool.ts';
import slotStatement from './reaction-slot.sql';
import targetStatement from './reaction-target.sql';

export { REACTION_KINDS };
export type ReactionKind = (typeof REACTION_KINDS)[number];
export type ReactionDependencies = Readonly<{
  pool: Pool;
  access: Access;
  realmParticipation?: RealmParticipationCheck;
  clock?: () => Date;
}>;
export type ReactionTarget = Readonly<{ targetKind: 'thread' | 'post' | 'subject'; targetId: string }>;
export type SetReactionInput = ReactionTarget & Readonly<{ kind: ReactionKind }>;
class Unchanged extends Error {}
function route(id: string): number {
  const value = routeOf(id);
  if (value === null) throw new GrantDeniedError();
  return value;
}

async function subjectRedirect(pool: Pool, subjectId: string): Promise<string | null> {
  const subjectRoute = routeOf(subjectId);
  if (subjectRoute === null) return null;
  return withConnection(
    pool,
    async (client) =>
      (await readSubjectRedirect.run(client, { route: subjectRoute, subject_id: subjectId }))?.target ?? null,
  );
}

async function mutate(
  deps: ReactionDependencies,
  actor: Actor,
  input: ReactionTarget,
  kind: ReactionKind | null,
  context: RequestContext,
) {
  if (!['thread', 'post', 'subject'].includes(input.targetKind)) throw new TypeError('Invalid reaction target kind');
  if (actor.kind !== 'account') throw new GrantDeniedError();
  const body = { targetKind: input.targetKind, targetId: input.targetId, kind };
  if (body.targetKind === 'subject' && (kind === 'upvote' || kind === 'downvote'))
    throw new TypeError('Invalid reaction kind');
  const home = route(actor.accountId);
  let targetId = body.targetId;
  if (body.targetKind === 'subject') {
    const redirected = await subjectRedirect(deps.pool, body.targetId);
    if (redirected) {
      targetId = redirected;
      if (await subjectRedirect(deps.pool, targetId)) throw new ContentNotFoundError();
    }
  }
  const targetRoute = route(targetId);
  const partition = partitionOf(home);
  const resource = { route: targetRoute, id: targetId };
  const realmParticipation = deps.realmParticipation;
  let targetBoardId: string | undefined;
  const participation = new WeakMap<AuthoritativeTime, RealmParticipationProof>();
  const subjectReadChecks = new WeakMap<AuthoritativeTime, AccessCheck>();
  let checks: AccessCheck[] = [];
  const base = resourceAuthorization({
    access: deps.access,
    actor,
    action: 'reaction:set',
    anchor: {
      resource: body.targetKind === 'subject' ? { route: 0, id: GLOBAL_CONTEXT } : resource,
      async validate(client, time) {
        if (body.targetKind === 'subject') {
          if ((await readSubjectRedirect.run(client, { route: targetRoute, subject_id: targetId }))?.target)
            throw new ContentNotFoundError();
          const subjectReadCheck = subjectReadChecks.get(time);
          if (!subjectReadCheck || !(await subjectReadCheck(client, time))) throw new ContentNotFoundError();
          return true;
        }
        if (targetBoardId) {
          const board = await mediaParentBoard(client, targetBoardId);
          if (realmParticipation && !realmParticipationMatches(participation.get(time), board.realm_id))
            throw new GrantDeniedError();
        }
        for (const check of checks) if (!(await check(client, time))) throw new GrantDeniedError();
        return true;
      },
    },
    context: { pool: deps.pool, deadline: context.deadline, partition },
  });
  const authorization = {
    ...base,
    async prepare(attempt: Parameters<NonNullable<typeof base.prepare>>[0]) {
      const preparation = commandAccessContext({ pool: deps.pool, deadline: context.deadline }, attempt);
      await requireCommandAdmission(deps.access, actor, preparation);
      if (body.targetKind === 'subject') {
        if (body.targetId !== targetId) {
          const requestedRoute = route(body.targetId);
          const redirected = await subjectRedirect(deps.pool, body.targetId);
          if (redirected !== targetId) throw new ContentNotFoundError();
          const requestedResource = {
            route: requestedRoute,
            id: body.targetId,
            eligibility: subjectReadEligibility({ route: requestedRoute, id: body.targetId }),
          };
          const requestedRead = await accessCheck(deps.access, actor, 'subject:read', requestedResource, preparation);
          const readable = await withConnection(deps.pool, (client) => requestedRead(client, attempt.time));
          if (!readable) throw new ContentNotFoundError();
        }
        const subjectResource = {
          route: targetRoute,
          id: targetId,
          eligibility: subjectReadEligibility({ route: targetRoute, id: targetId }),
        };
        subjectReadChecks.set(
          attempt.time,
          await accessCheck(deps.access, actor, 'subject:read', subjectResource, preparation),
        );
      }
      if (body.targetKind !== 'subject') {
        // This observation belongs to this live T and is discarded on retry. No
        // resource connection survives evidence preparation or actor-home checkout.
        const rows = await mediaParentSnapshot(deps.pool, targetRoute, context.deadline, (client) =>
          targetStatement.run(client, { route: targetRoute, id: body.targetId, kind: body.targetKind }),
        );
        const thread = rows[0],
          last = rows.at(-1);
        if (!thread) throw new ContentNotFoundError();
        if (
          thread.kind !== 'thread' ||
          !thread.board_id ||
          rows.length < 2 ||
          last?.parent_id !== null ||
          rows.some(
            (row, index) =>
              row.depth !== index ||
              row.availability !== 'available' ||
              row.visibility === 'taken_down' ||
              (row.visibility === 'draft' && row.author_id !== actor.accountId),
          ) ||
          (body.targetKind === 'post' && rows[1]?.id !== body.targetId)
        )
          throw new GrantDeniedError();
        checks = [];
        for (const row of rows) {
          if (!row.id) throw new GrantDeniedError();
          const target = { route: targetRoute, id: row.id };
          const action = `${row.kind}:read`;
          checks.push(
            await accessCheck(
              deps.access,
              actor,
              action,
              {
                ...target,
                eligibility: createResourcePublicEligibility({
                  resource: target,
                  action,
                  async prepare() {
                    return row;
                  },
                  async verify({ at }) {
                    if (at !== authoritativeTimeValue(attempt.time)) throw new GrantDeniedError();
                    return row.visibility === 'published' && row.availability === 'available';
                  },
                }),
              },
              preparation,
            ),
          );
        }
        const boardId = thread.board_id;
        targetBoardId = boardId;
        const boardResource = { route: route(boardId), id: boardId };
        // Board eligibility and Access run on the board's home, even if co-located.
        const boardAction = 'board:read';
        const boardCheck = await accessCheck(
          deps.access,
          actor,
          boardAction,
          {
            ...boardResource,
            eligibility: createResourcePublicEligibility({
              resource: boardResource,
              action: boardAction,
              async prepare() {
                return attempt.time;
              },
              async verify({ client, at }) {
                if (at !== authoritativeTimeValue(attempt.time)) throw new GrantDeniedError();
                const board = await mediaParentBoard(client, boardId);
                if (board.visibility === 'draft') throw new GrantDeniedError();
                return board.visibility === 'published';
              },
            }),
          },
          preparation,
        );
        let boardRealmId: string | null = null;
        await mediaParentSnapshot(deps.pool, boardResource.route, context.deadline, async (client) => {
          if (!(await boardCheck(client, attempt.time))) throw new GrantDeniedError();
          boardRealmId = (await mediaParentBoard(client, boardId)).realm_id;
        });
        if (realmParticipation) {
          const proof = await prepareRealmParticipationResult(
            deps.pool,
            realmParticipation,
            actor,
            boardRealmId,
            attempt.time,
            context.deadline,
          );
          if (proof.readable === false) throw new ContentNotFoundError();
          if (!proof.allowed) throw new GrantDeniedError();
          participation.set(attempt.time, proof);
        }
      }
      return base.prepare!(attempt);
    },
  };
  const identity = principalCommandIdentity(actor);
  const commandKind = kind === null ? 'content.reaction.clear' : 'content.reaction.set';
  try {
    return await runCommand(
      deps.pool,
      {
        ...identity,
        partition,
        clock: deps.clock,
        deadline: context.deadline,
        authorization,
        receipt: {
          kind: commandKind,
          key: context.idempotencyKey,
          digest: createHash('sha256')
            .update(canonicalize([identity, commandKind, body])!)
            .digest(),
        },
      },
      async (tx, command) => {
        const rows = await slotStatement.run(tx, {
          route: home,
          actor_id: actor.accountId,
          target_kind: body.targetKind,
          target_route: targetRoute,
          target_id: targetId,
          kind,
          at: authoritativeTimeValue(command.time),
        });
        // The executor requires an event for a committed command. Roll back the
        // unchanged slot, receipt and position together instead of emitting noise.
        const changed = rows[0];
        if (!changed) throw new Unchanged();
        return {
          value: body,
          events: [
            {
              type: 'com.rezics.content.reaction.changed.v1',
              subject: targetId,
              data: {
                actorId: actor.accountId,
                targetKind: body.targetKind,
                targetId,
                previousKind: changed.previous_kind,
                kind: changed.kind,
              },
            },
          ],
        };
      },
    );
  } catch (error) {
    if (error instanceof Unchanged) return null;
    throw error;
  }
}
/** A changed slot returns its command outcome; an unchanged slot returns null. */
export function setReaction(
  deps: ReactionDependencies,
  actor: Actor,
  input: SetReactionInput,
  context: RequestContext,
) {
  if (!REACTION_KINDS.includes(input.kind)) return Promise.reject(new TypeError('Invalid reaction kind'));
  return mutate(deps, actor, input, input.kind, context);
}
export function clearReaction(
  deps: ReactionDependencies,
  actor: Actor,
  input: ReactionTarget,
  context: RequestContext,
) {
  return mutate(deps, actor, input, null, context);
}
