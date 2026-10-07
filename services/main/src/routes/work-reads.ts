import { Elysia, t } from 'elysia';
import { problemResult } from '../api-contract.ts';
import { authorizedReadProblems } from '../api-responses.ts';
import { MediaUnavailable } from '../modules/media/store.ts';
import { ContextCommandUnavailable } from '../modules/context/command.ts';
import { SearchSnapshotMoved } from '../modules/work/search-readiness.ts';
import { TargetNotBound, TargetUnavailable } from '../modules/target/resolve.ts';
import { WorkReadInvalid, WorkReadLimit, WorkReadMissing, WorkReadMoved, WorkReadUnavailable,
  workRead } from '../modules/work/read-session.ts';
import { readWorkHeader } from '../modules/work/read-header.ts';
import { readWorkPage } from '../modules/work/read-pages.ts';
import { readWorkClassifications } from '../modules/work/read-classifications.ts';
import { readResourceRating, readResourceRatingContexts, resourceRatingRead } from '../modules/rating/target-read.ts';
import { RatingTargetNotAccepted } from '../modules/rating/acceptance.ts';
import { RatingTargetGrainMismatch } from '../modules/rating/release.ts';
import { ratingContextOwner } from '../modules/rating/target-api.ts';
import { questionLanguagesQuery, questionReadFields } from '../modules/rating/question-presentation-schema.ts';
import { adoptionItem, classificationItem, creditItem, pageFields, pageQuery,
  readId, readLanguage, readQuery, readScope, readUuid, scopeQuery, versionItem,
  workHeader } from '../modules/work/read-contract.ts';
import type { MainWorkDependencies } from './dependencies.ts';
import { commandError, problem } from './problems.ts';

export const workReadProblems = { ...authorizedReadProblems, 409: problemResult(409), 422: problemResult(422) };
export function workReadError(error: unknown): Response {
  if (error instanceof RatingTargetNotAccepted) return problem(error.status, error.code, error.message);
  if (error instanceof RatingTargetGrainMismatch) return problem(422, 'rating_target_grain_mismatch', 'Target grain differs from the RatingContext');
  if (error instanceof TargetNotBound) return problem(422, error.code, error.message);
  if (error instanceof TargetUnavailable) return problem(404, error.code, 'Resource is unavailable');
  if (error instanceof WorkReadInvalid) return problem(400, 'invalid_work_read', error.message);
  if (error instanceof WorkReadMissing) return problem(404, 'work_unavailable', 'Resource is unavailable');
  if (error instanceof WorkReadMoved || error instanceof SearchSnapshotMoved) {
    return problem(409, 'read_basis_changed', 'Restart the read from its first page');
  }
  if (error instanceof WorkReadLimit) return problem(422, 'work_read_budget_exceeded', 'Work read exceeds its budget');
  if (error instanceof WorkReadUnavailable || error instanceof MediaUnavailable || error instanceof ContextCommandUnavailable) {
    return problem(503, 'work_read_unavailable', 'Work read is unavailable');
  }
  return commandError(error);
}
const params = t.Object({ id: readUuid });
const resourceParams = t.Object({ resource: readUuid });
const query = t.Object(pageQuery, { additionalProperties: false });
const headers = { 'cache-control': 'private, no-store' };
const detail: { security: Record<string, string[]>[] } = { security: [{}, { bearerAuth: [] }] };
// Bearer is optional for public reads; Mine requires it at runtime. No GET uses an idempotency key.
export const openApiOperations = {
  '/v1/works/{id}': { get: { rateLimitFamily: 'read', exposure: 'public', bearer: false } },
  '/v1/works/{id}/versions': { get: { rateLimitFamily: 'read', exposure: 'public', bearer: false } },
  '/v1/works/{id}/adoptions': { get: { rateLimitFamily: 'read', exposure: 'public', bearer: false } },
  '/v1/works/{id}/credits': { get: { rateLimitFamily: 'read', exposure: 'public', bearer: false } },
  '/v1/works/{id}/classifications': { get: { rateLimitFamily: 'read', exposure: 'public', bearer: false } },
  '/v1/resources/{resource}/ratings': { get: { rateLimitFamily: 'read', exposure: 'public', bearer: false } },
  '/v1/resources/{resource}/rating-contexts': { get: { rateLimitFamily: 'read', exposure: 'public', bearer: false } },
} as const;

