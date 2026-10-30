import type { SuggestionResult } from '../suggestions';
import type { SearchScope } from './types';

export const HEADER_SUGGESTION_LIMIT = 8;

export type HeaderSuggestionLoader = (
  query: string,
  locale: string,
  signal: AbortSignal,
  scope?: SearchScope,
) => Promise<SuggestionResult>;

/** Keep the browser list bounded even when a test or future producer returns more than the server cap. */
export async function readHeaderSuggestions(
  load: HeaderSuggestionLoader,
  query: string,
  locale: string,
  signal: AbortSignal,
  scope?: SearchScope,
): Promise<SuggestionResult> {
  signal.throwIfAborted();
  const result = await load(query, locale, signal, scope);
  signal.throwIfAborted();
  return { ...result, subjects: result.subjects.slice(0, HEADER_SUGGESTION_LIMIT) };
}

export const loadGlobalHeaderSuggestions: HeaderSuggestionLoader = async (query, locale, signal, scope) => {
  if (scope) throw new Error('Scoped suggestions are unavailable');
  const response = await fetch(
    `/api/search/suggestions?q=${encodeURIComponent(query)}&locale=${encodeURIComponent(locale)}`,
    { signal },
  );
  if (!response.ok) throw new Error('Suggestions failed');
  return (await response.json()) as SuggestionResult;
};
