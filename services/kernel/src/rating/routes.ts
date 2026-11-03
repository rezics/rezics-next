import { sourceClassificationRoutes } from './source-classification-routes.ts';
import { createHash } from 'node:crypto';
import { withHeaders } from '@elysia/openapi';
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
import { IDEMPOTENCY_HEADER, idempotencyKeyOf, SESSION_HEADER } from '../http/request.ts';
import { accessCheck, AuthenticationError, type Access, type Actor } from '../request/access.ts';
import { routeOf } from '../route/route.ts';
import { subjectReadEligibility } from '../semantic/eligibility.ts';
import subjectExists from '../semantic/subject-exists.sql';
import type { KeyRing } from '../tokens/seal.ts';
import { decodeCursor, encodeCursor, type CursorBinding } from '../tokens/cursor.ts';
import type { definitionRoutes } from '../semantic/http/definitions.ts';
import { LibraryNotFoundError } from '../library/command-support.ts';
import { createRealmRatingQuestion, QuestionDefinitionInvalidError } from './question-authoring.ts';
import { ratingQuestionView, readVisibleRatingQuestion, readSelectedQuestionDirectory } from './question-directory.ts';
import { updateQuestionLabel, readQuestionLabel, readQuestionLabelHistory } from './question-label.ts';
import {
  QuestionLifecycleConflictError,
  QuestionLifecycleNotFoundError,
  retireRealmRatingQuestion,
  restoreRealmRatingQuestion,
} from './question-lifecycle.ts';
import { PublicFigureSchema, readSubjectPublicFigure } from './public-figure-http.ts';
import {
  createVoteCommands,
  RatingQuestionNotFoundError,
  RatingQuestionRetiredError,
  VoteInvalidError,
  VOTE_SCOPE,
  type Vote,
} from './votes.ts';
import {
  CLASSIFICATION_BALLOT_READ_AGGREGATE,
  CLASSIFICATION_BALLOT_READ_OWN,
  CLASSIFICATION_BALLOT_SET,
  ClassificationBallotConflictError,
  ClassificationBallotInvalidError,
  ClassificationBallotNotFoundError,
  createClassificationBallotCommands,
} from './classification-ballot.ts';
import { createClassificationBallotOwnPageReader } from './classification-ballot-own-page.ts';
import {
  ClassificationBallotOwnPageQuerySchema,
  ClassificationBallotOwnPageSchema,
} from './classification-ballot-own-page-schemas.ts';
import { readAggregateFigure, readRatingPopulationPage } from './aggregate-read.ts';
import { createOwnVotesReader } from './own-votes-page.ts';
import { OwnVotesPageQuerySchema, OwnVotesPageSchema } from './own-votes-schemas.ts';
import {
  RatingAggregateResponseSchema,
  RatingPopulationPageResponseSchema,
  ClassificationBallotAggregateResponseSchema,
  ClassificationBallotInputSchema,
  ClassificationBallotMutationQuerySchema,
  ClassificationBallotOwnResponseSchema,
  ClassificationBallotSetResponseSchema,
  RatingQuestionCreateInputSchema,
  RatingQuestionLabelInputSchema,
  RatingQuestionLabelResultSchema,
  RatingQuestionLabelSchema,
  RatingQuestionLabelHistoryQuerySchema,
  RatingQuestionLabelHistorySchema,
  RatingQuestionLifecycleInputSchema,
  RatingQuestionLifecycleResultSchema,
  RatingQuestionDirectoryQuerySchema,
  RatingQuestionDirectoryResponseSchema,
  RatingQuestionResponseSchema,
  RatingVoteInputSchema,
  RatingVoteResponseSchema,
} from './schemas.ts';

type Dependencies = { pool: Pool; access: () => Access; tokens: KeyRing; routeKey: Uint8Array; clock?: KernelClock };
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

function requireRoutableIds(...ids: string[]): void {
  if (ids.some((value) => routeOf(value) === null)) throw new ProblemError('not_found');
}

function publicReadDetail(operationId: string, action: string) {
  return {
    operationId,
    'x-action': action,
    'x-exposure': 'public',
    security: [{ bearerAuth: [] }, {}],
  };
}

function classificationDetail(
  operationId: string,
  action: string,
  options: { publicRead?: boolean; write?: boolean; personal?: boolean } = {},
) {
  return {
    operationId,
    'x-action': action,
    'x-exposure': options.personal ? 'gate:personal_library' : 'public',
    'x-resource-types': ['semantic.subject'],
    security: options.publicRead ? [{ bearerAuth: [] }, {}] : bearer,
    ...(options.write ? { 'x-rate-limit': writeRate } : {}),
  };
}

