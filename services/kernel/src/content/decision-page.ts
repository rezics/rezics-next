import { t } from 'elysia';
import { accessClock } from '../access/access-clock.ts';
import { readAccount } from '../access/account-data.ts';
import { ApprovalIdentityDeniedError, verifiedBearerExpiry } from '../access/approved-identity.ts';
import { deadlineClient } from '../access/authenticate.ts';
import { readAssignment } from '../access/delegation-commands.ts';
import { AccessUnavailableError } from '../access/unavailable.ts';
import { CommandUnavailableError } from '../command/command.ts';
import { ProblemError } from '../http/problem.ts';
import { accessCheck, actorOf, AuthenticationError, type Actor } from '../request/access.ts';
import { routeOf } from '../route/route.ts';
import { appealReviewSnapshot } from './appeal-review-page.ts';
import { composeModerationDecision, ModerationDecisionSchema } from './moderation-decisions.ts';
import {
  readNoticeBoardContexts,
  readNoticePostContexts,
  type ContentReadDependencies,
  type NoticeBoardContext,
  type NoticePostContext,
} from './reads.ts';

const closed = { additionalProperties: false } as const;
const unavailableReason = t.Union([
  t.Literal('not_affected_author'),
  t.Literal('already_appealed'),
  t.Literal('deadline_passed'),
  t.Literal('command_unavailable'),
]);
const adviceSchema = t.Union([
  t.Object({ state: t.Literal('permitted') }, closed),
  t.Object({ state: t.Literal('unavailable'), reason: unavailableReason }, closed),
  t.Object({ state: t.Literal('unsupported'), reason: t.Literal('board') }, closed),
]);
const nullableTitle = t.Union([t.String(), t.Null()]);
export const DecisionPageSchema = t.Object(
  {
    ...ModerationDecisionSchema.properties,
    viewer: t.Object(
      {
        affectedAuthor: t.Boolean(),
        observedAt: t.String({ format: 'date-time' }),
        appeal: adviceSchema,
      },
      closed,
    ),
    targetContext: t.Union([
      t.Object(
        { state: t.Literal('available'), kind: t.Literal('board'), boardId: t.String(), boardTitle: nullableTitle },
        closed,
      ),
      t.Object(
        {
          state: t.Literal('available'),
          kind: t.Literal('thread'),
          threadId: t.String(),
          postId: t.Union([t.String(), t.Null()]),
          boardId: t.String(),
          threadTitle: nullableTitle,
          boardTitle: nullableTitle,
        },
        closed,
      ),
      t.Object({ state: t.Literal('concealed') }, closed),
      t.Object({ state: t.Literal('unavailable') }, closed),
    ]),
  },
  closed,
);

type Advice =
  | { state: 'permitted' }
  | { state: 'unavailable'; reason: 'not_affected_author' | 'already_appealed' | 'deadline_passed' | 'command_unavailable' }
  | { state: 'unsupported'; reason: 'board' };
type TargetContext =
  | ({ state: 'available'; kind: 'board' } & NoticeBoardContext)
  | ({ state: 'available'; kind: 'thread' } & NoticePostContext)
  | { state: 'concealed' }
  | { state: 'unavailable' };

function dependencyFailure(error: unknown) {
  return error instanceof AccessUnavailableError || error instanceof CommandUnavailableError;
}

/** Equality observations are private, never permission. Account/session eligibility
 * and the self-account formula remain owned by native Auth and Access. */
async function identityWitness(deps: ContentReadDependencies, actor: Actor, deadline: number) {
  if (actor.kind !== 'account') return null;
  const assignment = await readAssignment(
    deadlineClient(deps.pool, deadline), actor.requestedBy, actor.accountId, deps.clock ?? accessClock(deps.access),
  );
  if (assignment.kind === 'unresolved') return null;
  const ids = [...new Set([actor.accountId, ...(assignment.kind === 'resolved' ? [assignment.principalId] : [])])];
  const witnesses: unknown[] = [assignment];
  for (const id of ids) {
    const route = routeOf(id);
    if (route === null) return null;
    const read = await appealReviewSnapshot(deps.pool, route, deadline, (client) => readAccount(client, route, id));
    const account = read.value;
    if (!account) return null;
    witnesses.push([
      read.anchor.partition,
      read.anchor.epoch,
      account.accountId,
      account.kind,
      account.state,
      account.fenced,
      account.minimumAuthnEpoch.toString(),
      account.operatorAccountId,
    ]);
  }
  return JSON.stringify(witnesses);
}

