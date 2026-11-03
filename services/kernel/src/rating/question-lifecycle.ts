import { createHash } from 'node:crypto';
import canonicalize from 'canonicalize';
import type { Pool } from 'pg';
import { resourceAuthorization } from '../access/index.ts';
import { deadlineClient } from '../access/authenticate.ts';
import { GrantDeniedError } from '../access/grant-commands.ts';
import type { KernelClock } from '../clock.ts';
import {
  authoritativeTimeValue,
  commandAttemptDeadline,
  principalCommandIdentity,
  runCommand,
} from '../command/command.ts';
import { withReadTransaction } from '../semantic/read.ts';
import realmRead from '../community/realm-read.sql';
import { partitionReadClient } from '../database/read-snapshot.ts';
import { ProblemError } from '../http/problem.ts';
import type { Access, Actor } from '../request/access.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { QuestionDefinitionInvalidError } from './question-authoring.ts';
import questionRead from './question-read.sql';
import lock from './question-lifecycle-lock.sql';
import update from './question-lifecycle-update.sql';
import bumpGeneration from './question-lifecycle-generation-bump.sql';

export const QUESTION_LIFECYCLE_CHANGED = 'com.rezics.rating.question.lifecycle-changed.v1';
export type QuestionLifecycleState = 'active' | 'retired';
export type QuestionLifecycleInput = Readonly<{ questionId: string; expectedRevision: number }>;

type Dependencies = { pool: Pool; access: Access; clock?: KernelClock };
type LifecycleQuestion = NonNullable<Awaited<ReturnType<typeof questionRead.run>>>;
type ImmutableQuestion = Pick<
  LifecycleQuestion,
  | 'id'
  | 'realmId'
  | 'ownerId'
  | 'revision'
  | 'label'
  | 'meaning'
  | 'grain'
  | 'minimumUnits'
  | 'maximumUnits'
  | 'stepUnits'
>;

export class QuestionLifecycleConflictError extends Error {
  constructor() {
    super('Rating question lifecycle revision conflict');
    this.name = 'QuestionLifecycleConflictError';
  }
}

export class QuestionLifecycleNotFoundError extends Error {
  constructor() {
    super('Rating question not found');
    this.name = 'QuestionLifecycleNotFoundError';
  }
}

function validate(input: QuestionLifecycleInput): void {
  if (!input || typeof input !== 'object' || routeOf(input.questionId) === null)
    throw new QuestionDefinitionInvalidError('questionId');
  if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 1 || input.expectedRevision >= 2_147_483_647)
    throw new QuestionDefinitionInvalidError('expectedRevision');
}

function immutableIdentity(question: ImmutableQuestion): string {
  return JSON.stringify([
    question.id,
    question.realmId,
    question.ownerId,
    question.revision,
    question.label,
    question.meaning,
    question.grain,
    question.minimumUnits,
    question.maximumUnits,
    question.stepUnits,
  ]);
}

async function readQuestion(pool: Pool, questionId: string, deadline: number): Promise<LifecycleQuestion | null> {
  const route = routeOf(questionId);
  if (route === null) return null;
  return withReadTransaction(pool, async (client) => {
    const bounded = deadlineClient(client, deadline);
    await partitionReadClient(bounded, partitionOf(route));
    return questionRead.run(bounded, { question_id: questionId });
  });
}

/** Realm management is checked on every attempt before the command receipt can be read. */
async function transition(
  deps: Dependencies,
  actor: Actor,
  input: QuestionLifecycleInput,
  context: { deadline: number; idempotencyKey: string },
  state: QuestionLifecycleState,
) {
  if (actor.kind !== 'account') throw new GrantDeniedError();
  validate(input);
  const body = { questionId: input.questionId, expectedRevision: input.expectedRevision, state };
  const question = await readQuestion(deps.pool, body.questionId, context.deadline);
  const realmId = question?.realmId;
  const route = routeOf(body.questionId)!;
  if (!question || !realmId || routeOf(realmId) !== route) throw new QuestionLifecycleNotFoundError();
  const questionIdentity = immutableIdentity(question);
  const identity = principalCommandIdentity(actor);
  const kind = `rating.question.lifecycle.${state}`;
  const native = resourceAuthorization({
    access: deps.access,
    actor,
    action: 'realm:manage',
    anchor: {
      resource: { route, id: realmId },
      async validate(client, time) {
        const current = await questionRead.run(client, { question_id: body.questionId });
        if (!current || current.realmId !== realmId || immutableIdentity(current) !== questionIdentity)
          throw new ProblemError('not_found');
        return !!(await realmRead.run(client, { route, id: realmId, at: authoritativeTimeValue(time) }));
      },
    },
    context: { pool: deps.pool, deadline: context.deadline, partition: partitionOf(route) },
  });
  const expectedCurrentState = state === 'retired' ? 'active' : 'retired';
  return runCommand(
    deps.pool,
    {
      ...identity,
      partition: partitionOf(route),
      deadline: context.deadline,
      clock: deps.clock,
      receipt: {
        kind,
        key: context.idempotencyKey,
        digest: createHash('sha256')
          .update(canonicalize([identity, kind, body, questionIdentity])!)
          .digest(),
      },
      authorization: {
        ...native,
        async prepare(attempt) {
          await native.prepare!(attempt);
          const current = await readQuestion(deps.pool, body.questionId, commandAttemptDeadline(attempt));
          if (!current || current.realmId !== realmId || immutableIdentity(current) !== questionIdentity)
            throw new QuestionLifecycleNotFoundError();
          // Exact retries of the latest transition can reach their receipt. Once a later
          // lifecycle revision exists, an old replay is stale and cannot report success.
          const exactReplay = current.lifecycleRevision === body.expectedRevision + 1 &&
            current.lifecycleState === state;
          const freshCommand = current.lifecycleRevision === body.expectedRevision &&
            current.lifecycleState === expectedCurrentState;
          if (!freshCommand && !exactReplay) throw new QuestionLifecycleConflictError();
        },
      },
    },
    async (tx) => {
      const current = await lock.run(tx, { question_id: body.questionId });
      if (!current || current.realmId !== realmId || immutableIdentity(current) !== questionIdentity)
        throw new QuestionLifecycleNotFoundError();
      if (current.lifecycleRevision !== body.expectedRevision || current.state !== expectedCurrentState)
        throw new QuestionLifecycleConflictError();
      const revision = current.lifecycleRevision + 1;
      const changed = await update.run(tx, {
        question_id: body.questionId,
        expected_revision: body.expectedRevision,
        revision,
        state,
      });
      if (!changed) throw new QuestionLifecycleConflictError();
      const generation = await bumpGeneration.run(tx, { realm_id: realmId });
      if (!generation) throw new Error('Rating question lifecycle generation was not advanced');
      return {
        value: { questionId: body.questionId, lifecycle: { state, revision } },
        events: [
          {
            type: QUESTION_LIFECYCLE_CHANGED,
            subject: body.questionId,
            data: { questionId: body.questionId, realmId, state, revision, generation: generation.generation },
          },
        ],
      };
    },
  );
}

export function retireRealmRatingQuestion(
  deps: Dependencies,
  actor: Actor,
  input: QuestionLifecycleInput,
  context: { deadline: number; idempotencyKey: string },
) {
  return transition(deps, actor, input, context, 'retired');
}

export function restoreRealmRatingQuestion(
  deps: Dependencies,
  actor: Actor,
  input: QuestionLifecycleInput,
  context: { deadline: number; idempotencyKey: string },
) {
  return transition(deps, actor, input, context, 'active');
}
