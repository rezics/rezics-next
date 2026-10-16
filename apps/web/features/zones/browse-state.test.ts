import { beforeAll, describe, expect, test } from 'bun:test';
import { seedServedTypes } from '../catalogue/type-fixtures.ts';
import type { SearchParams } from '../discover/scope.ts';
import { zoneContentText } from '../language/untagged.ts';
import { browseHref, chosenCount, cleared, mainBrowseQuery, parseBrowseState } from './browse-state.ts';
import { browseModel, type FacetCounts } from './browse-view.ts';
import { messages } from './messages.ts';
import zhHans from './messages/zh-Hans.ts';

beforeAll(seedServedTypes);

const base = '/s/manga/browse';
const concept = '0192f3a4-5b6c-7d8e-9f01-23456789abcd';
const excluded = '0192f3a4-5b6c-7d8e-9f01-000000000000';
const iri = (id: string) => `https://rezics.com/id/${id}`;
const cursor = 'opaque/+ cursor=%2F==';
const nextCursor = 'next/+ cursor=%3D==';

function params(href: string): SearchParams {
  const query = new URL(href, 'https://browse.invalid').searchParams;
  return Object.fromEntries([...query.keys()].map(key => [key, query.getAll(key)]));
}

const fromHref = (href: string) => parseBrowseState(params(href));
const selected = (year: string) => parseBrowseState({ year, q: 'Lantern title',
  concept, exclude: excluded, type: 'schema:Book', status: 'completed', length: '0-99999',
  sort: 'updated', view: 'grid', cursor });

const facets: FacetCounts = {
  concept: [
    { value: iri(concept), count: 2, name: zoneContentText('Adventure', 'en') },
    { value: iri(excluded), count: 1, name: zoneContentText('Mystery', 'en') },
  ],
  status: [{ value: 'completed', count: 2 }, { value: 'ongoing', count: 1 }],
  length: [{ value: '0-99999', count: 2 }, { value: '100000-299999', count: 1 }],
  type: [{ value: 'https://schema.org/Book', count: 2 }],
};

function modelFor(state: ReturnType<typeof parseBrowseState>, continuation = nextCursor) {
  return browseModel({ base, zoneName: 'Manga', state, locale: 'en', messages, admitted: new Map(),
    page: { items: [], facets, matches: { value: 2, kind: 'exact' },
      window: { scanned: 2, complete: true }, tags: 'current', nextCursor: continuation, sort: state.sort ?? 'newest' } });
}

describe('publication year in shared browse state', () => {
  test.each(['1', '1995', '9999', '1-9999', '1995-2001', '1995-1995'])(
    '%s round-trips unchanged through the address and API query', year => {
      const state = selected(year);
      expect(state.publicationYear).toBe(year);
      expect(mainBrowseQuery(state)).toEqual({ publicationYear: year, q: 'Lantern title', sort: 'updated',
        cursor, concept: [iri(concept)], excludeConcept: [iri(excluded)],
        type: ['https://schema.org/Book'], status: ['completed'], length: '0-99999' });
      const href = browseHref(base, state);
      expect(params(href).year).toEqual([year]);
      expect(fromHref(href)).toEqual(state);
    },
  );

  test.each(['', '0', '10000', '01995', '1995.5', '-1995', '1995-', '2001-1995',
    '1995-2001-2002', '1995-10000', '1995-02001', ' 1995 '])(
    'drops the unadmitted year %j without losing other Conditions', year => {
      const state = selected(year);
      expect(mainBrowseQuery(state)).not.toHaveProperty('publicationYear');
      expect(new URL(browseHref(base, state), 'https://browse.invalid').searchParams.has('year')).toBe(false);
      expect(state).toEqual(selected(''));
    },
  );

  test('repeated year parameters keep the first exact value like other scalar controls', () => {
    const state = parseBrowseState({ year: ['1995-2001', '2004'] });
    expect(mainBrowseQuery(fromHref(browseHref(base, state)))).toEqual({ publicationYear: '1995-2001' });
  });
});