export function workReadRoutes(work: MainWorkDependencies) {
  return new Elysia()
    .get('/v1/works/:id', { params, detail, query: t.Object(readQuery, { additionalProperties: false }),
      response: { 200: workHeader, ...workReadProblems },
    }, async ({ request, params: path, query: options }) => {
      try { return Response.json(await workRead(work, request, { ...options, localBasis: true },
        session => readWorkHeader(session, `https://rezics.com/id/${path.id}`)), { headers }); }
      catch (error) { return workReadError(error); }
    })
    .get('/v1/works/:id/versions', { params, detail,
      query: t.Object({ ...pageQuery, contentLanguage: t.Optional(readLanguage),
        kind: t.Optional(t.Union([t.Literal('text-variant'), t.Literal('release')])) }, { additionalProperties: false }),
      response: { 200: t.Object({ items: t.Array(versionItem), ...pageFields }), ...workReadProblems },
    }, async ({ request, params: path, query: options }) => {
      try { return Response.json(await workRead(work, request, options,
        session => readWorkPage(session, `https://rezics.com/id/${path.id}`, 'versions',
          { language: options.contentLanguage, kind: options.kind })), { headers }); }
      catch (error) { return workReadError(error); }
    })
    .get('/v1/works/:id/adoptions', { params, detail, query,
      response: { 200: t.Object({ items: t.Array(adoptionItem), ...pageFields }), ...workReadProblems },
    }, async ({ request, params: path, query: options }) => {
      try { return Response.json(await workRead(work, request, options,
        session => readWorkPage(session, `https://rezics.com/id/${path.id}`, 'adoptions')), { headers }); }
      catch (error) { return workReadError(error); }
    })
    .get('/v1/works/:id/credits', { params, detail, query,
      response: { 200: t.Object({ items: t.Array(creditItem), ...pageFields }), ...workReadProblems },
    }, async ({ request, params: path, query: options }) => {
      try { return Response.json(await workRead(work, request, options,
        session => readWorkPage(session, `https://rezics.com/id/${path.id}`, 'credits')), { headers }); }
      catch (error) { return workReadError(error); }
    })
    .get('/v1/works/:id/classifications', { params, detail,
      query: t.Object({ ...pageQuery, ...scopeQuery }, { additionalProperties: false }),
      response: { 200: t.Object({ items: t.Array(classificationItem), scope: readScope, ...pageFields }), ...workReadProblems },
    }, async ({ request, params: path, query: options }) => {
      try { return Response.json(await workRead(work, request, options,
        session => readWorkClassifications(session, `https://rezics.com/id/${path.id}`)), { headers }); }
      catch (error) { return workReadError(error); }
    })
    .get('/v1/resources/:resource/rating-contexts', { params: resourceParams, detail,
      query: t.Object({ ...pageQuery, ...scopeQuery, forProjection: t.Optional(t.Literal('true')), language: t.Optional(questionReadFields.language), ...questionLanguagesQuery }, { additionalProperties: false }),
      response: { 200: t.Object({ items: t.Array(t.Object({ context: readId, question: t.String(),
        ...questionReadFields, owner: t.Optional(ratingContextOwner),
        acceptedFrameDimensions: t.Optional(t.Nullable(t.Array(t.Union([
          t.Literal('position'), t.Literal('event'), t.Literal('continuity'),
          t.Literal('work'), t.Literal('release'), t.Literal('realization'),
        ])))),
        scale: t.Object({ min: t.Integer(), max: t.Integer(), step: t.Literal(1) }) })),
        scope: readScope, ...pageFields }), ...workReadProblems },
    }, async ({ request, params: path, query: options }) => {
      try { return Response.json(await workRead(work, request, options,
        session => readResourceRatingContexts(session, `https://rezics.com/id/${path.resource}`, options.forProjection === 'true')), { headers }); }
      catch (error) { return workReadError(error); }
    })
    .get('/v1/resources/:resource/ratings', { params: resourceParams, detail,
      query: t.Object({ ...readQuery, ...scopeQuery, context: t.Optional(readId) }, { additionalProperties: false }),
      response: { 200: resourceRatingRead, ...workReadProblems },
    }, async ({ request, params: path, query: options }) => {
      try { return Response.json(await workRead(work, request, options,
        session => readResourceRating(session, `https://rezics.com/id/${path.resource}`, options.context)), { headers }); }
      catch (error) { return workReadError(error); }
    });
}
