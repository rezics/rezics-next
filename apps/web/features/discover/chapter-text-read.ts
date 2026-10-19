import { readSearchPage } from '../search/read.ts';
import type { SearchHit, SearchLoaded, SearchResultPage } from '../search/types.ts';
import type { BrowseState } from './browse-state.ts';
import type { MainClient } from './types.ts';
import { phraseStatus, type SearchState } from '../search/state.ts';
import { browseCategories } from '../catalogue/registry.ts';
import { registryEntries } from '../catalogue/types.ts';

/**
 * The phrase selection behind Discover's chapter matches. It carries the
 * query, scope, language, type and topic choices but never the resource
 * list's cursor, so the two traversals cannot advance each other.
 */
export function chapterSearchState(state: BrowseState): SearchState | null {
  if (!state.q || phraseStatus(state.q) !== 'ok') return null;
  if (state.tab !== 'all' && !browseCategories().find(category => category.id === state.tab)?.types
    .some(type => registryEntries().some(entry => entry.type === type && entry.base === 'work'))) return null;
  return { phrase: state.q, scope: state.scope, language: state.language ?? null, term: null,
    concepts: state.conditions, includeTypes: state.includeTypes, excludeTypes: state.excludeTypes };
}

/** One independent first page of Work phrase matches; resource cursors and counts never enter this read. */
export async function readChapterText(main: MainClient, state: BrowseState, locale: string): Promise<SearchLoaded | null> {
  const search = chapterSearchState(state);
  return search ? readSearchPage({ search: main, names: main }, search, { language: locale }) : null;
}

/** One reader action follows at most this many phrase pages while they add no chapter match. */
export const CHAPTER_SCAN_PAGES = 4;

export interface ChapterProgress {
  /** Matches inside a chapter, each with its reader destination, in Main's order and without repeats. */
  hits: SearchHit[];
  /** Phrase results examined so far. Main ranks title and name matches before text matches. */
  checked: number;
  total: number;
  /** Main returned no continuation: every phrase result has been examined. */
  complete: boolean;
}

export function chapterProgress(pages: readonly SearchResultPage[]): ChapterProgress {
  const seen = new Set<string>();
  const hits = pages.flatMap(page => page.hits).filter(hit => {
    if (!hit.reasons.chapter || seen.has(hit.matchUnit)) return false;
    seen.add(hit.matchUnit);
    return true;
  });
  return { hits, checked: new Set(pages.flatMap(page => page.hits.map(hit => hit.matchUnit))).size, total: pages[0]?.total ?? 0,
    complete: (pages.at(-1)?.next ?? null) === null };
}
