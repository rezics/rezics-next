import { problemCode } from './refinement/request';
import { searchFilterWithScope } from './advanced-scope';
import type { DiscoveryRequest } from './discovery';
import type { SearchLoaderDeps } from './search-params';

export type SearchRequestPage = { sort?: string; cursor?: string; kindCursor?: string };
export type SearchResponsePage = { status: number; error?: unknown };

/** Read one result page, restarting exactly once when a native generation or Top rated cursor is no longer compatible. */
export async function readSearchPage<Response extends SearchResponsePage, Request extends SearchRequestPage>(
  request: Request,
  send: (request: Request | Omit<Request, 'cursor' | 'kindCursor'>) => Promise<Response>,
): Promise<{ response: Response; restarted: boolean }> {
  const response = await send(request);
  if (
    response.status !== 409 ||
    (!request.kindCursor && !request.cursor) ||
    (!request.kindCursor && request.sort !== 'rating' && problemCode(response.error) !== 'search_restart_required')
  )
    return { response, restarted: false };
  const { cursor: _cursor, kindCursor: _kindCursor, ...firstPage } = request;
  return { response: await send(firstPage), restarted: true };
}

/** Preserve every submitted predicate. Native admission owns unsupported fields and kinds. */
export function discoveryRequest(params: SearchLoaderDeps, languages: string[]): DiscoveryRequest {
  const clauses: unknown[] = [];
  if (params.condition) clauses.push(params.condition);
  const filter = searchFilterWithScope(params.filter, params.resourceScope);
  if (filter !== undefined) clauses.push(JSON.parse(filter));
  if (params.type) clauses.push({ type: { in: [params.type] } });
  for (const [property, values] of Object.entries(params.facets))
    if (values.length)
      clauses.push(property === 'type' ? { type: { in: values } } : { statement: { property, in: values } });
  for (const [property, range] of Object.entries(params.ranges ?? {})) clauses.push({ statement: { property, range } });
  const kindCountLeaf = params.kinds?.length ? clauses.length : undefined;
  if (params.kinds?.length) clauses.push({ kind: { in: params.kinds } });
  return {
    representation: 'discovery-v1',
    limit: 100,
    descriptions: true,
    languages: params.languages ?? languages,
    ...(params.query ? { text: params.query } : {}),
    ...(params.cursor ? { cursor: params.cursor } : {}),
    ...(params.sort ? { sort: params.sort } : {}),
    ...(clauses.length ? { filter: { and: clauses } } : {}),
    ...(kindCountLeaf !== undefined && !params.cursor ? { kindCountLeaf } : {}),
    kindPage: { limit: 8 },
  };
}