describe.each(['1995', '1995-2001'])('browse model with year %s', year => {
  test('forwards opaque cursors longer than the former client limit unchanged', () => {
    const token = `opaque:+/%?=&雪${'x'.repeat(4096)}`;
    const state = { ...selected(year), cursor: token };
    expect(fromHref(browseHref(base, state))).toEqual(state);
    expect(mainBrowseQuery(fromHref(browseHref(base, state))).cursor).toBe(token);
    const model = modelFor(state, token);
    expect(model.nextCursor).toBe(token);
    expect(fromHref(model.next!)).toEqual(state);
    expect(fromHref(model.first!)).toEqual({ ...state, cursor: null });
  });

  test('keeps the year and all Conditions on next, first, sort and view links', () => {
    const state = selected(year);
    const model = modelFor(state);
    expect(fromHref(model.next!)).toEqual({ ...state, cursor: nextCursor });
    expect(fromHref(model.first!)).toEqual({ ...state, cursor: null });
    for (const link of model.sorts) {
      expect(fromHref(link.href)).toEqual({ ...state, sort: link.sort, cursor: null });
    }
    for (const link of model.views) {
      expect(fromHref(link.href)).toEqual({ ...state, view: link.view });
    }
  });

  test('keeps the year when including, excluding or removing other Conditions', () => {
    const state = selected(year);
    const model = modelFor(state);
    for (const group of model.groups) for (const value of group.values) {
      const changed = fromHref(value.href);
      expect(mainBrowseQuery(changed)).toMatchObject({ publicationYear: year, q: state.text!, sort: state.sort! });
      expect(changed).toMatchObject({ view: state.view, cursor: null });
      const filter = { ...changed.filter };
      delete filter[group.facet];
      const unchanged = { ...state.filter };
      delete unchanged[group.facet];
      expect(filter).toEqual(unchanged);
      if (value.excludeHref) {
        const excludedState = fromHref(value.excludeHref);
        expect(excludedState).toMatchObject({ publicationYear: year, text: state.text,
          sort: state.sort, view: state.view, cursor: null });
        expect(excludedState.filter.status).toEqual(state.filter.status);
        expect(excludedState.filter.type).toEqual(state.filter.type);
        expect(excludedState.filter.length).toEqual(state.filter.length);
      }
    }
    for (const condition of model.chosen.filter(item => item.key !== 'publicationYear')) {
      const changed = fromHref(condition.href);
      expect(changed.publicationYear).toBe(year);
      expect(changed.cursor).toBeNull();
      expect(chosenCount(changed)).toBe(chosenCount(state) - 1);
    }
  });

  test('search submission retains the year, repeated Conditions and view, restarting continuation', () => {
    const state = parseBrowseState({ ...params(browseHref(base, selected(year))), status: ['completed', 'ongoing'] });
    const model = modelFor(state);
    expect(model.action).toBe(base);
    expect(model.kept.filter(item => item.name === 'year')).toEqual([{ name: 'year', value: year }]);
    const query = new URLSearchParams();
    for (const input of model.kept) query.append(input.name, input.value);
    query.set('q', 'Another title');
    const submitted = fromHref(`${model.action}?${query}`);
    expect(submitted).toEqual({ ...state, text: 'Another title', sort: null, cursor: null });
    expect(mainBrowseQuery(submitted)).toMatchObject({ publicationYear: year, q: 'Another title' });
  });

  test('counts the year and supplies its removal and clear-all through chosen Conditions', () => {
    const state = selected(year);
    const model = modelFor(state);
    expect(chosenCount(state)).toBe(6);
    expect(model.chosen).toHaveLength(6);
    expect(model.filtersLabel).toBe('Filters (6)');
    const condition = model.chosen.find(item => item.key === 'publicationYear')!;
    expect(condition).toMatchObject({ label: year, remove: `Remove filter: ${year}` });
    const removed = fromHref(condition.href);
    const { publicationYear: _year, ...withoutYear } = state;
    expect(removed).toEqual({ ...withoutYear, cursor: null });
    expect(mainBrowseQuery(removed)).not.toHaveProperty('publicationYear');
    expect(chosenCount(removed)).toBe(5);
    const clear = fromHref(model.clearHref!);
    expect(clear).toEqual({ text: state.text, sort: state.sort, view: state.view, filter: {}, cursor: null });
    expect(mainBrowseQuery(clear)).toEqual({ q: state.text!, sort: state.sort! });
    expect(chosenCount(cleared(state))).toBe(0);
    expect(browseHref(base, cleared(state))).toBe(model.clearHref!);
  });

  test('a year alone is removable without adding a facet or a picker', () => {
    const state = parseBrowseState({ year, cursor });
    const model = browseModel({ base, zoneName: 'Manga', state, locale: 'zh-Hans', messages: zhHans,
      admitted: new Map(), page: { items: [], facets: { concept: [], status: [], length: [], type: [] },
        matches: { value: 0, kind: 'exact' }, window: { scanned: 0, complete: true },
        tags: 'current', nextCursor: null, sort: 'newest' } });
    expect(model.groups).toEqual([]);
    expect(model.chosen).toEqual([{ key: 'publicationYear', label: year,
      remove: `移除筛选：${year}`, href: base }]);
    expect(model.clearHref).toBe(base);
    expect(modelFor(fromHref(model.clearHref!)).clearHref).toBeNull();
  });
});
