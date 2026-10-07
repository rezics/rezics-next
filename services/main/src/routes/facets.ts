import { Elysia } from 'elysia';
import { problemResult } from '../api-contract.ts';
import { facetList } from '../modules/facets/contract.ts';
import { facetListBody, facetListTag } from '../modules/facets/registry.ts';

// Public and the same for every reader: no bearer, no graph read, one body per deploy.
export const openApiOperations = { '/v1/facets': { get: { exposure: 'public', rateLimitFamily: 'read', bearer: false } } } as const;

const headers = { 'cache-control': 'public, max-age=300', etag: facetListTag };

function fresh(request: Request): boolean {
  const tags = request.headers.get('if-none-match');
  return !!tags && tags.split(',').some(tag => [facetListTag, `W/${facetListTag}`, '*'].includes(tag.trim()));
}

/** The admitted Facets (`modules/facets`), so clients keep no tables of filter names. */
export function facetRoutes() {
  return new Elysia().get('/v1/facets', { response: { 200: facetList, 500: problemResult(500) } },
    ({ request }) => fresh(request) ? new Response(null, { status: 304, headers })
      : new Response(facetListBody, { headers: { ...headers, 'content-type': 'application/json' } }));
}