/** Current HTTP envelope on the original exact decision. Optional header context
 * never admits target text. All foreign work releases checkout before the exact
 * final source/epoch and authority observation; cross-home atomicity is not implied. */
export async function readDecisionPage(
  deps: ContentReadDependencies,
  id: string,
  request: Request,
  context: { actor: Actor; deadline: number },
) {
  const actor = context.actor;
  if (actor.kind !== 'account') return null;
  return composeModerationDecision(deps, id, context, async (source) => {
    const identity = await identityWitness(deps, actor, context.deadline);
    const affectedAuthor = source.target_kind !== 'board' && source.author_account_id === actor.accountId;
    const readContext = async (): Promise<TargetContext> => {
      if (!source.available) return { state: 'unavailable' };
      try {
        if (source.target_kind === 'board') {
          const contexts = await readNoticeBoardContexts(deps, [source.target_id], context);
          const value = contexts.get(source.target_id);
          return value ? { state: 'available', kind: 'board', ...value } : { state: 'concealed' };
        }
        if (!source.thread_id) return { state: 'unavailable' };
        const ref = { threadId: source.thread_id, postId: source.target_kind === 'post' ? source.target_id : null };
        const contexts = await readNoticePostContexts(deps, [ref], context);
        const value = contexts.get(`${ref.threadId}/${ref.postId ?? ''}`);
        return value ? { state: 'available', kind: 'thread', ...value } : { state: 'concealed' };
      } catch (error) {
        if (!dependencyFailure(error)) throw error;
        return { state: 'unavailable' };
      }
    };
    const initialContext = await readContext();
    let targetContext: TargetContext = { state: 'unavailable' };
    let selfCheck: Awaited<ReturnType<typeof accessCheck>> | null = null;
    let observedActor = actor;
    if (affectedAuthor && source.appeal_id === null) {
      try {
        selfCheck = await accessCheck(
          deps.access,
          actor,
          'account:read',
          { route: routeOf(actor.accountId)!, id: actor.accountId },
          { pool: deps.pool, deadline: context.deadline },
        );
      } catch (error) {
        if (!dependencyFailure(error)) throw error;
      }
    }
    return {
      async observe() {
        const currentContext = await readContext();
        targetContext = JSON.stringify(initialContext) === JSON.stringify(currentContext)
          ? currentContext
          : { state: 'unavailable' };
        // Reuse the actual request authenticator, including native session floors,
        // assignment/client constraints and bearer expiry. Never reconstruct Actor.
        let currentActor: Actor;
        try {
          currentActor = await actorOf(deps.access, request, { pool: deps.pool, deadline: context.deadline });
        } catch (error) {
          if (error instanceof AuthenticationError || (error instanceof ProblemError && error.code === 'account_suspended'))
            return false;
          throw error;
        }
        if (JSON.stringify(currentActor) !== JSON.stringify(actor)) return false;
        if (currentActor.kind !== 'account') return false;
        observedActor = currentActor;
        return identity !== null && identity === await identityWitness(deps, actor, context.deadline);
      },
      async value(client, finalSource) {
        try {
          verifiedBearerExpiry(deps.access, observedActor, { pool: deps.pool, deadline: context.deadline });
        } catch (error) {
          if (error instanceof ApprovalIdentityDeniedError) throw new ProblemError('not_found');
          throw error;
        }
        const now = (deps.clock ?? accessClock(deps.access))();
        if (!Number.isFinite(now.getTime())) throw new TypeError('Invalid command clock');
        let appeal: Advice;
        if (finalSource.target_kind === 'board') appeal = { state: 'unsupported', reason: 'board' };
        else if (!affectedAuthor) appeal = { state: 'unavailable', reason: 'not_affected_author' };
        else if (finalSource.appeal_id !== null) appeal = { state: 'unavailable', reason: 'already_appealed' };
        else if (now.getTime() > Date.parse(finalSource.decided_at) + 183 * 86400000)
          appeal = { state: 'unavailable', reason: 'deadline_passed' };
        else {
          let allowed = false;
          try {
            allowed = !!selfCheck && await selfCheck(client);
          } catch (error) {
            if (!dependencyFailure(error)) throw error;
          }
          appeal = allowed ? { state: 'permitted' } : { state: 'unavailable', reason: 'command_unavailable' };
        }
        return { viewer: { affectedAuthor, observedAt: now.toISOString(), appeal }, targetContext };
      },
    };
  });
}
