import { t } from 'elysia';
import type { Pool } from 'pg';
import { GrantDeniedError } from '../access/grant-commands.ts';
import type { KernelClock } from '../clock.ts';
import { ProblemError, problemSchema } from '../http/problem.ts';
import { defineRateLimit } from '../http/rate-limit.ts';
import { IDEMPOTENCY_HEADER, idempotencyKeyOf } from '../http/request.ts';
import { AuthenticationError, type Access, type Actor } from '../request/access.ts';
import { routeOf } from '../route/route.ts';
import type { definitionRoutes } from '../semantic/http/definitions.ts';
import { LibraryNotFoundError } from '../library/command-support.ts';
import {
  createVoteCommands,
  RatingQuestionNotFoundError,
  VoteInvalidError,
  VOTE_SCOPE,
  type RatingQuestion,
  type Vote,
} from './votes.ts';
import { RatingQuestionResponseSchema, RatingVoteInputSchema, RatingVoteResponseSchema } from './schemas.ts';

type Dependencies = { pool: Pool; access: () => Access; clock?: KernelClock };
const closed = { additionalProperties: false } as const;
const id = t.String({ format: 'uuid' });
const headers = t.Object({ [IDEMPOTENCY_HEADER]: t.String({ minLength: 3, maxLength: 1024 }) });
const bearer = [{ bearerAuth: [] }];
const writeRate = defineRateLimit({ family: 'write', units: 1 });
const failures = {
  400: problemSchema('invalid_request'),
  401: problemSchema('authentication_required', 'invalid_credentials'),
  403: problemSchema('forbidden'),
  404: problemSchema('not_found'),
  409: problemSchema('conflict'),
  422: problemSchema('idempotency_conflict', 'too_many_events'),
  503: problemSchema('overloaded', 'partition_unavailable', 'transaction_retry_exhausted', 'deadline_exceeded'),
};

function detail(operationId: string, write = false) {
  return {
    operationId,
    'x-action': VOTE_SCOPE,
    'x-exposure': 'gate:personal_library',
    security: bearer,
    ...(write ? { 'x-rate-limit': writeRate } : {}),
  };
}

function requirePersonalScope(actor: Actor, ...ids: string[]): void {
  if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
  if (!actor.scopes.includes(VOTE_SCOPE)) throw new ProblemError('forbidden');
  if (ids.some((value) => routeOf(value) === null)) throw new ProblemError('not_found');
}

async function command<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof GrantDeniedError) throw new ProblemError('forbidden');
    if (error instanceof LibraryNotFoundError || error instanceof RatingQuestionNotFoundError)
      throw new ProblemError('not_found');
    if (error instanceof VoteInvalidError)
      throw new ProblemError('invalid_request', {
        errors: [{ pointer: `/${error.field}`, code: 'out_of_range' }],
      });
    throw error;
  }
}

function voteView(vote: Vote) {
  if (vote.units === null) throw new ProblemError('not_found');
  return { units: vote.units, revision: vote.revision, at: vote.changedAt };
}

function questionView(question: RatingQuestion) {
  return {
    id: question.id,
    revision: question.revision,
    label: question.label,
    grain: question.grain,
    scale: {
      min: question.minimumUnits,
      max: question.maximumUnits,
      displayStep: question.stepUnits,
    },
  };
}

/** Private account-owned vote transport. Commands remain responsible for partition ownership and current account state. */
export function ratingRoutes(app: ReturnType<typeof definitionRoutes>, dependencies: Dependencies) {
  const config = () => ({ ...dependencies, access: dependencies.access() });
  const votes = () => createVoteCommands(config());
  return app
    .put(
      '/v1/subjects/:subjectId/ratings/:questionId/vote',
      {
        params: t.Object({ subjectId: id, questionId: id }, closed),
        headers,
        body: RatingVoteInputSchema,
        response: { 200: RatingVoteResponseSchema, ...failures },
        detail: detail('rating.vote_put', true),
      },
      async ({ actor, params, body, headers, admission, job }) => {
        requirePersonalScope(actor, params.subjectId, params.questionId);
        const key = idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]);
        const result = await admission.run('normal', job, () =>
          command(() =>
            votes().putVote(
              actor,
              { questionId: params.questionId, targetId: params.subjectId, units: body.units },
              key,
            ),
          ),
        );
        if (!result) throw new ProblemError('not_found');
        return voteView(result);
      },
    )
    .delete(
      '/v1/subjects/:subjectId/ratings/:questionId/vote',
      {
        params: t.Object({ subjectId: id, questionId: id }, closed),
        headers,
        response: { 204: t.Void(), ...failures },
        detail: detail('rating.vote_delete', true),
      },
      async ({ actor, params, headers, admission, job, set }) => {
        requirePersonalScope(actor, params.subjectId, params.questionId);
        const key = idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]);
        await admission.run('normal', job, () =>
          command(() =>
            votes().putVote(actor, { questionId: params.questionId, targetId: params.subjectId, units: null }, key),
          ),
        );
        set.status = 204;
      },
    )
    .get(
      '/v1/subjects/:subjectId/ratings/:questionId/vote',
      {
        params: t.Object({ subjectId: id, questionId: id }, closed),
        response: { 200: RatingVoteResponseSchema, ...failures },
        detail: detail('rating.vote_get'),
      },
      async ({ actor, params, admission, job }) => {
        requirePersonalScope(actor, params.subjectId, params.questionId);
        const result = await admission.run('normal', job, () =>
          command(() => votes().readOwnVote(actor, params.questionId, params.subjectId)),
        );
        if (!result || result.units === null) throw new ProblemError('not_found');
        return voteView(result);
      },
    )
    .get(
      '/v1/rating-questions/:questionId',
      {
        params: t.Object({ questionId: id }, closed),
        response: { 200: RatingQuestionResponseSchema, ...failures },
        detail: detail('rating.question_get'),
      },
      async ({ actor, params, admission, job }) => {
        requirePersonalScope(actor, params.questionId);
        const question = await admission.run('normal', job, () =>
          command(() => votes().readRatingQuestion(actor, params.questionId)),
        );
        return questionView(question);
      },
    );
}
