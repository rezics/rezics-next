import { transportResponses } from '../transport-responses.ts';
import { Elysia } from 'elysia';
import { ratingContextsPage, ratingContextsQuery, readStandingRatingContexts } from '../modules/rating/contexts.ts';
import { workRead } from '../modules/work/read-session.ts';
import type { MainWorkDependencies } from './dependencies.ts';
import { workReadError, workReadProblems } from './work-reads.ts';

export const openApiOperations = { '/v1/rating-contexts': { get: { exposure: 'public', rateLimitFamily: 'read', bearer: false } } } as const;

export function ratingContextReadRoutes(work: MainWorkDependencies) {
  return new Elysia().get('/v1/rating-contexts', {
    query: ratingContextsQuery, response: transportResponses(openApiOperations["/v1/rating-contexts"].get, { 200: ratingContextsPage, ...workReadProblems }, 'GET'),
  }, async ({ request, query }) => {
    try {
      return Response.json(await workRead(work, new Request(request.url), query, readStandingRatingContexts),
        { headers: { 'cache-control': 'no-store' } });
    } catch (error) { return workReadError(error); }
  });
}
