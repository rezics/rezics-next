import { transportResponses } from '../transport-responses.ts';
import { Elysia, t } from 'elysia';
import { problemResult } from '../api-contract.ts';
import { authorizedReadProblems } from '../api-responses.ts';
import { TargetNotBound, TargetUnavailable } from '../modules/target/resolve.ts';
import { workRead } from '../modules/work/read-session.ts';
import { workReadFailure } from '../modules/work/read-problems.ts';
import { legacyFailureResponse } from '../modules/problem.ts';
import { readWorkClassifications } from '../modules/work/read-classifications.ts';
import { executeTemplate } from '../modules/query/template-read.ts';
import { template as workCredits } from '../modules/query/templates/work-credits.schema.ts';
import { associationCreditsQuery, associationConflict, associationResult } from '../modules/query/association-contract.ts';
import { associationReadFailure, creditAssociationRequest, executeAssociationQuery } from '../modules/query/association-read.ts';
import { readResourceRating, readResourceRatingContexts, resourceRatingRead } from '../modules/rating/target-read.ts';
import { RatingTargetNotAccepted } from '../modules/rating/acceptance.ts';
import { RatingTargetGrainMismatch } from '../modules/rating/release.ts';
import { ratingContextOwner } from '../modules/rating/target-api.ts';
import { questionLanguagesQuery, questionReadFields } from '../modules/rating/question-presentation-schema.ts';
import { classificationItem, pageFields, pageQuery,
  readId, readQuery, readScope, readUuid, scopeQuery } from '../modules/work/read-contract.ts';
import type { MainWorkDependencies } from './dependencies.ts';
import { commandError, problem } from './problems.ts';
import { operationPolicies } from './operation-policies.ts';
import { workHeaderModels, workHeaderOperation } from './work-header.contract.ts';
import { workHeaderHandler } from './work-header.handler.ts';

export const workReadProblems = { ...authorizedReadProblems, 409: problemResult(409), 422: problemResult(422) };
export function workReadError(error: unknown): Response {
  if (error instanceof RatingTargetNotAccepted) return problem(error.status, error.code, error.message);
  if (error instanceof RatingTargetGrainMismatch) return problem(422, 'rating_target_grain_mismatch', 'Target grain differs from the RatingContext');
  if (error instanceof TargetNotBound) return problem(422, error.code, error.message);
  if (error instanceof TargetUnavailable) return problem(404, error.code, 'Resource is unavailable');
  const failure = workReadFailure(error);
  if (failure) return legacyFailureResponse(failure, { headers: {} });
  return commandError(error);
}
const params = t.Object({ id: readUuid });
const resourceParams = t.Object({ resource: readUuid });
const headers = { 'cache-control': 'private, no-store' };
const detail: { security: Record<string, string[]>[] } = { security: [{}, { bearerAuth: [] }] };
// Bearer is optional for public reads; Mine requires it at runtime. No GET uses an idempotency key.
export const openApiOperations = {
  '/v1/works/{id}': { get: workHeaderOperation.policy },
  '/v1/works/{id}/classifications': { get: { rateLimitFamily: 'read', exposure: 'public', bearer: false } },
  '/v1/works/{id}/credits': { get: { rateLimitFamily: 'read', exposure: 'public', bearer: false } },
  '/v1/resources/{resource}/ratings': { get: { rateLimitFamily: 'read', exposure: 'public', bearer: false } },
  '/v1/resources/{resource}/rating-contexts': { get: { rateLimitFamily: 'read', exposure: 'public', bearer: false } },
} as const;

