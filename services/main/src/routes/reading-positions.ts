import { Elysia, t } from 'elysia';
import { readId, readQuery, readUuid } from '../modules/work/read-contract.ts';
import { workRead, decodeReadCursor, encodeReadCursor } from '../modules/work/read-session.ts';
import { readingBoundary, READING_POSITION_COST } from '../modules/reading-position/boundary.ts';
import { normalizePositionQuery } from '../modules/reading-position/store.ts';
import { readingPositionPage } from '../modules/reading-position/contract.ts';
import type { MainWorkDependencies } from './dependencies.ts';
import { workReadError, workReadProblems } from './work-reads.ts';

export const readingPositionQuery = t.Optional(t.Union([readId, t.Literal('all'), t.Literal('mine'), t.Literal('start')]));
export const openApiOperations = { '/v1/reading-positions/{work}': { get: { bearer: false } } } as const;
export function readingPositionsRoutes(work: MainWorkDependencies) {
  return new Elysia().get('/v1/reading-positions/:work', { params: t.Object({ work: readUuid }),
    query: t.Object({ ...readQuery, position: readingPositionQuery,
      q: t.Optional(t.String({ maxLength: READING_POSITION_COST.chooserQueryChars,
        description: 'Analyzed title phrase in any carried language, display label, or one-based sibling number.' })),
      cursor: t.Optional(t.String({ maxLength: 2048 })),
      limit: t.Optional(t.Numeric({ minimum: 1, maximum: READING_POSITION_COST.chooserPage, multipleOf: 1 })) }, { additionalProperties: false }),
    response: { 200: readingPositionPage, ...workReadProblems } }, async ({ request, params, query }: {
      request: Request; params: { work: string }; query: { actingSubject?: string; language?: string;
        languages?: string; position?: string; cursor?: string; limit?: number; q?: string };
    }) => {
    try {
      const result = await workRead(work, request, query, async session => {
        const resource = `https://rezics.com/id/${params.work}`;
        const boundary = readingBoundary(session);
        const q = normalizePositionQuery(query.q);
        const binding = ['reading-position-chooser-v2', resource, session.principal, query.actingSubject, q,
          await boundary.binding()];
        const cursor = decodeReadCursor(query.cursor, binding, session.position);
        const page = await boundary.chooser(resource, query.limit ?? 50, cursor?.after, query.q);
        const nextCursor = page.next ? encodeReadCursor(binding, session.position, page.next) : null;
        return { profile: 'reading-positions-v1', ...page,
          nextCursor, next: nextCursor,
          sourcePosition: session.position,
          count: { value: page.items.length, kind: page.search?.status === 'indexing' ? 'at-least' : 'exact-page', total: null }, cost: READING_POSITION_COST };
      });
      return Response.json(result, { headers: { 'cache-control': 'private, no-store' } });
    } catch (error) { return workReadError(error); }
  });
}
