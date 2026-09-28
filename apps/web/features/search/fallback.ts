import type { UiLocale } from '../../i18n/define.ts';
import type { CatalogueWork } from '../catalogue/work.ts';
import { discoveryWork } from '../discover/cards.ts';
import { readDiscovery, readStandingContext } from '../discover/read.ts';
import { iriOf } from '../discover/scope.ts';
import type { MainClient } from '../discover/types.ts';
import { nearMatches, type Suggestion, suggestionPrefixes, type TypeaheadItem } from './suggest.ts';

/** What a search that found nothing offers instead: close titles or names, and Works readers like. */
export interface SearchFallback { suggestions: Suggestion[]; popular: CatalogueWork[] }

const POPULAR = 10;

async function typeahead(main: MainClient, prefix: string, language: string): Promise<TypeaheadItem[]> {
  try {
    const { data } = await main.v1.search.typeahead.get({ query: { prefix, language } });
    return data?.items ?? [];
  } catch {
    return [];
  }
}

/** Everyone's favorites, or what was added most recently while nothing is rated. */
async function popularWorks(main: MainClient, language: string): Promise<CatalogueWork[]> {
  const context = await readStandingContext(main, { kind: 'global' });
  const ranked = context.ok && context.data ? await readDiscovery(main, { scope: 'global', sort: 'top-rated',
    context: iriOf(context.data), limit: POPULAR, language }) : null;
  const read = ranked?.ok && ranked.data.items.length ? ranked
    : await readDiscovery(main, { scope: 'global', sort: 'recent', limit: POPULAR, language });
  return read.ok ? read.data.items.map(item => discoveryWork(item, { kind: 'global' })) : [];
}

/**
 * Read only when a search found nothing: at most two typeahead reads for
 * near matches and one or two discovery reads for popular Works, all public.
 * Anything Main cannot answer is left out; the empty state stands on its own.
 */
export async function readSearchFallback(main: MainClient, phrase: string, locale: UiLocale): Promise<SearchFallback> {
  const [candidates, popular] = await Promise.all([
    Promise.all(suggestionPrefixes(phrase).map(prefix => typeahead(main, prefix, locale))).then(pages => pages.flat()),
    popularWorks(main, locale).catch(() => []),
  ]);
  return { suggestions: nearMatches(phrase, candidates), popular };
}