export function workReadRoutes(work: MainWorkDependencies) {
  return new Elysia()
    .use(operationPolicies(work))
    .model(workHeaderModels)
    [workHeaderOperation.method](workHeaderOperation.path, workHeaderOperation.options, workHeaderHandler(work))
    .get('/v1/works/:id/credits', { params, detail,
      query: t.Union([t.Object({ ...pageQuery,
        limit: t.Optional(t.Numeric({ minimum: 1, maximum: 20, multipleOf: 1 })) }, { additionalProperties: false }), associationCreditsQuery]),
      response: transportResponses(openApiOperations["/v1/works/{id}/credits"].get, {
        200: t.Union([workCredits.response, associationResult]), 304: t.Null(), ...workReadProblems, 409: associationConflict }, 'GET'),
    }, async ({ request, params: path, query: options }) => {
      try {
        if ('profile' in options && options.profile === 'subject-associations-v1') {
          return await executeAssociationQuery(work, request,
            creditAssociationRequest(`https://rezics.com/id/${path.id}`, options), 'work-credits');
        }
        const response = await executeTemplate(work, request, {
          profile: 'template-query-v1', query: workCredits.query, revision: workCredits.revision,
          parameters: { roots: [`https://rezics.com/id/${path.id}`] },
          presentation: { language: options.language, actingSubject: options.actingSubject },
          limit: options.limit, cursor: options.cursor,
        });
        if (response.status !== 200) return response;
        const body = await response.json() as { result: unknown };
        return Response.json(body.result, { status: response.status, headers: response.headers });
      } catch (error) { return 'profile' in options ? associationReadFailure(error) ?? workReadError(error) : workReadError(error); }
    })
    .get('/v1/works/:id/classifications', { params, detail,
      query: t.Object({ ...pageQuery, ...scopeQuery }, { additionalProperties: false }),
      response: transportResponses(openApiOperations["/v1/works/{id}/classifications"].get, { 200: t.Object({ items: t.Array(classificationItem), scope: readScope, ...pageFields }), ...workReadProblems }, 'GET'),
    }, async ({ request, params: path, query: options }) => {
      try { return Response.json(await workRead(work, request, options,
        session => readWorkClassifications(session, `https://rezics.com/id/${path.id}`)), { headers }); }
      catch (error) { return workReadError(error); }
    })
    .get('/v1/resources/:resource/rating-contexts', { params: resourceParams, detail,
      query: t.Object({ ...pageQuery, ...scopeQuery, forProjection: t.Optional(t.Literal('true')), language: t.Optional(questionReadFields.language), ...questionLanguagesQuery }, { additionalProperties: false }),
      response: transportResponses(openApiOperations["/v1/resources/{resource}/rating-contexts"].get, { 200: t.Object({ items: t.Array(t.Object({ context: readId, question: t.String(),
        ...questionReadFields, owner: t.Optional(ratingContextOwner),
        acceptedFrameDimensions: t.Optional(t.Nullable(t.Array(t.Union([
          t.Literal('position'), t.Literal('event'), t.Literal('continuity'),
          t.Literal('work'), t.Literal('release'), t.Literal('realization'),
        ])))),
        scale: t.Object({ min: t.Integer(), max: t.Integer(), step: t.Literal(1) }) })),
        scope: readScope, ...pageFields }), ...workReadProblems }, 'GET'),
    }, async ({ request, params: path, query: options }) => {
      try { return Response.json(await workRead(work, request, options,
        session => readResourceRatingContexts(session, `https://rezics.com/id/${path.resource}`, options.forProjection === 'true')), { headers }); }
      catch (error) { return workReadError(error); }
    })
    .get('/v1/resources/:resource/ratings', { params: resourceParams, detail,
      query: t.Object({ ...readQuery, ...scopeQuery, context: t.Optional(readId) }, { additionalProperties: false }),
      response: transportResponses(openApiOperations["/v1/resources/{resource}/ratings"].get, { 200: resourceRatingRead, ...workReadProblems }, 'GET'),
    }, async ({ request, params: path, query: options }) => {
      try { return Response.json(await workRead(work, request, options,
        session => readResourceRating(session, `https://rezics.com/id/${path.resource}`, options.context)), { headers }); }
      catch (error) { return workReadError(error); }
    });
}
