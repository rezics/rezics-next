import { describe, expect, test } from 'bun:test';
import type { ZoneWork } from '@rezics/zone-sdk';
import { browseHref, chipHref, cleared, mainBrowseQuery, modPreference, parseBrowseState, readModPreference, toggled,
  withModPreference }
  from '../features/zones/browse-state.ts';
import { browseEntry, browseModel, type FacetCounts } from '../features/zones/browse-view.ts';
import { messages } from '../features/zones/messages.ts';
import zhHans from '../features/zones/messages/zh-Hans.ts';

const base = '/en/r/mods/browse';
const concept = '0192f3a4-5b6c-7d8e-9f01-23456789abcd';
const conceptIri = `https://rezics.com/id/${concept}`;

describe('Browse state in the URL', () => {
  test('reads short, readable Conditions and drops values Main would not admit', () => {
    const state = parseBrowseState({ q: '  lanterns ', loader: ['fabric', 'Quilt'], version: '1.21.1',
      env: ['client', 'both'], concept: [concept, 'not-a-uuid'], type: ['rv:ModPackage', 'evil:Thing'],
      status: 'ongoing', length: ['100000-299999', '0-99999'], sort: 'relevance', view: 'grid', cursor: 'abc' });
    expect(state).toEqual({ text: 'lanterns', sort: 'relevance', view: 'grid', cursor: 'abc', filter: {
      modLoader: ['Fabric'], modGameVersion: ['1.21.1'], modEnvironment: ['client'], concept: [conceptIri],
      status: ['ongoing'], length: ['100000-299999'], type: ['https://rezics.com/vocab/ModPackage'] } });
    // Relevance needs text; without it the page takes Main's default order.
    expect(parseBrowseState({ sort: 'relevance' }).sort).toBeNull();
    expect(parseBrowseState({ sort: 'downloads' }).sort).toBeNull();
  });

  test('a state and its link round-trip, and Main receives its own names and values', () => {
    const state = parseBrowseState({ loader: 'fabric', version: ['1.21.1', '1.20.1'], concept, q: 'lumen',
      sort: 'updated' });
    const href = browseHref(base, state);
    expect(href).toBe(`${base}?q=lumen&version=1.21.1&version=1.20.1&loader=fabric&concept=${concept}&sort=updated`);
    expect(parseBrowseState(Object.fromEntries([...new URL(href, 'https://x').searchParams.keys()].map(key =>
      [key, new URL(href, 'https://x').searchParams.getAll(key)])))).toEqual(state);
    expect(mainBrowseQuery(state)).toEqual({ q: 'lumen', sort: 'updated', concept: [conceptIri],
      loader: ['Fabric'], gameVersion: ['1.21.1', '1.20.1'] });
  });

  test('choosing an environment axis replaces it, choosing it again removes it; paging restarts', () => {
    const state = { ...parseBrowseState({ loader: 'fabric', length: '0-99999' }), cursor: 'page-2' };
    expect(toggled(state, 'modLoader', 'Forge').filter.modLoader).toEqual(['Forge']);
    expect(toggled(state, 'modLoader', 'Fabric').filter.modLoader).toBeUndefined();
    expect(toggled(state, 'length', '1000000-').filter.length).toEqual(['1000000-']);
    expect(toggled(state, 'status', 'completed').cursor).toBeNull();
    expect(cleared(state)).toMatchObject({ filter: {}, cursor: null });
    expect(chipHref(base, 'modGameVersion', '1.21.1')).toBe(`${base}?version=1.21.1`);
  });

  test('the reader’s environment survives a visit and explicit links replace it', () => {
    const saved = parseBrowseState({ version: '1.20.1', loader: 'forge', env: 'server' }).filter;
    expect(readModPreference(modPreference(saved))).toEqual(saved);
    expect(withModPreference(parseBrowseState({ q: 'lanterns' }), saved, false).filter).toEqual(saved);
    expect(withModPreference(parseBrowseState({ version: '1.21.1', loader: 'fabric' }), saved, true).filter)
      .toEqual({ modGameVersion: ['1.21.1'], modLoader: ['Fabric'] });
    expect(readModPreference('not%a%cookie')).toEqual({});
  });

  test('excluded Concepts round-trip independently of included Concepts and clear together', () => {
    const state = parseBrowseState({ concept, exclude: '0192f3a4-5b6c-7d8e-9f01-000000000000' });
    expect(state.excludedConcepts).toEqual(['https://rezics.com/id/0192f3a4-5b6c-7d8e-9f01-000000000000']);
    expect(mainBrowseQuery(state)).toMatchObject({ concept: [conceptIri],
      excludeConcept: state.excludedConcepts });
    expect(browseHref(base, state)).toContain('&exclude=0192f3a4-5b6c-7d8e-9f01-000000000000');
    expect(cleared(state).excludedConcepts).toEqual([]);
  });

  test('required mod dependencies use the same URL and query value', () => {
    const state = parseBrowseState({ requires: ['fabric-api', 'Invalid ID'] });
    expect(state.filter.modRequiredDependency).toEqual(['fabric-api']);
    expect(mainBrowseQuery(state).requiredDependency).toEqual(['fabric-api']);
    expect(browseHref(base, state)).toBe(`${base}?requires=fabric-api`);
    expect(toggled(state, 'modRequiredDependency', 'forge-config-api').filter.modRequiredDependency)
      .toEqual(['fabric-api', 'forge-config-api']);
  });
});

