import type { AnswerRecord, AnswerSample } from '../../../../scripts/api/answer-record.ts';
import books from '../../../../tests/qa/fixtures/outcomes/books/catalogue-browse-and-search-in-its-zone.json';
import visualNovels from '../../../../tests/qa/fixtures/outcomes/visual-novels/catalogue-browse-and-search-in-its-zone.json';
import manga from '../../../../tests/qa/fixtures/outcomes/manga/catalogue-browse-and-search-in-its-zone.json';
import anime from '../../../../tests/qa/fixtures/outcomes/anime/catalogue-browse-and-search-in-its-zone.json';
import type { ZoneBrowsePage } from '../realm/types.ts';
import { direction } from '@rezics/main/language';
import { uuidToSid } from '@rezics/model/address';

export type CatalogueSlug = 'books' | 'visual-novels' | 'anime' | 'manga' | 'games';
export const cataloguePersonas = ['visitor', 'stranger', 'member', 'owner', 'moderator', 'operator'] as const;
export const catalogueRecords: Partial<Record<CatalogueSlug, AnswerRecord>> = {
  books: books as AnswerRecord, 'visual-novels': visualNovels as AnswerRecord, manga: manga as AnswerRecord,
  anime: anime as AnswerRecord,
};
export const catalogueLabels = {
  anime: { populated: 'page-browse-default', continuation: 'page-browse-default-continuation-1',
    search: 'page-search-default', empty: 'page-search-no-match' },
  books: { populated: 'browse-newest-0', continuation: 'browse-newest-continuation',
    search: 'search-relevance-0', empty: 'search-no-match', error: 'unsupported-query-shape' },
  'visual-novels': { populated: 'primary-get-realms-modules-browse-1', continuation: 'primary-get-realms-modules-browse-2',
    search: 'primary-get-realms-modules-browse-5', empty: 'search-no-match', error: 'primary-get-realms-modules-browse-0' },
  manga: { populated: 'page-browse-default', continuation: 'browse-newest-continuation',
    search: 'page-search-relevance', empty: 'page-search-no-match', error: 'unsupported-query-shape' },
} as const;

export const catalogueFixtureId = (index: number) =>
  `https://rezics.com/id/00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
const name = (value: string) => ({ value, language: 'en', direction: direction('en', value), basis: 'requested' as const });

/** Contract fixtures only: these requests have no recorded answer yet. Never represented as captures. */
export function catalogueContractSample(slug: 'anime' | 'games',
  state: 'populated' | 'empty' | 'lagging' | 'error' | 'moved'): AnswerSample {
  const realm = catalogueFixtureId(slug === 'anime' ? 1 : 2);
  const root = `/v1/realms/${realm.split('/').at(-1)}/modules/browse`;
  const type = slug === 'anime' ? 'https://schema.org/TVSeries' : 'https://schema.org/VideoGame';
  const params = new URLSearchParams({ type, sort: 'newest', limit: '5' });
  if (state === 'empty') params.set('q', 'No matching original');
  if (state === 'lagging') params.set('q', 'Newly adopted original');
  if (state === 'moved') params.set('cursor', 'opaque-contract-continuation');
  const complete = state !== 'lagging';
  const items: ZoneBrowsePage['items'] = state === 'populated' ? [{
    id: catalogueFixtureId(3), revision: catalogueFixtureId(4), mainVersion: catalogueFixtureId(5),
    title: name(slug === 'anime' ? 'Lantern Harbour' : 'The Copper Observatory'),
    types: [type], cover: { kind: 'fallback', policy: 'avatar-fallback-v1', resourceType: 'work', key: 'original' },
    tagline: name('An original fixture work, selected by this community.'), completionStatus: 'completed',
    chapterCount: null, wordCount: null, lastUpdatedAt: null,
    primaryCredits: [{ id: catalogueFixtureId(6), role: 'author', participantKind: 'agent',
      provider: null, key: null, ordinal: null, agent: catalogueFixtureId(7), displayName: 'Fixture author',
      handle: null, identityStatus: 'active', address: { prefix: '/a/',
        key: uuidToSid(catalogueFixtureId(7).slice(-36)), suffixSource: '' } }],
    evidence: catalogueFixtureId(8), dataEpoch: 'contract-fixture', sequence: '12', hub: null, inZone: true,
  }] : [];
  const page: ZoneBrowsePage = {
    profile: 'zone-browse-v1', realm,
    query: { text: params.get('q'), sort: 'newest', appliedSort: 'newest',
      textMatch: params.has('q') ? 'title' : 'none', filter: { all: [{ facet: 'type', any: [type] }] } },
    items, facets: { type: [{ value: type, count: items.length }], concept: [],
      status: [{ value: 'completed', count: items.length }], length: [] },
    tags: 'stale', matches: { value: items.length, kind: complete ? 'exact' : 'lower-bound' },
    window: { scanned: items.length, complete }, nextCursor: null,
    sourcePosition: { dataEpoch: 'contract-fixture', sequence: '12' },
    count: { value: items.length, kind: 'exact-page', total: null },
  };
  const status = state === 'error' ? 503 : state === 'moved' ? 409 : 200;
  return { label: state, operationId: 'getV1RealmsByRealmModulesBrowse', method: 'GET', path: `${root}?${params}`,
    status, headers: { 'content-type': 'application/json' },
    answer: status === 200 ? page : { type: 'about:blank', status,
      code: state === 'moved' ? 'read_basis_changed' : 'discovery_unavailable',
      title: state === 'moved' ? 'The read basis changed.' : 'Discovery is unavailable.' } };
}

/** Exact missing requests/states for wave proof; no record is created during build. */
export const missingCatalogueStates = (['anime', 'games'] as const).flatMap(slug =>
  (['populated', 'empty', 'lagging', 'error', 'moved'] as const).map(state => ({
    source: 'contract' as const, slug, state, ...catalogueContractSample(slug, state),
  })));
