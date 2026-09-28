import { Elysia, t } from 'elysia';
import { readUuid } from '../modules/work/read-contract.ts';
import { WorkReadUnavailable, workRead } from '../modules/work/read-session.ts';
import { readWorkStats, workStats, workStatsQuery } from '../modules/work/read-stats.ts';
import type { MainWorkDependencies } from './dependencies.ts';
import { workReadError, workReadProblems } from './work-reads.ts';

// A public read: a bearer is optional and, with `actingSubject`, only authenticates; the numbers are everyone's.
export const openApiOperations = {
  '/v1/works/{id}/reader-stats': { get: { bearer: false } },
} as const;

/** The reader numbers under a Work page's rating (`modules/work/read-stats.ts`). */
export function workStatsRoutes(work: MainWorkDependencies) {
  return new Elysia()
    .get('/v1/works/:id/reader-stats', { params: t.Object({ id: readUuid }), query: workStatsQuery,
      detail: { security: [{}, { bearerAuth: [] }] }, response: { 200: workStats, ...workReadProblems },
    }, async ({ request, params, query }) => {
      try {
        if (!work.workStats) throw new WorkReadUnavailable('Reader statistics owner is unavailable');
        return Response.json(await workRead(work, request, { actingSubject: query.actingSubject },
          session => readWorkStats(session, `https://rezics.com/id/${params.id}`, query.context, work.workStats!)),
        { headers: { 'cache-control': 'private, no-store' } });
      } catch (error) { return workReadError(error); }
    });
}
