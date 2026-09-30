import { beforeAll, describe, expect, test } from 'bun:test';
import type { ZoneWork } from '@rezics/zone-sdk';
import { browseHref, chipHref, cleared, mainBrowseQuery, parseBrowseState, toggled }
  from '../features/zones/browse-state.ts';
import { browseEntry, browseModel, type FacetCounts } from '../features/zones/browse-view.ts';
import { messages } from '../features/zones/messages.ts';
import zhHans from '../features/zones/messages/zh-Hans.ts';
import { seedServedTypes } from '../features/catalogue/type-fixtures.ts';

beforeAll(seedServedTypes);

const base = '/en/r/mods/browse';
const concept = '0192f3a4-5b6c-7d8e-9f01-23456789abcd';
const conceptIri = `https://rezics.com/id/${concept}`;

describe('Browse state in the URL', () => {
  test('reads short, readable Conditions and drops values Main would not admit', () => {
    const state = parseBrowseState({ q: '  lanterns ', loader: ['fabric', 'Quilt'], version: '1.21.1',
      env: ['client', 'both'], requires: 'fabric-api', concept: [concept, 'not-a-uuid'],
      type: ['rv:ModPackage', 'evil:Thing'], status: 'ongoing', length: ['100000-299999', '0-99999'],
      sort: 'relevance', view: 'grid', cursor: 'abc' });
    expect(state).toEqual({ text: 'lanterns', sort: 'relevance', view: 'grid', cursor: 'abc', filter: {
      concept: [conceptIri], status: ['ongoing'], length: ['100000-299999'],
      type: ['https://rezics.com/vocab/ModPackage'] } });
    // Relevance needs text; without it the page takes Main's default order.
    expect(parseBrowseState({ sort: 'relevance' }).sort).toBeNull();
    expect(parseBrowseState({ sort: 'downloads' }).sort).toBeNull();
    // Old mod parameters open the page, only wider.
    expect(parseBrowseState({ loader: 'fabric', version: '1.21.1', env: 'client' }).filter).toEqual({});
  });

  test('a state and its link round-trip, and Main receives its own names and values', () => {
    const state = parseBrowseState({ status: 'ongoing', concept, q: 'lumen', sort: 'updated' });
    const href = browseHref(base, state);
    expect(href).toBe(`${base}?q=lumen&concept=${concept}&status=ongoing&sort=updated`);
    expect(parseBrowseState(Object.fromEntries([...new URL(href, 'https://x').searchParams.keys()].map(key =>
      [key, new URL(href, 'https://x').searchParams.getAll(key)])))).toEqual(state);
    expect(mainBrowseQuery(state)).toEqual({ q: 'lumen', sort: 'updated', concept: [conceptIri],
      status: ['ongoing'] });
  });

  test('choosing a length band replaces it; choosing a status adds it; paging restarts', () => {
    const state = { ...parseBrowseState({ status: 'ongoing', length: '0-99999' }), cursor: 'page-2' };
    expect(toggled(state, 'length', '1000000-').filter.length).toEqual(['1000000-']);
    expect(toggled(state, 'status', 'completed').filter.status).toEqual(['ongoing', 'completed']);
    expect(toggled(state, 'status', 'ongoing').filter.status).toBeUndefined();
    expect(toggled(state, 'status', 'completed').cursor).toBeNull();
    expect(cleared(state)).toMatchObject({ filter: {}, cursor: null });
    expect(chipHref(base, 'status', 'ongoing')).toBe(`${base}?status=ongoing`);
    expect(chipHref(base, 'length', '0-99999')).toBe(`${base}?length=0-99999`);
  });

  test('excluded Concepts round-trip independently of included Concepts and clear together', () => {
    const state = parseBrowseState({ concept, exclude: '0192f3a4-5b6c-7d8e-9f01-000000000000' });
    expect(state.excludedConcepts).toEqual(['https://rezics.com/id/0192f3a4-5b6c-7d8e-9f01-000000000000']);
    expect(mainBrowseQuery(state)).toMatchObject({ concept: [conceptIri],
      excludeConcept: state.excludedConcepts });
    expect(browseHref(base, state)).toContain('&exclude=0192f3a4-5b6c-7d8e-9f01-000000000000');
    expect(cleared(state).excludedConcepts).toEqual([]);
  });
});

const work = (id: string): ZoneWork => ({ id: `https://rezics.com/id/${id}`, href: `/w/${id}`,
  title: { value: id, lang: 'en', dir: 'ltr' }, cover: null, kind: 'package', author: null,
  tagline: null, status: null, chapters: null, words: null, updatedAt: null, decision: null });
