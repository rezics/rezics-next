import { Elysia } from 'elysia';
import { problemResult } from '../api-contract.ts';
import { typeList } from '../modules/types/contract.ts';
import { typeListBody, typeListTag } from '../modules/types/registry.ts';

export const openApiOperations = { '/v1/types': { get: { bearer: false } } } as const;
const headers = { 'cache-control': 'public, max-age=300', etag: typeListTag };
function fresh(request: Request): boolean {
  const tags = request.headers.get('if-none-match');
  return (
    !!tags &&
    tags.split(',').some((tag) => [typeListTag, `W/${typeListTag}`, '*'].includes(tag.trim()))
  );
}

/** Public, identical for every reader; no per-request registry scan or owner call. */
export function typeRoutes() {
  return new Elysia().get(
    '/v1/types',
    { response: { 200: typeList, 500: problemResult(500) } },
    ({ request }) =>
      fresh(request)
        ? new Response(null, { status: 304, headers })
        : new Response(typeListBody, {
            headers: { ...headers, 'content-type': 'application/json' },
          }),
  );
}
