import { nearMatches, suggestionPrefixes, type Suggestion } from '../search/suggest.ts';
import { searchFailureOf, type SearchFailure } from '../search/types.ts';
import { problemCode, type MainClient } from './types.ts';

export type BrowseSuggestions = { ok: true; suggestions: Suggestion[] }
  | { ok: false; failure: SearchFailure };

/** A bounded preview of disclosed alternatives. It never changes the search or claims a filtered match. */
export async function readBrowseSuggestions(main: MainClient, phrase: string, locale: string): Promise<BrowseSuggestions> {
  const pages = await Promise.all(suggestionPrefixes(phrase).map(async prefix => {
    try {
      const { data, error } = await main.v1.search.typeahead.get({ query: { prefix, language: locale } });
      if (error) return { ok: false as const, failure: searchFailureOf(error.status, problemCode(error.value)) };
      return data ? { ok: true as const, data } : { ok: false as const, failure: 'unavailable' as const };
    } catch { return { ok: false as const, failure: 'unavailable' as const }; }
  }));
  const failed = pages.find(page => !page.ok);
  if (failed && !failed.ok) return failed;
  return { ok: true, suggestions: nearMatches(phrase, pages.flatMap(page => page.ok ? page.data.items : [])) };
}