const otherConcept = 'https://rezics.com/id/0192f3a4-5b6c-7d8e-9f01-000000000000';
const counts = (overrides: Partial<FacetCounts> = {}): FacetCounts => ({
  concept: [{ value: conceptIri, count: 2, name: { value: 'Cozy', lang: 'en', dir: 'ltr' } },
    { value: otherConcept, count: 1, name: { value: 'Mystery', lang: 'en', dir: 'ltr' } }],
  status: [{ value: 'ongoing', count: 3 }, { value: 'completed', count: 2 }],
  length: [{ value: '0-99999', count: 4 }, { value: '100000-299999', count: 1 }],
  type: [{ value: 'https://rezics.com/vocab/ModPackage', count: 4 },
    { value: 'https://schema.org/DigitalDocument', count: 3 }], ...overrides });
const page = (state = parseBrowseState({})) => ({ items: [work('a'), work('b')], facets: counts(),
  matches: { value: 2, kind: 'exact' as const }, window: { scanned: 7, complete: true }, tags: 'current' as const,
  nextCursor: 'next', sort: state.sort ?? 'newest' as const });

describe('Browse page model', () => {
  test('lists each Facet that can narrow the results, named in the reader’s words', () => {
    const state = parseBrowseState({ status: 'ongoing' });
    const model = browseModel({ base, zoneName: 'Mods', state, page: page(state),
      admitted: new Map([['type', 'Type'], ['concept', 'Tags']]), locale: 'en', messages });
    expect(model.groups.map(group => [group.facet, group.label, group.values.map(value => value.label.value)]))
      .toEqual([['concept', 'Tags', ['Cozy', 'Mystery']],
        ['status', 'Status', ['Ongoing', 'Completed']],
        ['length', 'Length', ['Under 100k words', '100k–300k words']],
        ['type', 'Type', ['Mod', 'Guide']]]);
    expect(model.groups[1]!.values[0]).toMatchObject({ chosen: true, href: base });
    expect(model.chosen).toEqual([{ key: 'status:ongoing', label: 'Ongoing', remove: 'Remove filter: Ongoing',
      href: base }]);
    expect([model.filtersLabel, model.results, model.clearHref]).toEqual(['Filters (1)', '2 results', base]);
    expect(model.sorts.map(sort => [sort.label, sort.current])).toEqual([['Newest', true], ['Recently updated', false]]);
    expect(model.kept).toEqual([{ name: 'status', value: 'ongoing' }]);
    expect(model.next).toBe(`${base}?status=ongoing&cursor=next`);
    expect(model.notes).toEqual([]);
  });

  test('says when filters looked through only the newest picks, and when Tags are catching up', () => {
    const state = parseBrowseState({ concept, q: 'm' });
    const model = browseModel({ base, zoneName: 'Mods', state, admitted: new Map(), locale: 'zh-Hans',
      messages: { ...messages, ...zhHans }, page: { ...page(state), items: [work('c')], tags: 'stale',
        matches: { value: 60, kind: 'lower-bound' }, window: { scanned: 60, complete: false } } });
    expect(model.notes).toEqual(['筛选范围是本社区最新收录的 60 部作品。', '标签正在同步最新变化，请稍后再试。']);
    expect(model.results).toBe('至少 60 个结果');
    expect(model.sorts.map(sort => sort.sort)).toEqual(['relevance', 'newest', 'updated']);
  });

  test('an excluded Concept has a visible removable chip and its own action', () => {
    const state = parseBrowseState({ exclude: concept });
    const model = browseModel({ base, zoneName: 'Mods', state, page: page(state),
      admitted: new Map(), locale: 'en', messages });
    expect(model.chosen).toEqual([{ key: `exclude:${conceptIri}`, label: 'Exclude: Cozy',
      remove: 'Remove exclusion: Cozy', href: base }]);
    const value = model.groups.find(group => group.facet === 'concept')!.values[0]!;
    expect(value).toMatchObject({ excluded: true, excludeHref: base });
    expect(value.href).toContain(`concept=${concept}`);
  });
});

describe('Browse entry on the home', () => {
  test('offers status and length as one-filter links, with their counts', () => {
    const entry = browseEntry({ base, zoneName: 'Mods', locale: 'en', messages, counts: counts() });
    expect(entry).toMatchObject({ href: base, searchLabel: 'Search Mods', placeholder: 'Search Mods…', kept: [] });
    expect(entry.groups.map(group => [group.facet, group.chips.map(chip => [chip.label.value, chip.count, chip.href])]))
      .toEqual([['status', [['Ongoing', 3, `${base}?status=ongoing`], ['Completed', 2, `${base}?status=completed`]]],
        ['length', [['Under 100k words', 4, `${base}?length=0-99999`],
          ['100k–300k words', 1, `${base}?length=100000-299999`]]]]);
    expect(browseEntry({ base, zoneName: 'Mods', locale: 'en', messages, counts: null }).groups).toEqual([]);
  });
});
