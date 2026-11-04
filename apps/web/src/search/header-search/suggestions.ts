import type { SuggestionResult } from '../suggestions';
import type { SearchScope } from './types';
import { problem } from '../../media/kernel';
import { parseSuggestionPage } from './suggestion-page';
import { parseSearchResourceScope } from '../advanced-scope';

export const HEADER_SUGGESTION_LIMIT = 8;

export type HeaderSuggestionLoader = (
  query: string,
  locale: string,
  signal: AbortSignal,
  scope?: SearchScope,
  fields?: readonly [string, string][],
) => Promise<SuggestionResult>;

/** Keep the browser list bounded even when a test or future producer returns more than the server cap. */
export async function readHeaderSuggestions(
  load: HeaderSuggestionLoader,
  query: string,
  locale: string,
  signal: AbortSignal,
  scope?: SearchScope,
  fields?: readonly [string, string][],
): Promise<SuggestionResult> {
  signal.throwIfAborted();
  const result = await load(query, locale, signal, scope, fields);
  signal.throwIfAborted();
  const page = parseSuggestionPage(result);
  return { ...page, subjects: page.subjects.slice(0, HEADER_SUGGESTION_LIMIT) };
}

function suggestionUrl(
  query: string,
  locale: string,
  fields: readonly [string, string][] | undefined,
  includeFilter: boolean,
): URLSearchParams {
  const params = new URLSearchParams({ q: query, locale });
  const filters = (fields ?? []).filter(([key]) => key === 'filter').map(([, value]) => value);
  if (includeFilter && filters.length > 1) throw problem(400, 'invalid_request', 'Use one complete search filter');
  if (includeFilter && filters.length === 1) params.set('filter', filters[0]!);
  for (const [key, value] of fields ?? []) if (key === 'language') params.append('language', value);
  return params;
}

async function requestSuggestions(signal: AbortSignal, params: URLSearchParams): Promise<SuggestionResult> {
  const response = await fetch(`/api/search/suggestions?${params}`, {
    signal,
    credentials: 'same-origin',
    cache: 'no-store',
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => undefined)) as { code?: unknown } | undefined;
    const failure = problem(
      response.status,
      typeof body?.code === 'string' ? body.code : 'suggestions_failed',
      'Suggestions failed',
    );
    const retryAfter = response.headers.get('retry-after');
    if (retryAfter !== null) throw Object.assign(failure, { headers: { 'retry-after': retryAfter } });
    throw failure;
  }
  return parseSuggestionPage(await response.json());
}

export const loadGlobalHeaderSuggestions: HeaderSuggestionLoader = async (query, locale, signal, scope, fields) => {
  if (scope) throw new Error('Scoped suggestions are unavailable');
  return requestSuggestions(signal, suggestionUrl(query, locale, fields, false));
};

export const loadScopedHeaderSuggestions: HeaderSuggestionLoader = async (query, locale, signal, scope, fields) => {
  if (!scope || !scope.searchAction || (scope.kind !== 'Realm' && scope.kind !== 'Collection'))
    throw problem(503, 'scoped_suggestions_unavailable', 'Scoped suggestions are unavailable');
  const params = suggestionUrl(query, locale, fields, true);
  const filter = params.get('filter');
  const selected = filter === null ? undefined : parseSearchResourceScope(filter).scope;
  if (
    !selected ||
    selected.kind !== (scope.kind === 'Realm' ? 'realm' : 'collection') ||
    selected.id !== scope.id.toLowerCase()
  )
    throw problem(503, 'scoped_suggestions_unavailable', 'Scoped suggestions are unavailable');
  return requestSuggestions(signal, params);
};
