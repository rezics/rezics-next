import { Elysia, t } from 'elysia';
import { rankingInterval, rankingMetric, rankingPage } from '../modules/rankings/contract.ts';
import { RankingProjectionUnavailable } from '../modules/rankings/projection.ts';
import { readRankings } from '../modules/rankings/read.ts';
import { pageQuery, readLanguage, readUuid } from '../modules/work/read-contract.ts';
import { publicWorkRead } from '../modules/work/read-session.ts';
import type { MainWorkDependencies } from './dependencies.ts';
import { problem } from './problems.ts';
import { workReadError, workReadProblems } from './work-reads.ts';

const query = t.Object({ metric: t.Optional(rankingMetric), interval: t.Optional(rankingInterval),
  limit: pageQuery.limit, cursor: pageQuery.cursor, language: t.Optional(readLanguage) },
{ additionalProperties: false });
const headers = { 'cache-control': 'no-store' };
const id = (uuid: string) => `https://rezics.com/id/${uuid}`;
export const openApiOperations = {
  '/v1/realms/{realm}/rankings': { get: { exposure: 'public', bearer: false } },
  '/v1/rankings/trending': { get: { exposure: 'public', bearer: false } },
  '/v1/realms/{realm}/modules/rising': { get: { exposure: 'public', bearer: false } },
} as const;

export function rankingRoutes(work: MainWorkDependencies) {
  const read = async (request: Request, options: { metric?: 'reads' | 'finished-chapters' | 'reviews';
    interval?: 'day' | 'week' | 'month'; limit?: number; cursor?: string; language?: string },
  realm: string | null, order: 'score' | 'growth') => {
    if (!work.readRankings) return problem(503, 'rankings_unavailable', 'Rankings are unavailable');
    try {
      return Response.json(await publicWorkRead(work, request, options,
        session => readRankings(session, work.readRankings!, { realm,
          metric: options.metric ?? 'reads', interval: options.interval ?? 'week', order })), { headers });
    } catch (error) {
      if (error instanceof RankingProjectionUnavailable) {
        return problem(503, 'rankings_unavailable', error.message);
      }
      return workReadError(error);
    }
  };
  return new Elysia()
    .get('/v1/realms/:realm/rankings', { params: t.Object({ realm: readUuid }), query,
      response: { 200: rankingPage, ...workReadProblems } },
    ({ request, params, query: options }) => read(request, options, id(params.realm), 'score'))
    .get('/v1/rankings/trending', { query,
      response: { 200: rankingPage, ...workReadProblems } },
    ({ request, query: options }) => read(request, options, null, 'score'))
    .get('/v1/realms/:realm/modules/rising', { params: t.Object({ realm: readUuid }), query,
      response: { 200: rankingPage, ...workReadProblems } },
    ({ request, params, query: options }) => read(request, options, id(params.realm), 'growth'));
}