const work = (id: string, mod = true): ZoneWork => ({ id: `https://rezics.com/id/${id}`, href: `/w/${id}`,
  title: { value: id, lang: 'en', dir: 'ltr' }, cover: null, kind: mod ? 'package' : 'document', author: null,
  tagline: null, status: null, chapters: null, words: null, updatedAt: null, decision: null,
  mod: mod ? { game: 'Minecraft', gameVersions: ['1.21.1'], loaders: ['Fabric'], environment: 'client',
    version: '1.0.0', updatedAt: null } : null });
const counts = (overrides: Partial<FacetCounts> = {}): FacetCounts => ({ modLoader: [{ value: 'Fabric', count: 2 },
  { value: 'Forge', count: 2 }], modGameVersion: [{ value: '1.21.1', count: 4 }],
  modEnvironment: [{ value: 'client', count: 4 }, { value: 'server', count: 2 }],
  modRequiredDependency: [],
  concept: [{ value: conceptIri, count: 2, name: { value: 'Minecraft', lang: 'en', dir: 'ltr' } },
    { value: 'https://rezics.com/id/0192f3a4-5b6c-7d8e-9f01-000000000000', count: 1, name: null }],
  status: [], length: [], type: [{ value: 'https://rezics.com/vocab/ModPackage', count: 4 },
    { value: 'https://schema.org/DigitalDocument', count: 3 }], ...overrides });
const page = (state = parseBrowseState({})) => ({ items: [work('a'), work('b')], facets: counts(),
  matches: { value: 2, kind: 'exact' as const }, window: { scanned: 7, complete: true }, tags: 'current' as const,
  nextCursor: 'next', sort: state.sort ?? 'newest' as const });

