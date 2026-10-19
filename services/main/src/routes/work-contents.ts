import { transportResponses } from '../transport-responses.ts';
import { Elysia, t } from 'elysia';
import { readChapter, readContents } from '../modules/work-contents/read.ts';
import { chapterQuery, chapterRead, contentsPage, contentsQuery } from '../modules/work-contents/read-contract.ts';
import { readUuid } from '../modules/work/read-contract.ts';
import { publicWorkRead, workRead } from '../modules/work/read-session.ts';
import type { MainWorkDependencies } from './dependencies.ts';
import { workReadError, workReadProblems } from './work-reads.ts';

const detail: { security: Record<string, string[]>[] } = { security: [{}, { bearerAuth: [] }] };
const headers = { 'cache-control': 'private, no-store' };
export const openApiOperations = {
  '/v1/works/{id}/contents': { get: { exposure: 'public', rateLimitFamily: 'read', bearer: false } },
  '/v1/chapters/{id}': { get: { exposure: 'public', rateLimitFamily: 'read', bearer: false } },
} as const;

export function workContentsRoutes(work: MainWorkDependencies) {
  return new Elysia()
    .get('/v1/works/:id/contents', { params: t.Object({ id: readUuid }), detail,
      query: contentsQuery, response: transportResponses(openApiOperations["/v1/works/{id}/contents"].get, { 200: contentsPage, ...workReadProblems }, 'GET'),
    }, async ({ request, params, query }) => {
      try {
        const read = query.actingSubject ? workRead : publicWorkRead;
        return Response.json(await read(work, request, query,
          session => readContents(session, `https://rezics.com/id/${params.id}`, query)), { headers });
      } catch (error) { return workReadError(error); }
    })
    .get('/v1/chapters/:id', { params: t.Object({ id: readUuid }), detail,
      query: chapterQuery, response: transportResponses(openApiOperations["/v1/chapters/{id}"].get, { 200: chapterRead, ...workReadProblems }, 'GET'),
    }, async ({ request, params, query }) => {
      try {
        const read = query.actingSubject ? workRead : publicWorkRead;
        return Response.json(await read(work, request, query,
          session => readChapter(session, `https://rezics.com/id/${params.id}`, query)), { headers });
      } catch (error) { return workReadError(error); }
    });
}
