import { Elysia, t } from 'elysia';
import { ContentLimitExceeded } from '../../../content/src/core.ts';
import { readWorkActivityHistory, readWorkDiscussion } from '../modules/work-activity/read.ts';
import { activityHistoryPage, discussionPage, historyKind } from '../modules/work-activity/read-contract.ts';
import { pageQuery, readId, readUuid } from '../modules/work/read-contract.ts';
import { workRead, WorkReadLimit } from '../modules/work/read-session.ts';
import type { MainWorkDependencies } from './dependencies.ts';
import { workReadError, workReadProblems } from './work-reads.ts';

const params = t.Object({ id: readUuid });
const detail: { security: Record<string, string[]>[] } = { security: [{}, { bearerAuth: [] }] };
const headers = { 'cache-control': 'private, no-store' };
const discussionRead = t.Object({ ...discussionPage.properties, complete: t.Boolean() });

export const openApiOperations = {
  '/v1/resources/{resource}/discussion': { get: { exposure: 'public', bearer: false } },
  '/v1/works/{id}/history': { get: { exposure: 'public', bearer: false } },
} as const;

export function workActivityRoutes(work: MainWorkDependencies) {
  return new Elysia()
    .get('/v1/resources/:resource/discussion', { params: t.Object({ resource: readUuid }), detail,
      query: t.Object({ ...pageQuery, realm: t.Optional(readId) }, { additionalProperties: false }),
      response: { 200: discussionRead, ...workReadProblems },
    }, async ({ request, params: path, query }) => {
      try {
        const page = await workRead(work, request, query,
          session => readWorkDiscussion(session, `https://rezics.com/id/${path.resource}`, query.realm));
        return Response.json({ ...page, complete: page.nextCursor === null }, { headers });
      } catch (error) {
        return workReadError(error instanceof ContentLimitExceeded
          ? new WorkReadLimit('Discussion body page exceeds its budget') : error);
      }
    })
    .get('/v1/works/:id/history', { params, detail,
      query: t.Object({ ...pageQuery, kind: t.Optional(historyKind) }, { additionalProperties: false }),
      response: { 200: activityHistoryPage, ...workReadProblems },
    }, async ({ request, params: path, query }) => {
      try {
        return Response.json(await workRead(work, request, query,
          session => readWorkActivityHistory(session, `https://rezics.com/id/${path.id}`, query.kind)), { headers });
      } catch (error) { return workReadError(error); }
    });
}