describe('Browse page model', () => {
  test('lists each Facet that can narrow the results, named in the reader’s words', () => {
    const state = parseBrowseState({ loader: 'fabric' });
    const model = browseModel({ base, zoneName: 'Mods', state, page: page(state),
      admitted: new Map([['type', 'Type'], ['concept', 'Tags']]), locale: 'en', messages });
    expect(model.groups.map(group => [group.facet, group.label, group.values.map(value => value.label.value)]))
      .toEqual([['modGameVersion', 'Game version', ['1.21.1']],
        ['modLoader', 'Loader', ['Fabric', 'Forge']], ['modEnvironment', 'Side', ['Client', 'Server']],
        // A Concept Main could not name is left out; a Facet with one value cannot narrow anything.
        ['type', 'Type', ['Mod', 'Guide']]]);
    expect(model.groups[1]!.values[0]).toMatchObject({ chosen: true, href: base });
    expect(model.chosen).toEqual([{ key: 'modLoader:Fabric', label: 'Fabric', remove: 'Remove filter: Fabric',
      href: base }]);
    expect([model.filtersLabel, model.results, model.clearHref]).toEqual(['Filters (1)', '2 results', base]);
    expect(model.sorts.map(sort => [sort.label, sort.current])).toEqual([['Newest', true], ['Recently updated', false]]);
    expect(model.kept).toEqual([{ name: 'loader', value: 'fabric' }]);
    expect(model.next).toBe(`${base}?loader=fabric&cursor=next`);
    expect(model.notes).toEqual(['REZICS doesn’t count downloads.']);
  });

  test('says when filters looked through only the newest picks, and when Tags are catching up', () => {
    const state = parseBrowseState({ concept, q: 'm' });
    const model = browseModel({ base, zoneName: 'Mods', state, admitted: new Map(), locale: 'zh-Hans',
      messages: { ...messages, ...zhHans }, page: { ...page(state), items: [work('c', false)], tags: 'stale',
        matches: { value: 60, kind: 'lower-bound' }, window: { scanned: 60, complete: false } } });
    expect(model.notes).toEqual(['筛选范围是本社区最新收录的 60 部作品。', '标签正在同步最新变化，请稍后再试。']);
    expect(model.results).toBe('至少 60 个结果');
    expect(model.sorts.map(sort => sort.sort)).toEqual(['relevance', 'newest', 'updated']);
  });

  test('an excluded Concept has a visible removable chip and its own action', () => {
    const state = parseBrowseState({ exclude: concept });
    const model = browseModel({ base, zoneName: 'Mods', state, page: page(state),
      admitted: new Map(), locale: 'en', messages });
    expect(model.chosen).toEqual([{ key: `exclude:${conceptIri}`, label: 'Exclude: Minecraft',
      remove: 'Remove exclusion: Minecraft', href: base }]);
    const value = model.groups.find(group => group.facet === 'concept')!.values[0]!;
    expect(value).toMatchObject({ excluded: true, excludeHref: base });
    expect(value.href).toContain(`concept=${concept}`);
  });
});

describe('Browse entry on the home', () => {
  test('offers the values Main measures as one-filter links, with their counts', () => {
    const entry = browseEntry({ base, zoneName: 'Mods', locale: 'en', messages,
      counts: counts({ status: [{ value: 'ongoing', count: 3 }, { value: 'completed', count: 0 }] }) });
    expect(entry).toMatchObject({ href: base, searchLabel: 'Search Mods', placeholder: 'Search Mods…' });
    expect(entry.groups.map(group => [group.facet, group.chips.map(chip => [chip.label.value, chip.count, chip.href])]))
      .toEqual([['modGameVersion', [['1.21.1', 4, `${base}?version=1.21.1`]]],
        ['modLoader', [['Fabric', 2, `${base}?loader=fabric`], ['Forge', 2, `${base}?loader=forge`]]],
        ['modEnvironment', [['Client', 4, `${base}?env=client`], ['Server', 2, `${base}?env=server`]]]]);
    expect(browseEntry({ base, zoneName: 'Mods', locale: 'en', messages, counts: null }).groups).toEqual([]);
  });

  test('keeps the saved loader and side while a home chip changes the game version', () => {
    const remembered = parseBrowseState({ version: '1.20.1', loader: 'forge', env: 'client' }).filter;
    const entry = browseEntry({ base, zoneName: 'Mods', locale: 'en', messages, counts: counts(), remembered });
    expect(entry.href).toBe(`${base}?version=1.20.1&loader=forge&env=client`);
    expect(entry.groups[0]!.chips[0]!.href).toBe(`${base}?version=1.21.1&loader=forge&env=client`);
    expect(entry.kept).toEqual([{ name: 'version', value: '1.20.1' }, { name: 'loader', value: 'forge' },
      { name: 'env', value: 'client' }]);
  });
});
