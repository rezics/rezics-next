import { Elysia, t } from 'elysia';
import { readId, readQuery, readUuid } from '../modules/work/read-contract.ts';
import { workRead, decodeReadCursor, encodeReadCursor, WorkReadInvalid } from '../modules/work/read-session.ts';
import { readingBoundary, READING_POSITION_COST, type ReadingOccurrence } from '../modules/reading-position/boundary.ts';
import { normalizePositionQuery } from '../modules/reading-position/store.ts';
import { readingPositionPage, readingPositionQuery } from '../modules/reading-position/contract.ts';
import type { MainWorkDependencies } from './dependencies.ts';
import { workReadError, workReadProblems } from './work-reads.ts';
import { ReadingContinuityUnsupported, ReadingResumeUnavailable, ReadingSeekUnavailable } from '../modules/reading-position/errors.ts';
import { problem } from './problems.ts';

export { readingPositionQuery } from '../modules/reading-position/contract.ts';
export const openApiOperations = { '/v1/reading-positions/{work}': { get: { exposure: 'public', rateLimitFamily: 'read', bearer: false } } } as const;
const step = (found: { status: 'found'; item: { occurrence: string } } | { status: 'none' | 'bound' }) =>
  found.status === 'found' ? { status: found.status, occurrence: found.item.occurrence } : { status: found.status };
const itemsOf = (...found: Array<{ status: string; item?: ReadingOccurrence }>) =>
  found.flatMap(entry => entry.item ? [entry.item] : []);

const resolvedPosition = async (boundary: ReturnType<typeof readingBoundary>, work: string) =>
  boundary.selection === 'all' ? 'all' : await boundary.position(work) ?? 'start';

async function chapterLookup(boundary: ReturnType<typeof readingBoundary>, sourcePosition: unknown, work: string,
  lookup: 'around' | 'firstSeen', id: string) {
  const common = { profile: 'reading-positions-v1' as const, work, nextCursor: null, next: null, complete: true,
    sourcePosition, cost: READING_POSITION_COST };
  if (lookup === 'around') {
    const { previous, next, reached } = await boundary.neighbours(work, id);
    const items = itemsOf(previous, next);
    const resolved = await resolvedPosition(boundary, work);
    return { ...common, resolved, scope: 'neighbours' as const, items, visibility: items.length ? 'visible' as const : 'empty' as const,
      neighbours: { previous: step(previous), next: step(next), reached },
      count: { value: items.length, kind: 'exact-page' as const, total: null } };
  }
  const appearance = await boundary.firstAppearance(work, id);
  const items = itemsOf(appearance);
  const resolved = await resolvedPosition(boundary, work);
  return { ...common, resolved, scope: 'first-appearance' as const, items, visibility: items.length ? 'visible' as const : 'empty' as const,
    appearance: step(appearance), count: { value: items.length, kind: 'exact-page' as const, total: null } };
}

export function readingPositionsRoutes(work: MainWorkDependencies) {
  return new Elysia().get('/v1/reading-positions/:work', { params: t.Object({ work: readUuid }),
    query: t.Object({ ...readQuery, position: readingPositionQuery,
      q: t.Optional(t.String({ maxLength: READING_POSITION_COST.chooserQueryChars,
        description: 'Title phrase or display label; Book chapter sibling seek. Accepted episode-number seek reports unavailable until its indexed read is ready. Mine without q reads only the bounded resume scope.' })),
      cursor: t.Optional(t.String({ maxLength: 2048,
        description: 'Continue while nextCursor is present, including empty pages with visibility=pending.' })),
      limit: t.Optional(t.Numeric({ minimum: 1, maximum: READING_POSITION_COST.chooserPage, multipleOf: 1 })),
      around: t.Optional({ ...readId, description: 'Answer the chapters either side of this occurrence, in reading order, instead of a page. Each side is one bounded scan; `bound` means the window ran out, `none` the end of the order. A chapter the reader cannot see answers as one that does not exist. Takes `position` for `reached`, and no paging parameter.' }),
      firstSeen: t.Optional({ ...readId, description: 'Answer the first chapter the reader may see from where this record is revealed in the Work, at the selected position. A record the reader cannot see answers as one that does not exist.' }) }, { additionalProperties: false }),
    response: { 200: readingPositionPage, ...workReadProblems } }, async ({ request, params, query }: {
      request: Request; params: { work: string }; query: { actingSubject?: string; language?: string;
        languages?: string; position?: string; cursor?: string; limit?: number; q?: string; around?: string; firstSeen?: string };
    }) => {
    try {
      const result = await workRead(work, request, query, async session => {
        const resource = `https://rezics.com/id/${params.work}`;
        const boundary = readingBoundary(session);
        if (query.around !== undefined || query.firstSeen !== undefined) {
          const lookup = query.around !== undefined && query.firstSeen === undefined ? 'around'
            : query.firstSeen !== undefined && query.around === undefined ? 'firstSeen' : null;
          if (!lookup || query.cursor !== undefined || query.limit !== undefined || query.q !== undefined) {
            throw new WorkReadInvalid('A chapter lookup takes one of around or firstSeen, and no page parameters');
          }
          return chapterLookup(boundary, session.position, resource, lookup, (query.around ?? query.firstSeen)!);
        }
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
    } catch (error) {
      if (error instanceof ReadingSeekUnavailable) return problem(503, 'reading_seek_unavailable', error.message);
      if (error instanceof ReadingResumeUnavailable) return problem(503, 'reading_resume_index_unavailable', error.message);
      if (error instanceof ReadingContinuityUnsupported) return problem(503, 'reading_continuity_unsupported', error.message);
      return workReadError(error);
    }
  });
}
