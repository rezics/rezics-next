import { Elysia, t } from 'elysia';
import type { FilterDocument } from '../../../../model/definitions/filter-document-v1.ts';
import { savedFilterCreate, savedFilterDelete, savedFilterOrder, savedFilterReceipt, savedFiltersPage,
  savedFiltersQuery, savedFilterUpdate } from '../modules/saved-filter/contract.ts';
import { SavedFilterInvalid } from '../modules/saved-filter/admit.ts';
import { homeAvailable } from '../modules/saved-filter/feed.ts';
import { SavedFilterFollowed, SavedFilterMissing, type SavedFilterRow, SavedFilterTabsFull }
  from '../modules/saved-filter/store.ts';
import { QueryRejected } from '../modules/query/compile.ts';
import { readUuid } from '../modules/work/read-contract.ts';
import { workRead, WorkReadUnavailable } from '../modules/work/read-session.ts';
import type { MainWorkDependencies } from './dependencies.ts';
import { homeError, homeHeaders } from './follows.ts';
import { problem } from './problems.ts';
import { workReadProblems } from './work-reads.ts';

export const openApiOperations = {
  '/v1/me/saved-filters': { get: { exposure: 'platform:saved-views', bearer: true }, post: { exposure: 'platform:saved-views', bearer: true, idempotencyKey: true } },
  '/v1/me/saved-filters/order': { put: { exposure: 'platform:saved-views', bearer: true, idempotencyKey: true } },
  '/v1/me/saved-filters/{id}': { patch: { exposure: 'platform:saved-views', bearer: true, idempotencyKey: true },
    delete: { exposure: 'platform:saved-views', bearer: true, idempotencyKey: true } },
} as const;

/** Typed refusals first; everything else is Home's owner error mapping. */
export function savedFilterError(error: unknown): Response {
  if (error instanceof SavedFilterInvalid) return problem(422, error.refusal, error.message, homeHeaders);
  if (error instanceof QueryRejected) {
    return problem(error.refusal.startsWith('stale_') ? 409 : 422, error.refusal, error.message, homeHeaders);
  }
  if (error instanceof SavedFilterMissing) return problem(404, 'saved_filter_unavailable', error.message, homeHeaders);
  if (error instanceof SavedFilterFollowed) return problem(409, 'saved_filter_followed', error.message, homeHeaders);
  if (error instanceof SavedFilterTabsFull) return problem(409, 'home_tabs_full', error.message, homeHeaders);
  return homeError(error);
}

const params = t.Object({ id: readUuid });
const receipt = { 200: savedFilterReceipt, 201: savedFilterReceipt, ...workReadProblems };
const key = (request: Request) => request.headers.get('idempotency-key') ?? '';

/**
 * A reader's Saved Filters: named Filters, the one-Condition filter of each
 * Concept they follow, and which of them are pinned as Home tabs in what order.
 */
export function savedFilterRoutes(work: MainWorkDependencies) {
  const store = () => {
    if (!work.savedFilters) throw new WorkReadUnavailable('Saved Filters are unavailable');
    return work.savedFilters;
  };
  return new Elysia()
    .get('/v1/me/saved-filters', { query: savedFiltersQuery, response: { 200: savedFiltersPage, ...workReadProblems } },
      async ({ request, query }) => {
        try {
          const principal = await work.account.verify(request, ['follow:read']);
          const listed = await store().list(principal, query.actingSubject);
          const concepts = [...new Set(listed.rows.flatMap(row => row.concept ? [row.concept] : []))];
          // Followed Concepts read as their own labels, in the reader's language.
          const names = concepts.length ? await workRead(work, new Request(request.url), { language: query.language },
            session => session.summaries(concepts)) : [];
          const label = (concept: string) => {
            const summary = names.find(item => item.reference === concept);
            return summary?.status === 'available' && summary.type === 'concept' ? summary.name : null;
          };
          const item = (row: SavedFilterRow) => ({ id: row.id, name: row.name, profile: row.profile,
            concept: row.concept ? { id: row.concept, name: label(row.concept) } : null,
            filter: row.document, facets: row.facets, context: row.context, position: row.pin_position,
            home: homeAvailable(row.document as FilterDocument) ? 'available' as const : 'unsupported' as const,
            revision: row.revision });
          return Response.json({ profile: 'saved-filters-v1', revision: listed.revision,
            items: listed.rows.map(item), complete: listed.complete }, { headers: homeHeaders });
        } catch (error) { return savedFilterError(error); }
      })
    .post('/v1/me/saved-filters', { body: savedFilterCreate, response: receipt }, async ({ request, body }) => {
      try {
        const principal = await work.account.verify(request, ['follow:write']);
        const result = await store().create(principal, body, key(request));
        return Response.json(result, { status: result.replayed ? 200 : 201, headers: homeHeaders });
      } catch (error) { return savedFilterError(error); }
    })
    .put('/v1/me/saved-filters/order', { body: savedFilterOrder, response: receipt }, async ({ request, body }) => {
      try {
        const principal = await work.account.verify(request, ['follow:write']);
        return Response.json(await store().reorder(principal, body, key(request)), { headers: homeHeaders });
      } catch (error) { return savedFilterError(error); }
    })
    .patch('/v1/me/saved-filters/:id', { params, body: savedFilterUpdate, response: receipt },
      async ({ request, params: path, body }) => {
        try {
          const principal = await work.account.verify(request, ['follow:write']);
          return Response.json(await store().update(principal, path.id, body, key(request)), { headers: homeHeaders });
        } catch (error) { return savedFilterError(error); }
      })
    .delete('/v1/me/saved-filters/:id', { params, query: savedFilterDelete, response: receipt },
      async ({ request, params: path, query }) => {
        try {
          const principal = await work.account.verify(request, ['follow:write']);
          return Response.json(await store().remove(principal, path.id, query, key(request)), { headers: homeHeaders });
        } catch (error) { return savedFilterError(error); }
      });
}
