import { Elysia, t } from 'elysia';
import { readCollectionGrain } from '../modules/collection/grain.ts';
import { readId, readUuid } from '../modules/work/read-contract.ts';
import { workRead } from '../modules/work/read-session.ts';
import type { MainWorkDependencies } from './dependencies.ts';
import { workReadError, workReadProblems } from './work-reads.ts';

const grain = t.Union([t.Literal('series'), t.Literal('parts')]);
export const openApiOperations = {
  '/v1/collections/{id}/works': { get: { bearer: false } },
} as const;

export function collectionGrainRoutes(work: MainWorkDependencies) {
  return new Elysia().get('/v1/collections/:id/works', {
    params: t.Object({ id: readUuid }),
    detail: { security: [{}, { bearerAuth: [] }] },
    query: t.Object({ actingSubject: t.Optional(readId), grain,
      limit: t.Optional(t.Numeric({ minimum: 1, maximum: 100 })),
      cursor: t.Optional(t.String({ minLength: 1, maxLength: 2048 })) }, { additionalProperties: false }),
    response: { 200: t.Object({ collection: readId, grain, structure: readId, revision: readId,
      order: t.Literal('work-id'), items: t.Array(t.Object({ work: readId, mainVersion: readId }), { maxItems: 100 }),
      nextCursor: t.Nullable(t.String()), sourcePosition: t.Object({ datasetId: t.Literal('product'),
        dataEpoch: t.String(), sequence: t.String() }) }), ...workReadProblems },
  }, async ({ request, params, query }) => {
    try {
      return Response.json(await workRead(work, request, query, session => readCollectionGrain(session,
        `https://rezics.com/id/${params.id}`, { ...query, limit: query.limit ?? 50 })),
      { headers: { 'cache-control': 'private, no-store' } });
    } catch (error) { return workReadError(error); }
  });
}
