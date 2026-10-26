import { t } from 'elysia';
import type { Pool } from 'pg';
import { deadlineClient } from '../access/authenticate.ts';
import { GrantDeniedError } from '../access/grant-commands.ts';
import { GLOBAL_CONTEXT } from '../access/gates/catalogue.ts';
import type { KernelClock } from '../clock.ts';
import { withConnection } from '../database/pool.ts';
import { readRealm } from '../community/realm.ts';
import { ProblemError, problemSchema } from '../http/problem.ts';
import { defineRateLimit } from '../http/rate-limit.ts';
import { IDEMPOTENCY_HEADER, idempotencyKeyOf } from '../http/request.ts';
import { accessCheck, AuthenticationError, type Access, type Actor } from '../request/access.ts';
import { routeOf } from '../route/route.ts';
import { subjectReadEligibility } from '../semantic/eligibility.ts';
import subjectExists from '../semantic/subject-exists.sql';
import type { KeyRing } from '../tokens/seal.ts';
import { decodeCursor, encodeCursor, type CursorBinding } from '../tokens/cursor.ts';
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
import { readAggregateFigure, readRatingPopulationPage, readRatingQuestion } from './aggregate-read.ts';
import {
  RatingAggregateResponseSchema,
  RatingPopulationPageResponseSchema,
  RatingQuestionResponseSchema,
  RatingVoteInputSchema,
  RatingVoteResponseSchema,
} from './schemas.ts';

type Dependencies = { pool: Pool; access: () => Access; tokens: KeyRing; clock?: KernelClock };
type ReadDependencies = Pick<Dependencies, 'pool'> & { access: Access };
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
const aggregateFailures = {
  400: problemSchema('invalid_request', 'invalid_cursor'),
  401: problemSchema('authentication_required', 'invalid_credentials'),
  403: problemSchema('forbidden'),
  404: problemSchema('not_found'),
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

function requireRatingRead(actor: Actor, ...ids: string[]): void {
  if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
  if (!actor.scopes.includes(VOTE_SCOPE)) throw new ProblemError('forbidden');
  if (ids.some((value) => routeOf(value) === null)) throw new ProblemError('not_found');
}

async function readableSubject(dependencies: ReadDependencies, actor: Actor, subjectId: string, deadline: number) {
  const route = routeOf(subjectId);
  if (route === null) return false;
  const resource = { route, id: subjectId, eligibility: subjectReadEligibility({ route, id: subjectId }) };
  const check = await accessCheck(dependencies.access, actor, 'subject:read', resource, {
    pool: dependencies.pool,
    deadline,
  });
  return withConnection(dependencies.pool, async (client) => {
    const bounded = deadlineClient(client, deadline);
    if (!(await subjectExists.run(bounded, { route, subject_id: subjectId }))) return false;
    return check(bounded);
  });
}

async function readableRealm(dependencies: ReadDependencies, actor: Actor, realmId: string, deadline: number) {
  return (await readRealm(dependencies, actor, realmId, { deadline })) !== null;
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
    .get(
      '/v1/subjects/:subjectId/ratings',
      {
        params: t.Object({ subjectId: id }, closed),
        query: t.Object(
          {
            question: id,
            population: t.Union([id, t.Array(id, { minItems: 1, maxItems: 20 })]),
          },
          closed,
        ),
        response: { 200: RatingAggregateResponseSchema, ...aggregateFailures },
        detail: {
          operationId: 'rating.aggregate_get',
          'x-action': VOTE_SCOPE,
          'x-exposure': 'gate:personal_library',
          security: bearer,
        },
      },
      async ({ actor, params, query, admission, job }) => {
        requireRatingRead(actor, params.subjectId, query.question);
        const populations = Array.isArray(query.population) ? query.population : [query.population];
        if (populations.length < 1 || populations.length > 20) throw new ProblemError('invalid_request');
        requireRatingRead(actor, ...populations);
        return admission.run('normal', job, async () => {
          if (!(await readableSubject(config(), actor, params.subjectId, job.deadline)))
            throw new ProblemError('not_found');
          const question = await readRatingQuestion(dependencies.pool, query.question);
          if (!question) throw new ProblemError('not_found');
          const figures = await Promise.all(
            populations.map(async (population) => {
              if (population !== GLOBAL_CONTEXT.id && !(await readableRealm(config(), actor, population, job.deadline)))
                return {
                  population,
                  count: 0,
                  freshness: { asOf: null, updating: false },
                };
              const figure = await readAggregateFigure(dependencies.pool, {
                questionId: question.id,
                populationId: population,
                targetId: params.subjectId,
                grain: question.grain,
              });
              if (!figure) throw new ProblemError('not_found');
              return figure;
            }),
          );
          return { question: question.id, subject: params.subjectId, figures };
        });
      },
    )
    .get(
      '/v1/subjects/:subjectId/ratings/populations',
      {
        params: t.Object({ subjectId: id }, closed),
        query: t.Object({ question: id, cursor: t.Optional(t.String({ maxLength: 4096 })) }, closed),
        response: { 200: RatingPopulationPageResponseSchema, ...aggregateFailures },
        detail: {
          operationId: 'rating.populations_get',
          'x-action': VOTE_SCOPE,
          'x-exposure': 'gate:personal_library',
          security: bearer,
        },
      },
      async ({ actor, params, query, admission, job }) => {
        requireRatingRead(actor, params.subjectId, query.question);
        return admission.run('normal', job, async () => {
          if (!(await readableSubject(config(), actor, params.subjectId, job.deadline)))
            throw new ProblemError('not_found');
          const question = await readRatingQuestion(dependencies.pool, query.question);
          if (!question) throw new ProblemError('not_found');
          const binding: CursorBinding = {
            operation: 'rating.population-page',
            parameters: { subjectId: params.subjectId, questionId: question.id },
          };
          let after: string | null = null;
          if (query.cursor !== undefined) {
            const now = (dependencies.clock?.() ?? new Date()).getTime();
            const decoded = decodeCursor(dependencies.tokens, binding, query.cursor, now);
            if (
              !decoded.ok ||
              decoded.epoch !== 1 ||
              decoded.after.length !== 1 ||
              typeof decoded.after[0] !== 'string' ||
              routeOf(decoded.after[0]) === null
            )
              throw new ProblemError('invalid_cursor');
            after = decoded.after[0];
          }
          const page = await readRatingPopulationPage(dependencies.pool, {
            questionId: question.id,
            targetId: params.subjectId,
            after,
            limit: 20,
          });
          const visible = await Promise.all(
            page.populations.map(async (population) =>
              population.population === GLOBAL_CONTEXT.id ||
              (await readableRealm(config(), actor, population.population, job.deadline))
                ? population
                : null,
            ),
          );
          const last = page.after;
          const next =
            page.hasMore && last !== null
              ? encodeCursor(
                  dependencies.tokens,
                  binding,
                  { epoch: 1, after: [last] },
                  (dependencies.clock?.() ?? new Date()).getTime(),
                )
              : null;
          return { populations: visible.filter((item) => item !== null), next };
        });
      },
    )
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
