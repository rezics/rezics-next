import { Elysia, t } from 'elysia';
import { readId, readQuery, readUuid } from '../modules/work/read-contract.ts';
import { workRead, decodeReadCursor, encodeReadCursor } from '../modules/work/read-session.ts';
import { readingBoundary, READING_POSITION_COST } from '../modules/reading-position/boundary.ts';
import type { MainWorkDependencies } from './dependencies.ts';
import { workReadError, workReadProblems } from './work-reads.ts';

export const readingPositionQuery = t.Optional(t.Union([readId, t.Literal('all'), t.Literal('mine'), t.Literal('start')]));
export const openApiOperations = { '/v1/reading-positions/{work}': { get: { bearer: false } } } as const;
export function readingPositionsRoutes(work: MainWorkDependencies) {
  return new Elysia().get('/v1/reading-positions/:work', { params: t.Object({ work: readUuid }),
    query: t.Object({ ...readQuery, position: readingPositionQuery,
      cursor: t.Optional(t.String({ maxLength: 2048 })),
      limit: t.Optional(t.Numeric({ minimum: 1, maximum: READING_POSITION_COST.chooserPage })) }, { additionalProperties: false }),
    response: { 200: t.Any(), ...workReadProblems } }, async ({ request, params, query }: {
      request: Request; params: { work: string }; query: { actingSubject?: string; language?: string;
        languages?: string; position?: string; cursor?: string; limit?: number };
    }) => {
    try {
      const result = await workRead(work, request, query, async session => {
        const resource = `https://rezics.com/id/${params.work}`;
        const boundary = readingBoundary(session);
        const binding = ['reading-position-chooser-v1', resource, session.principal, query.actingSubject,
          await boundary.binding()];
        const cursor = decodeReadCursor(query.cursor, binding, session.position);
        const page = await boundary.chooser(resource, query.limit ?? 50, cursor?.after);
        return { profile: 'reading-positions-v1', ...page,
          next: page.next ? encodeReadCursor(binding, session.position, page.next) : null,
          sourcePosition: session.position,
          count: { value: page.items.length, kind: 'exact-page', total: null }, cost: READING_POSITION_COST };
      });
      return Response.json(result, { headers: { 'cache-control': 'private, no-store' } });
    } catch (error) { return workReadError(error); }
  });
}
