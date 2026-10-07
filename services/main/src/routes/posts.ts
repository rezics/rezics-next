import { Elysia, t } from 'elysia';
import { POST_READ_COST, readPost } from '../modules/post/read.ts';
import { readId, readUuid, readPosition } from '../modules/work/read-contract.ts';
import { workRead } from '../modules/work/read-session.ts';
import type { MainWorkDependencies } from './dependencies.ts';
import { workReadError, workReadProblems } from './work-reads.ts';

const label = t.Object({ value: t.String(), language: t.String() });
const placement = t.Object({ book: readId, occurrence: readId });
export const openApiOperations = { '/v1/posts/{id}': { get: { exposure: 'public', rateLimitFamily: 'read', bearer: true } } } as const;

export function postRoutes(work: MainWorkDependencies) {
  return new Elysia().get('/v1/posts/:id', {
    params: t.Object({ id: readUuid }),
    query: t.Object({ language: t.Optional(t.String({ minLength: 2, maxLength: 35 })),
      actingSubject: t.Optional(readId) }, { additionalProperties: false }),
    response: { 200: t.Object({ profile: t.Literal('post-read-v2'), id: readId,
      spoiler: t.Optional(t.Boolean()),
      revision: readId, publisher: readId, title: label, labels: t.Array(label, { maxItems: 24 }),
      placements: t.Array(placement, { maxItems: POST_READ_COST.placements }), placementsTruncated: t.Boolean(),
      disclosure: t.Union([t.Literal('public'), t.Literal('restricted')]), sourcePosition: readPosition }),
      ...workReadProblems },
  }, async ({ request, params, query }) => {
    try {
      return Response.json(await workRead(work, request, query,
        session => readPost(session, `https://rezics.com/id/${params.id}`)),
      { headers: { 'cache-control': 'private, no-store' } });
    } catch (error) { return workReadError(error); }
  });
}
