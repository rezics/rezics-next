import { Elysia } from 'elysia';
import {
  ratingPopulationsPage,
  ratingPopulationsQuery,
  readRatingPopulations,
} from '../modules/rating/populations.ts';
import { publicWorkRead } from '../modules/work/read-session.ts';
import type { MainWorkDependencies } from './dependencies.ts';
import { workReadError, workReadProblems } from './work-reads.ts';

export const openApiOperations = { '/v1/rating-populations': { get: { exposure: 'public', bearer: false } } } as const;
export function ratingPopulationRoutes(work: MainWorkDependencies) {
  return new Elysia().get(
    '/v1/rating-populations',
    {
      query: ratingPopulationsQuery,
      response: { 200: ratingPopulationsPage, ...workReadProblems },
    },
    async ({ request, query }) => {
      try {
        return Response.json(
          await publicWorkRead(
            work,
            request,
            { limit: query.limit, cursor: query.cursor },
            (session) => readRatingPopulations(session, query, request),
          ),
          { headers: { 'cache-control': 'private, no-store' } },
        );
      } catch (error) {
        return workReadError(error);
      }
    },
  );
}
