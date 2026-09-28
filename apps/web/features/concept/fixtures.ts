import { works as discoveryWorks } from '../discover/fixtures.ts';
import type { DiscoveryItem } from '../discover/types.ts';
import type { ConceptSearch } from './condition-bar.tsx';
import type { ConceptWorksLoader } from './concept-works.tsx';
import type { ConceptState } from './state.ts';
import type { ConceptFollowState, ConceptRead, ConceptSearchItem, ConceptWorksPage, Facet, Loaded,
  ReadFailure } from './types.ts';

// Story data shaped as Main answers `/v1/concepts/{id}`, its Works and follow state.

export const conceptId = (n: number) => `https://rezics.com/id/${String(n).padStart(8, '0')}-5a1b-4c2d-8e3f-4a5b6c7d8e9f`;
export const conceptUuid = (n: number) => conceptId(n).slice(-36);
const facetRef = 'https://rezics.com/definition/facet-concept-v1';
const position = { dataEpoch: 'story', sequence: '42' };
const name = (value: string, language = 'en') => ({ value, language, direction: 'ltr' as const,
  basis: 'requested' as const });

/** The free Concept Facet as `GET /v1/facets` serves it. */
export const conceptFacet: Facet = { id: facetRef, name: 'concept', version: 1, current: true,
  labels: { en: 'Tags', 'zh-Hant': '標籤', 'zh-Hans': '标签', ja: 'タグ', ko: '태그', de: 'Tags', fr: 'Étiquettes',
    es: 'Etiquetas' },
  appliesTo: 'resource', subject: 'https://schema.org/CreativeWork',
  path: [{ kind: 'triple', predicate: 'https://rezics.com/vocab/mainVersion' }, { kind: 'statement',
    predicate: 'https://rezics.com/vocab/classifiedAs',
    relation: 'https://rezics.com/definition/classification-proposition-v1' }],
  values: [{ kind: 'concept' }], operators: ['any', 'all', 'none'], source: 'context', parameters: [],
  qualifiers: ['interpretation'], occurrence: false, cost: { maxValues: 8, graphReads: 3 }, digest: '0'.repeat(64) };

export const concepts = {
  fantasy: { id: conceptId(1), name: name('Fantasy') },
  magic: { id: conceptId(2), name: name('Magic schools') },
  romance: { id: conceptId(3), name: name('Romance') },
  harem: { id: conceptId(4), name: name('後宮', 'zh-Hans') },
  fiction: { id: conceptId(5), name: name('Fiction') },
  highFantasy: { id: conceptId(6), name: name('High fantasy') },
  urban: { id: conceptId(7), name: name('Urban fantasy') },
  dragons: { id: conceptId(8), name: name('Dragons') },
};

/** Fantasy as Main reads it: a definition, one broader and three narrower Concepts. */
export const fantasy: ConceptRead = { profile: 'concept-v1', id: concepts.fantasy.id, name: concepts.fantasy.name,
  description: name('Stories built on the impossible: magic, invented worlds and the creatures in them.'),
  realm: null, facet: facetRef, interpretations: [conceptId(101)],
  broader: [concepts.fiction], narrower: [concepts.highFantasy, concepts.urban, concepts.magic], moreNarrower: true,
  filter: { all: [{ facet: facetRef, any: [concepts.fantasy.id] }] }, sourcePosition: position };

/** A Concept one community uses, with no definition or neighbours yet. */
export const localConcept: ConceptRead = { ...fantasy, id: conceptId(9), name: name('Estuary cycle'), description: null,
  realm: 'https://rezics.com/id/a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d', broader: [], narrower: [], moreNarrower: false,
  filter: { all: [{ facet: facetRef, any: [conceptId(9)] }] } };

export const localRealm = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';

const tagged = (item: DiscoveryItem, ...tags: (typeof concepts)[keyof typeof concepts][]): DiscoveryItem => ({
  ...item, classifications: tags.map(tag => ({ sense: tag.id, concept: tag.id, decision: tag.id, source: 'global',
    name: tag.name })) });

export const works: DiscoveryItem[] = [
  tagged(discoveryWorks.journey, concepts.fantasy, concepts.dragons),
  tagged(discoveryWorks.frankenstein, concepts.fantasy, concepts.romance),
  tagged(discoveryWorks.fallback, concepts.fantasy, concepts.magic, concepts.dragons),
  tagged(discoveryWorks.chamber, concepts.fantasy, concepts.romance, concepts.harem),
  tagged(discoveryWorks.serial, concepts.fantasy, concepts.urban),
];

/** A Works page for a state: its values named, the page's first. */
export function worksPage(state: ConceptState, items: DiscoveryItem[], more = false,
  extra: Partial<ConceptWorksPage> = {}): ConceptWorksPage {
  const named = Object.values(concepts);
  const value = (uuid: string, operator: 'include' | 'exclude') => {
    const found = named.find(item => item.id.endsWith(uuid));
    return { id: found?.id ?? `https://rezics.com/id/${uuid}`, name: found?.name ?? name(uuid.slice(-8)), operator };
  };
  return { profile: 'concept-works-v1', concept: conceptId(1),
    scope: state.scope.kind === 'realm' ? { kind: 'realm', realm: `https://rezics.com/id/${state.scope.realm}` }
      : { kind: 'global', realm: null }, match: state.match,
    filter: { all: [{ facet: facetRef, any: [conceptId(1)] }] },
    values: [value(state.concept, 'include'), ...state.include.map(id => value(id, 'include')),
      ...state.exclude.map(id => value(id, 'exclude'))],
    generation: '0192e0aa-0000-7000-8000-000000000042', stale: false, projectionPosition: position,
    items, nextCursor: more ? 'story-next' : null, sourcePosition: position,
    count: { value: items.length, kind: 'exact-page', total: null },
    matches: { value: items.length, kind: more ? 'lower-bound' : 'exact' }, ...extra };
}

export const ok = <T>(data: T): Loaded<T> => ({ ok: true, data });
export const failed = <T>(failure: ReadFailure): Loaded<T> => ({ ok: false, failure });

export const state = (extra: Partial<ConceptState> = {}): ConceptState =>
  ({ concept: conceptUuid(1), scope: { kind: 'global' }, include: [], exclude: [], match: 'all', ...extra });

export const follow = (followers: number, following: boolean | null = null): ConceptFollowState => ({
  profile: 'follow-state-v1', target: { id: concepts.fantasy.id, kind: 'concept', name: concepts.fantasy.name,
    icon: { kind: 'fallback', policy: 'avatar-fallback-v1', key: 'concept-1', resourceType: 'concept' }, realm: null,
    href: `/concepts/${conceptUuid(1)}` }, following, revision: following ? '0192e0aa-0000-7000-8000-000000000001' : null,
  followers: { value: followers, kind: 'exact' } });

/** Later pages from memory: one more Work, then the end. */
export const worksLoader = (items: DiscoveryItem[]): ConceptWorksLoader => async (loaded, _locale, cursor) => {
  await new Promise(resolve => setTimeout(resolve, 100));
  return ok(worksPage(loaded, cursor ? items : works, false));
};

/** Concept search from memory, matching labels as Main does: case-folded substrings. */
export const memorySearch: ConceptSearch = async phrase => {
  await new Promise(resolve => setTimeout(resolve, 50));
  return Object.values(concepts).filter(item => item.name.value.toLowerCase().includes(phrase.toLowerCase()))
    .map((item): ConceptSearchItem => ({ concept: item.id, label: item.name.value, language: item.name.language,
      realm: null }));
};
