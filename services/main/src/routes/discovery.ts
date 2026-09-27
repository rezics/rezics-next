import { Elysia, t } from 'elysia';
import { readRecentWorks } from '../modules/discovery/recent.ts';
import { pageFields, pageQuery, workCard } from '../modules/work/read-contract.ts';
import { workRead } from '../modules/work/read-session.ts';
import type { MainWorkDependencies } from './dependencies.ts';
import { workReadError, workReadProblems } from './work-reads.ts';

/** Phrase-free public discovery; the response gives exact page size, never an invented total. */
export function discoveryRoutes(work: MainWorkDependencies) {
  return new Elysia().get('/v1/works', {
    query: t.Object({ language: pageQuery.language, limit: pageQuery.limit, cursor: pageQuery.cursor },
      { additionalProperties: false }),
    response: { 200: t.Object({ profile: t.Literal('recent-works-v1'),
      order: t.Literal('metadata-updated-desc'), items: t.Array(workCard), ...pageFields }), ...workReadProblems },
  }, async ({ request, query }) => {
    try {
      // A public list never turns into a private inventory merely because a browser sent a token.
      const publicRequest = new Request(request.url);
      return Response.json(await workRead(work, publicRequest, query, readRecentWorks),
        { headers: { 'cache-control': 'no-store' } });
    } catch (error) { return workReadError(error); }
  });
}
