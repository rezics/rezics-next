import { Elysia, t } from 'elysia';
import { readChapter, readContents } from '../modules/work-contents/read.ts';
import { chapterQuery, chapterRead, contentsPage, contentsQuery } from '../modules/work-contents/read-contract.ts';
import { readUuid } from '../modules/work/read-contract.ts';
import { workRead, type ReadOptions } from '../modules/work/read-session.ts';
import type { MainWorkDependencies } from './dependencies.ts';
import { workReadError, workReadProblems } from './work-reads.ts';

const detail: { security: Record<string, string[]>[] } = { security: [{}, { bearerAuth: [] }] };
const headers = { 'cache-control': 'private, no-store' };
export const openApiOperations = {
  '/v1/works/{id}/contents': { get: { exposure: 'public', bearer: false } },
  '/v1/chapters/{id}': { get: { exposure: 'public', bearer: false } },
} as const;

export function workContentsRoutes(work: MainWorkDependencies) {
  return new Elysia()
    .get('/v1/works/:id/contents', { params: t.Object({ id: readUuid }), detail,
      query: contentsQuery, response: { 200: contentsPage, ...workReadProblems },
    }, async ({ request, params, query }) => {
      try {
        return Response.json(await workRead(work, request, query as ReadOptions,
          session => readContents(session, `https://rezics.com/id/${params.id}`, query)), { headers });
      } catch (error) { return workReadError(error); }
    })
    .get('/v1/chapters/:id', { params: t.Object({ id: readUuid }), detail,
      query: chapterQuery, response: { 200: chapterRead, ...workReadProblems },
    }, async ({ request, params, query }) => {
      try {
        return Response.json(await workRead(work, request, query,
          session => readChapter(session, `https://rezics.com/id/${params.id}`, query)), { headers });
      } catch (error) { return workReadError(error); }
    });
}
