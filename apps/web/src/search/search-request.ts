import { problemCode } from './refinement/request';
import { searchFilterWithScope } from './advanced-scope';
import type { DiscoveryRequest } from './discovery';
import type { SearchLoaderDeps } from './search-params';
import type { KernelClient } from '@rezics/client';

type SubjectSearchRequest = Parameters<KernelClient['subjects']['$search']['post']>[0];

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
  const emptyRecoveryActions: NonNullable<DiscoveryRequest['emptyRecoveryActions']> = [];
  const addAction = (action: NonNullable<DiscoveryRequest['emptyRecoveryActions']>[number]) => {
    const strings = Object.values(action).filter((value): value is string => typeof value === 'string');
    if (emptyRecoveryActions.length < 8 && strings.every((value) => [...value].length <= 128))
      emptyRecoveryActions.push(action);
  };
  if (params.query.trim()) addAction({ kind: 'edit-query' });
  if (params.type) addAction({ kind: 'remove-type' });
  for (const value of params.kinds ?? []) addAction({ kind: 'remove-kind', value });
  for (const [property, values] of Object.entries(params.facets))
    for (const value of values) addAction({ kind: 'remove-facet', property, value });
  for (const property of Object.keys(params.ranges ?? {})) addAction({ kind: 'remove-range', property });
  return {
    representation: 'discovery-v1',
    limit: 100,
    descriptions: true,
    languages: params.languages ?? languages,
    ...(params.query ? { text: params.query } : {}),
    ...(params.cursor ? { cursor: params.cursor } : {}),
    ...(params.sort ? { sort: params.sort } : {}),
    ...(clauses.length ? { filter: { and: clauses } } : {}),
    ...(kindCountLeaf !== undefined ? { kindCountLeaf } : {}),
    ...(emptyRecoveryActions.length ? { emptyRecoveryActions } : {}),
    kindPage: { limit: 8 },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sameStrings(value: unknown, expected: readonly string[]): boolean {
  return (
    Array.isArray(value) && value.length === expected.length && value.every((entry, index) => entry === expected[index])
  );
}

/** Native Search evaluates the shared kind selection through its released Subject type predicate. */
function nativeKindFilter(value: unknown, selected: readonly string[]): unknown {
  if (Array.isArray(value)) return value.map((entry) => nativeKindFilter(entry, selected));
  if (!isRecord(value)) return value;
  if (
    Object.keys(value).length === 1 &&
    isRecord(value.kind) &&
    Object.keys(value.kind).length === 1 &&
    sameStrings(value.kind.in, selected)
  )
    return { type: { in: [...selected] } };
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, nativeKindFilter(entry, selected)]));
}

/** Build the native Search request used by a Realm catalogue, without Discovery-only fields. */
export function realmSearchRequest(params: SearchLoaderDeps, languages: string[]): SubjectSearchRequest {
  const {
    representation: _representation,
    kindPage: _kindPage,
    kindCountLeaf: _kindCountLeaf,
    emptyRecoveryActions: _emptyRecoveryActions,
    ...request
  } = discoveryRequest(params, languages);
  request.limit = 20;
  if (!params.kinds?.length || request.filter === undefined) return request;
  return { ...request, filter: nativeKindFilter(request.filter, params.kinds) as typeof request.filter };
}
