import type { UiLocale } from '../../i18n/define.ts';
import {
  discoveryApi,
  type ConceptChoice,
  type DiscoverySection,
  type ListPage,
  type ResourceCard,
} from './api.ts';
import { browseQuery, type BrowseState } from './browse-state.ts';
import { browseReader } from './server.ts';
import { readChapterText } from './chapter-text-read.ts';
import type { SearchLoaded } from '../search/types.ts';
import { readBrowse, readBrowseScan, type BrowseResult } from './browse-read.ts';
import { readBrowseSuggestions, type BrowseSuggestions } from './search-recovery-read.ts';
export { readBrowse, type BrowseResult } from './browse-read.ts';

export interface LoadedBrowse {
  state: BrowseState | null;
  topics: ConceptChoice[];
  sections: BrowseResult<DiscoverySection[]> | null;
  results: BrowseResult<ListPage<ResourceCard>> | null;
  chapterText?: SearchLoaded | null;
  checkedPages?: number;
  suggestions?: BrowseSuggestions | null;
  actingSubject?: string;
  signedIn?: boolean;
  avatarQuery?: string;
  locale: UiLocale;
}
export async function loadDiscoverState(
  state: BrowseState | null,
  locale: UiLocale,
): Promise<LoadedBrowse> {
  if (!state) return { state, locale, topics: [], sections: null, results: null };
  const reader = await browseReader();
  const api = discoveryApi(reader.personal, locale, reader.actingSubject);
  const overview =
    state.tab === 'all' &&
    !state.q &&
    !state.conditions.include.length &&
    !state.conditions.exclude.length &&
    !state.includeTypes?.length && !state.excludeTypes?.length && !state.language &&
    state.scope.kind === 'global';
  const [topics, scan, sections, chapterText] = await Promise.all([
    readBrowse(() =>
      api.concepts({
        limit: 8,
        personalization: state.personalized,
        ...(state.scope.kind === 'realm'
          ? { realm: `https://rezics.com/id/${state.scope.realm}` }
          : {}),
      }),
    ),
    state.section ? Promise.resolve(null) : readBrowseScan(cursor => readBrowse(() =>
      api.resources(browseQuery({ ...state, cursor }))), state.cursor),
    overview && (!state.cursor || state.section)
      ? readBrowse(
          async () =>
            (
              await api.sections({
                limit: state.section ? 20 : 6,
                personalization: state.personalized,
                ...(state.section ? { section: state.section } : {}),
                ...(state.cursor ? { cursor: state.cursor } : {}),
              })
            ).items,
        )
      : Promise.resolve(null),
    readChapterText(reader.personal, state, locale),
  ]);
  // A scan window is not a zero-result search. Recovery starts only after the owner exhausts it.
  const suggestions = state.q && scan?.result.ok && scan.result.data.complete && !scan.result.data.items.length
    ? await readBrowseSuggestions(reader.personal, state.q, locale) : null;
  return {
    state,
    locale,
    topics: topics.ok ? topics.data.items : [],
    sections,
    results: scan?.result ?? null,
    checkedPages: scan?.checkedPages,
    suggestions,
    chapterText,
    actingSubject: reader.actingSubject,
    signedIn: reader.signedIn,
    avatarQuery: reader.avatarQuery,
  };
}
