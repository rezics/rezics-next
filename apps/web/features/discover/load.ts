import type { UiLocale } from '../../i18n/define.ts';
import {
  discoveryApi,
  BrowseReadError,
  type ConceptChoice,
  type DiscoverySection,
  type ListPage,
  type ResourceCard,
} from './api.ts';
import { browseQuery, type BrowseState } from './browse-state.ts';
import { browseReader } from './server.ts';

export type BrowseResult<T> = { ok: true; data: T } | { ok: false; moved: boolean };
export async function readBrowse<T>(call: () => Promise<T>): Promise<BrowseResult<T>> {
  try {
    return { ok: true, data: await call() };
  } catch (error) {
    return { ok: false, moved: error instanceof BrowseReadError && error.status === 409 };
  }
}
export interface LoadedBrowse {
  state: BrowseState | null;
  topics: ConceptChoice[];
  sections: BrowseResult<DiscoverySection[]> | null;
  results: BrowseResult<ListPage<ResourceCard>> | null;
  actingSubject?: string;
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
  const [topics, results, sections] = await Promise.all([
    readBrowse(() =>
      api.concepts({
        limit: 8,
        personalization: state.personalized,
        ...(state.scope.kind === 'realm'
          ? { realm: `https://rezics.com/id/${state.scope.realm}` }
          : {}),
      }),
    ),
    state.section ? Promise.resolve(null) : readBrowse(() => api.resources(browseQuery(state))),
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
  ]);
  return {
    state,
    locale,
    topics: topics.ok ? topics.data.items : [],
    sections,
    results,
    actingSubject: reader.actingSubject,
    avatarQuery: reader.avatarQuery,
  };
}