function requireClassificationAccount(actor: Actor, action: string, ...ids: string[]): void {
  if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
  if (!actor.scopes.includes(action)) throw new ProblemError('forbidden');
  requireRoutableIds(...ids);
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
    if (
      error instanceof LibraryNotFoundError ||
      error instanceof RatingQuestionNotFoundError ||
      error instanceof QuestionLifecycleNotFoundError
    )
      throw new ProblemError('not_found');
    if (error instanceof RatingQuestionRetiredError || error instanceof QuestionLifecycleConflictError)
      throw new ProblemError('conflict');
    if (error instanceof ClassificationBallotNotFoundError) throw new ProblemError('not_found');
    if (error instanceof ClassificationBallotConflictError) throw new ProblemError('conflict');
    if (error instanceof ClassificationBallotInvalidError)
      throw new ProblemError('invalid_request', {
        errors: [{ pointer: `/${error.field}`, code: 'out_of_range' }],
      });
    if (error instanceof VoteInvalidError || error instanceof QuestionDefinitionInvalidError)
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

/** Private account-owned vote transport. Commands remain responsible for partition ownership and current account state. */
export function ratingRoutes(app: ReturnType<typeof definitionRoutes>, dependencies: Dependencies) {
  const config = () => ({ ...dependencies, access: dependencies.access() });
  const votes = () => createVoteCommands(config());
  const classificationBallots = () => createClassificationBallotCommands(config());
  return sourceClassificationRoutes(app, dependencies)
    .model('PublicFigure', PublicFigureSchema)
    .get(
      '/v1/me/rating-votes',
      {
        query: OwnVotesPageQuerySchema,
        response: { 200: OwnVotesPageSchema, ...aggregateFailures },
        detail: detail('rating.own_votes_page'),
      },
      async ({ actor, query, admission, job, set }) => {
        requirePersonalScope(actor);
        set.headers['cache-control'] = 'no-store';
        return admission.run('normal', job, () =>
          command(() => createOwnVotesReader(config()).page(actor, query, job.deadline)),
        );
      },
    )
    .get(
      '/v1/me/classification-assessments',
      {
        query: ClassificationBallotOwnPageQuerySchema,
        response: { 200: ClassificationBallotOwnPageSchema, ...aggregateFailures },
        detail: classificationDetail(
          'classification_ballot.own_page',
          CLASSIFICATION_BALLOT_READ_OWN,
          { personal: true },
        ),
      },
      async ({ actor, query, admission, job, set }) => {
        requireClassificationAccount(actor, CLASSIFICATION_BALLOT_READ_OWN);
        if ((query.selectedSubjectId === undefined) !== (query.selectedAssociationId === undefined))
          throw new ProblemError('invalid_request');
        set.headers['cache-control'] = 'no-store';
        const selected =
          query.selectedSubjectId && query.selectedAssociationId
            ? { subjectId: query.selectedSubjectId, associationId: query.selectedAssociationId }
            : undefined;
        return admission.run('normal', job, () =>
          command(() =>
            createClassificationBallotOwnPageReader(config()).page(
              actor,
              { ...(query.cursor === undefined ? {} : { cursor: query.cursor }), ...(selected ? { selected } : {}) },
              job.deadline,
            ),
          ),
        );
      },
    )
    .get(
      '/v1/subjects/:id/figure',
      {
        params: t.Object({ id }, closed),
        response: {
          200: withHeaders(t.Object({ figure: t.Ref('PublicFigure') }, closed), {
            etag: t.String(),
            'cache-control': t.Literal('no-cache'),
          }),
          ...aggregateFailures,
        },
        detail: publicReadDetail('rating.figure_get', 'subject:read'),
      },
      async ({ actor, params, admission, job, set }) => {
        requireRoutableIds(params.id);
        return admission.run('normal', job, async () => {
          if (!(await readableSubject(config(), actor, params.id, job.deadline))) throw new ProblemError('not_found');
          const result = await readSubjectPublicFigure(dependencies.pool, params.id, job.deadline);
          if (!result) throw new ProblemError('not_found');
          set.headers.etag = `"${result.revision}"`;
          set.headers['cache-control'] = 'no-cache';
          return { figure: result.figure };
        });
      },
    )
    .get(
      '/v1/subjects/:id/ratings',
      {
        params: t.Object({ id }, closed),
        query: t.Object(
          {
            question: id,
            population: t.Union([id, t.Array(id, { minItems: 1, maxItems: 20 })]),
          },
          closed,
        ),
        response: { 200: RatingAggregateResponseSchema, ...aggregateFailures },
        detail: {
          ...publicReadDetail('rating.aggregate_get', 'subject:read'),
          'x-resource-types': ['semantic.subject', 'community.realm', 'semantic.context'],
        },
      },
      async ({ actor, params, query, admission, job }) => {
        const populations = Array.isArray(query.population) ? query.population : [query.population];
        if (populations.length < 1 || populations.length > 20) throw new ProblemError('invalid_request');
        requireRoutableIds(params.id, query.question, ...populations);
        return admission.run('normal', job, async () => {
          if (!(await readableSubject(config(), actor, params.id, job.deadline))) throw new ProblemError('not_found');
          const question = await readVisibleRatingQuestion(config(), actor, query.question, job.deadline);
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
                targetId: params.id,
                grain: question.grain,
              });
              if (!figure) throw new ProblemError('not_found');
              return figure;
            }),
          );
          return { question: question.id, subject: params.id, figures };
        });
      },
    )
    .get(
      '/v1/subjects/:id/ratings/populations',
      {
        params: t.Object({ id }, closed),
        query: t.Object({ question: id, cursor: t.Optional(t.String({ maxLength: 4096 })) }, closed),
        response: { 200: RatingPopulationPageResponseSchema, ...aggregateFailures },
        detail: {
          ...publicReadDetail('rating.populations_get', 'subject:read'),
          'x-resource-types': ['semantic.subject', 'community.realm', 'semantic.context'],
        },
      },
      async ({ actor, params, query, admission, job }) => {
        requireRoutableIds(params.id, query.question);
        return admission.run('normal', job, async () => {
          if (!(await readableSubject(config(), actor, params.id, job.deadline))) throw new ProblemError('not_found');
          const question = await readVisibleRatingQuestion(config(), actor, query.question, job.deadline);
          if (!question) throw new ProblemError('not_found');
          const binding: CursorBinding = {
            operation: 'rating.population-page',
            parameters: { subjectId: params.id, questionId: question.id },
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
            targetId: params.id,
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
      '/v1/subjects/:id/ratings/:questionId/vote',
      {
        params: t.Object({ id, questionId: id }, closed),
        headers,
        body: RatingVoteInputSchema,
        response: {
          200: withHeaders(RatingVoteResponseSchema, { [SESSION_HEADER]: t.Optional(t.String()) }),
          ...failures,
        },
        detail: detail('rating.vote_put', true),
      },
      async ({ actor, params, body, headers, admission, job, session }) => {
        requirePersonalScope(actor, params.id, params.questionId);
        const key = idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]);
        const result = await admission.run('normal', job, () =>
          command(() =>
            votes().putVoteOutcome(
              actor,
              { questionId: params.questionId, targetId: params.id, units: body.units },
              key,
            ),
          ),
        );
        if (!result.vote) throw new ProblemError('not_found');
        if (result.component) session.record(result.component);
        return voteView(result.vote);
      },
    )
    .delete(
      '/v1/subjects/:id/ratings/:questionId/vote',
      {
        params: t.Object({ id, questionId: id }, closed),
        headers,
        response: {
          204: withHeaders(t.Void(), { [SESSION_HEADER]: t.Optional(t.String()) }),
          ...failures,
        },
        detail: detail('rating.vote_delete', true),
      },
      async ({ actor, params, headers, admission, job, set, session }) => {
        requirePersonalScope(actor, params.id, params.questionId);
        const key = idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]);
        const result = await admission.run('normal', job, () =>
          command(() =>
            votes().putVoteOutcome(actor, { questionId: params.questionId, targetId: params.id, units: null }, key),
          ),
        );
        if (result.component) session.record(result.component);
        set.status = 204;
      },
    )
    .get(
      '/v1/subjects/:id/ratings/:questionId/vote',
      {
        params: t.Object({ id, questionId: id }, closed),
        response: { 200: RatingVoteResponseSchema, ...failures },
        detail: detail('rating.vote_get'),
      },
      async ({ actor, params, admission, job }) => {
        requirePersonalScope(actor, params.id, params.questionId);
        const result = await admission.run('normal', job, () =>
          command(() => votes().readOwnVote(actor, params.questionId, params.id)),
        );
        if (!result || result.units === null) throw new ProblemError('not_found');
        return voteView(result);
      },
    )
    .put(
      '/v1/subjects/:id/classification-associations/:associationId/assessment',
      {
        params: t.Object({ id, associationId: id }, closed),
        query: ClassificationBallotMutationQuerySchema,
        headers,
        body: ClassificationBallotInputSchema,
        response: { 200: ClassificationBallotSetResponseSchema, ...failures },
        detail: classificationDetail('classification_ballot.set', CLASSIFICATION_BALLOT_SET, { write: true }),
      },
      async ({ actor, params, body, query, headers, admission, job }) => {
        requireClassificationAccount(actor, CLASSIFICATION_BALLOT_SET, params.id, params.associationId);
        const key = idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]);
        const result = await admission.run('normal', job, () =>
          command(() =>
            classificationBallots().set(
              actor,
              {
                subjectId: params.id,
                associationId: params.associationId,
                assessment: body.assessment,
                falsePositive: body.falsePositive,
                ...(query.expectedRevision === undefined ? {} : { expectedRevision: query.expectedRevision }),
              },
              key,
            ),
          ),
        );
        return result as { associationId: string; revision: string; delivery: 'unchanged' | 'enqueued' };
      },
    )
    .delete(
      '/v1/subjects/:id/classification-associations/:associationId/assessment',
      {
        params: t.Object({ id, associationId: id }, closed),
        query: ClassificationBallotMutationQuerySchema,
        headers,
        response: { 204: t.Void(), ...failures },
        detail: classificationDetail('classification_ballot.clear', CLASSIFICATION_BALLOT_SET, { write: true }),
      },
      async ({ actor, params, query, headers, admission, job, set }) => {
        requireClassificationAccount(actor, CLASSIFICATION_BALLOT_SET, params.id, params.associationId);
        const key = idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]);
        await admission.run('normal', job, () =>
          command(() =>
            classificationBallots().clear(actor, params.id, params.associationId, key, query.expectedRevision),
          ),
        );
        set.status = 204;
      },
    )
    .get(
      '/v1/subjects/:id/classification-associations/:associationId/assessment',
      {
        params: t.Object({ id, associationId: id }, closed),
        response: { 200: ClassificationBallotOwnResponseSchema, ...failures },
        detail: classificationDetail('classification_ballot.read_own', CLASSIFICATION_BALLOT_READ_OWN),
      },
      async ({ actor, params, admission, job }) => {
        requireClassificationAccount(actor, CLASSIFICATION_BALLOT_READ_OWN, params.id, params.associationId);
        return admission.run('normal', job, () =>
          command(() => classificationBallots().readOwn(actor, params.id, params.associationId, job.deadline)),
        );
      },
    )
    .get(
      '/v1/subjects/:id/classification-associations/:associationId/aggregate',
      {
        params: t.Object({ id, associationId: id }, closed),
        response: { 200: ClassificationBallotAggregateResponseSchema, ...aggregateFailures },
        detail: classificationDetail('classification_ballot.read_aggregate', CLASSIFICATION_BALLOT_READ_AGGREGATE, {
          publicRead: true,
        }),
      },
      async ({ actor, params, admission, job }) => {
        requireRoutableIds(params.id, params.associationId);
        return admission.run('normal', job, () =>
          command(() => classificationBallots().readAggregate(actor, params.id, params.associationId, job.deadline)),
        );
      },
    )
    .post(
      '/v1/realms/:realmId/rating-questions',
      {
        params: t.Object({ realmId: id }, closed),
        headers,
        body: RatingQuestionCreateInputSchema,
        response: {
          201: withHeaders(RatingQuestionResponseSchema, { [SESSION_HEADER]: t.Optional(t.String()) }),
          ...failures,
        },
        detail: {
          operationId: 'rating.question_create',
          'x-action': 'realm:manage',
          'x-exposure': 'public',
          'x-resource-types': ['community.realm'],
          'x-rate-limit': writeRate,
          security: bearer,
        },
      },
      async ({ actor, params, body, headers, admission, job, session, set }) => {
        if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
        requireRoutableIds(params.realmId);
        const key = idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]);
        const outcome = await admission.run('normal', job, () =>
          command(() =>
            createRealmRatingQuestion(
              config(),
              actor,
              { ...body, realmId: params.realmId },
              { idempotencyKey: key, deadline: job.deadline },
            ),
          ),
        );
        session.record({ partition: outcome.partition, epoch: outcome.epoch, position: outcome.position });
        set.status = 201;
        return outcome.value;
      },
    )
    .put(
      '/v1/rating-questions/:questionId/label',
      {
        params: t.Object({ questionId: id }, closed),
        headers,
        body: RatingQuestionLabelInputSchema,
        response: {
          200: withHeaders(RatingQuestionLabelResultSchema, { [SESSION_HEADER]: t.Optional(t.String()) }),
          ...failures,
        },
        detail: {
          operationId: 'rating.question_label_put',
          'x-action': 'realm:manage',
          'x-exposure': 'public',
          'x-resource-types': ['community.realm'],
          'x-rate-limit': writeRate,
          security: bearer,
        },
      },
      async ({ actor, params, body, headers, admission, job, session }) => {
        if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
        requireRoutableIds(params.questionId);
        const key = idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]);
        const outcome = await admission.run('normal', job, () =>
          command(() =>
            updateQuestionLabel(
              config(),
              actor,
              { ...body, questionId: params.questionId },
              { idempotencyKey: key, deadline: job.deadline },
            ),
          ),
        );
        session.record({ partition: outcome.partition, epoch: outcome.epoch, position: outcome.position });
        return outcome.value;
      },
    )
    .post(
      '/v1/rating-questions/:questionId/$retire',
      {
        params: t.Object({ questionId: id }, closed),
        headers,
        body: RatingQuestionLifecycleInputSchema,
        response: {
          200: withHeaders(RatingQuestionLifecycleResultSchema, { [SESSION_HEADER]: t.Optional(t.String()) }),
          ...failures,
        },
        detail: {
          operationId: 'rating.question_retire',
          'x-action': 'realm:manage',
          'x-exposure': 'public',
          'x-resource-types': ['community.realm'],
          'x-rate-limit': writeRate,
          security: bearer,
        },
      },
      async ({ actor, params, body, headers, admission, job, session }) => {
        if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
        requireRoutableIds(params.questionId);
        const key = idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]);
        const outcome = await admission.run('normal', job, () =>
          command(() =>
            retireRealmRatingQuestion(
              config(),
              actor,
              { questionId: params.questionId, expectedRevision: body.expectedLifecycleRevision },
              { idempotencyKey: key, deadline: job.deadline },
            ),
          ),
        );
        session.record({ partition: outcome.partition, epoch: outcome.epoch, position: outcome.position });
        return outcome.value;
      },
    )
    .post(
      '/v1/rating-questions/:questionId/$restore',
      {
        params: t.Object({ questionId: id }, closed),
        headers,
        body: RatingQuestionLifecycleInputSchema,
        response: {
          200: withHeaders(RatingQuestionLifecycleResultSchema, { [SESSION_HEADER]: t.Optional(t.String()) }),
          ...failures,
        },
        detail: {
          operationId: 'rating.question_restore',
          'x-action': 'realm:manage',
          'x-exposure': 'public',
          'x-resource-types': ['community.realm'],
          'x-rate-limit': writeRate,
          security: bearer,
        },
      },
      async ({ actor, params, body, headers, admission, job, session }) => {
        if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
        requireRoutableIds(params.questionId);
        const key = idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]);
        const outcome = await admission.run('normal', job, () =>
          command(() =>
            restoreRealmRatingQuestion(
              config(),
              actor,
              { questionId: params.questionId, expectedRevision: body.expectedLifecycleRevision },
              { idempotencyKey: key, deadline: job.deadline },
            ),
          ),
        );
        session.record({ partition: outcome.partition, epoch: outcome.epoch, position: outcome.position });
        return outcome.value;
      },
    )
    .get(
      '/v1/rating-questions/:questionId/labels',
      {
        params: t.Object({ questionId: id }, closed),
        query: RatingQuestionLabelHistoryQuerySchema,
        transform: ({ request }) => {
          const parameters = new URL(request.url).searchParams;
          for (const name of parameters.keys())
            if (!['limit', 'cursor'].includes(name) || parameters.getAll(name).length !== 1)
              throw new ProblemError('invalid_request');
        },
        response: { 200: RatingQuestionLabelHistorySchema, ...aggregateFailures },
        detail: {
          ...publicReadDetail('rating.question_label_history', 'realm:read'),
          'x-resource-types': ['community.realm'],
        },
      },
      async ({ actor, params, query, admission, job }) => {
        requireRoutableIds(params.questionId);
        return admission.run('normal', job, () =>
          readQuestionLabelHistory(
            config(),
            actor,
            {
              questionId: params.questionId,
              limit: query.limit ?? 20,
              ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
            },
            job.deadline,
          ),
        );
      },
    )
    .get(
      '/v1/rating-questions/:questionId/labels/:labelRevision',
      {
        params: t.Object(
          { questionId: id, labelRevision: t.Numeric({ minimum: 1, maximum: 2_147_483_647, multipleOf: 1 }) },
          closed,
        ),
        response: { 200: RatingQuestionLabelSchema, ...aggregateFailures },
        detail: {
          ...publicReadDetail('rating.question_label_get', 'realm:read'),
          'x-resource-types': ['community.realm'],
        },
      },
      async ({ actor, params, admission, job }) => {
        requireRoutableIds(params.questionId);
        const label = await admission.run('normal', job, () =>
          readQuestionLabel(config(), actor, params.questionId, params.labelRevision, job.deadline),
        );
        if (!label) throw new ProblemError('not_found');
        return label;
      },
    )
    .get(
      '/v1/rating-questions',
      {
        query: RatingQuestionDirectoryQuerySchema,
        transform: ({ request }) => {
          const parameters = new URL(request.url).searchParams;
          for (const name of parameters.keys())
            if (!['limit', 'cursor', 'realm'].includes(name) || parameters.getAll(name).length !== 1)
              throw new ProblemError('invalid_request');
        },
        response: { 200: RatingQuestionDirectoryResponseSchema, ...aggregateFailures },
        detail: {
          ...publicReadDetail('rating.question_list', 'definitions:read'),
          'x-resource-types': ['community.realm', 'semantic.context'],
        },
      },
      async ({ actor, query, admission, job }) => {
        return admission.run('normal', job, async () => {
          const limit = query.limit ?? 20;
          // Bind every verified credential-authority field, with scopes treated as a set.
          const authority =
            actor.kind === 'anonymous' ? actor : { ...actor, scopes: [...new Set(actor.scopes)].sort() };
          const binding: CursorBinding = {
            operation: 'rating.question-directory',
            parameters: {
              limit,
              authority: createHash('sha256').update(JSON.stringify(authority)).digest('hex'),
              ...(query.realm === undefined ? {} : { realm: query.realm }),
            },
          };
          let after: string | null = null;
          let lifecycleGeneration: string | undefined;
          if (query.cursor !== undefined) {
            const decoded = decodeCursor(
              dependencies.tokens,
              binding,
              query.cursor,
              (dependencies.clock?.() ?? new Date()).getTime(),
            );
            if (
              !decoded.ok ||
              decoded.epoch !== 2 ||
              decoded.after.length !== 2 ||
              typeof decoded.after[0] !== 'string' ||
              !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(decoded.after[0]) ||
              typeof decoded.after[1] !== 'string' ||
              !/^(0|[1-9][0-9]{0,18})$/.test(decoded.after[1])
            )
              throw new ProblemError('invalid_cursor');
            after = decoded.after[0];
            lifecycleGeneration = decoded.after[1];
          }
          const page = await readSelectedQuestionDirectory(
            config(),
            actor,
            {
              after,
              limit,
              ...(query.realm === undefined ? {} : { realmId: query.realm }),
              ...(lifecycleGeneration === undefined ? {} : { lifecycleGeneration }),
            },
            job.deadline,
          );
          return {
            ratingQuestions: page.ratingQuestions,
            next:
              page.hasMore && page.after !== null
                ? encodeCursor(
                    dependencies.tokens,
                    binding,
                    { epoch: 2, after: [page.after, page.lifecycleGeneration] },
                    (dependencies.clock?.() ?? new Date()).getTime(),
                  )
                : null,
          };
        });
      },
    )
    .get(
      '/v1/rating-questions/:questionId',
      {
        params: t.Object({ questionId: id }, closed),
        response: { 200: RatingQuestionResponseSchema, ...failures },
        detail: {
          ...publicReadDetail('rating.question_get', 'definitions:read'),
          'x-resource-types': ['community.realm', 'semantic.context'],
        },
      },
      async ({ actor, params, admission, job }) => {
        requireRoutableIds(params.questionId);
        const question = await admission.run('normal', job, () =>
          readVisibleRatingQuestion(config(), actor, params.questionId, job.deadline),
        );
        if (!question) throw new ProblemError('not_found');
        return ratingQuestionView(question);
      },
    );
}
