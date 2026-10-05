import { readSearchPage } from '../search/read.ts';
import type { SearchLoaded } from '../search/types.ts';
import type { BrowseState } from './browse-state.ts';
import type { MainClient } from './types.ts';
import { phraseStatus } from '../search/state.ts';

/** One independent first page of Work phrase matches; resource cursors and counts never enter this read. */
export async function readChapterText(main: MainClient, state: BrowseState, locale: string): Promise<SearchLoaded | null> {
  if (!state.q || phraseStatus(state.q) !== 'ok') return null;
  return readSearchPage({ search: main, names: main }, {
    phrase: state.q, scope: state.scope, language: state.language ?? null, term: null,
    concepts: state.conditions, includeTypes: state.includeTypes, excludeTypes: state.excludeTypes,
  }, { language: locale });
}
