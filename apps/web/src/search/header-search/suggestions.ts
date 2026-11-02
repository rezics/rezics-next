import type { SuggestionResult } from '../suggestions';
import type { SearchScope } from './types';
import { problem } from '../../media/kernel';
import { parseSuggestionPage } from './suggestion-page';

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
    { signal, credentials: 'same-origin', cache: 'no-store' },
  );
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
};
