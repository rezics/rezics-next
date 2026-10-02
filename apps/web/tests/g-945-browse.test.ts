import { describe, expect, test } from 'bun:test';
import {
  BrowseReadError,
  browseTypes,
  checkedPage,
  discoveryApi,
  type ListPage,
  type ResourceCard,
} from '../features/discover/api.ts';
import {
  browseHref,
  browseQuery,
  browseTabs,
  changeBrowse,
  emptyBrowse,
  parseBrowseState,
} from '../features/discover/browse-state.ts';
import { EntityPickerSource } from '../../../packages/ui/src/components/entity-picker-state.ts';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const iri = (n: number) => `https://rezics.com/id/${id(n)}`;
const params = (href: string) => Object.fromEntries(new URL(href, 'http://test').searchParams);
const page = <T>(items: T[], nextCursor: string | null = null): ListPage<T> => ({
  items,
  nextCursor,
  complete: nextCursor === null,
  count: { value: items.length, kind: nextCursor ? 'at-least' : 'exact' },
});
describe('G-945 one browse', () => {
  test('all seven tabs use one Query; structural types are Facet Conditions', () => {
    for (const tab of browseTabs) {
      const query = browseQuery({ ...emptyBrowse, tab });
      expect(query).toMatchObject({
        profile: 'resource-list-v1',
        context: 'global',
        scope: { kind: 'all' },
        limit: 20,
        sort: 'newest',
      });
      expect(query.filter).toEqual(
        tab === 'all' ? undefined : { all: [{ facet: 'type', any: [browseTypes[tab]] }] },
      );
    }
  });
  test('search, any-of, exclusions, Realm Context and preference survive URL and Query adapters', () => {
    const state = {
      ...emptyBrowse,
      scope: { kind: 'realm' as const, realm: id(9) },
      tab: 'sites' as const,
      q: '宇宙 library',
      personalized: false,
      cursor: 'opaque:second',
      conditions: { include: [id(1), id(2)], exclude: [id(3)], match: 'any' as const },
    };
    expect(parseBrowseState(params(browseHref(state)))).toEqual(state);
    expect(browseQuery(state)).toEqual({
      profile: 'resource-list-v1',
      context: { realm: iri(9) },
      scope: { kind: 'realm', realm: iri(9) },
      sort: 'relevance',
      limit: 20,
      q: '宇宙 library',
      cursor: 'opaque:second',
      filter: {
        all: [
          { facet: 'type', any: [browseTypes.sites] },
          { facet: 'concept', any: [iri(1), iri(2)] },
          { facet: 'concept', none: [iri(3)] },
        ],
      },
    });
  });
  test('exclude-only and all-of Conditions do not require an included topic or a search phrase', () => {
    expect(
      browseQuery({ ...emptyBrowse, conditions: { include: [], exclude: [id(2)], match: 'all' } })
        .filter,
    ).toEqual({ all: [{ facet: 'concept', none: [iri(2)] }] });
    expect(
      browseQuery({
        ...emptyBrowse,
        conditions: { include: [id(1), id(2)], exclude: [], match: 'all' },
      }).filter,
    ).toEqual({ all: [{ facet: 'concept', all: [iri(1), iri(2)] }] });
  });
  test('malformed and old unsupported selectors never widen to All', () => {
    for (const input of [
      { tab: ['works', 'all'] },
      { tab: 'books' },
      { type: 'book' },
      { term: id(1) },
      { context: id(1) },
      { scope: 'mine' },
      { scope: 'realm' },
      { ci: `${id(1)},${id(1)}` },
      { ci: id(1), ce: id(1) },
      { ci: 'bad' },
      { cm: 'none' },
      { cursor: '' },
      { q: 'x'.repeat(81) },
      { q: 'control\u0001' },
      { section: 'sites', tab: 'works' },
      { section: 'sites', ci: id(1) },
      { personalization: 'maybe' },
    ]) {
      expect(parseBrowseState(input)).toBeNull();
    }
  });
  test('changing meaning discards a section cursor, while a continuation preserves full selection', () => {
    const state = { ...emptyBrowse, section: 'popular' as const, cursor: 'section-20' };
    expect(changeBrowse(state, { tab: 'communities' })).toMatchObject({
      section: null,
      cursor: null,
      tab: 'communities',
    });
    const selected = {
      ...emptyBrowse,
      tab: 'topics' as const,
      q: 'stars',
      personalized: false,
      conditions: { include: [id(1)], exclude: [id(2)], match: 'any' as const },
    };
    expect(parseBrowseState(params(browseHref({ ...selected, cursor: '20' })))).toEqual({
      ...selected,
      cursor: '20',
    });
  });
  test('the existing /r redirect selects Communities and preserves its topic without widening', () => {
    const state = parseBrowseState({ type: 'communities', q: 'readers', topic: iri(1) });
    expect(state).toMatchObject({
      tab: 'communities',
      q: 'readers',
      conditions: { include: [id(1)], exclude: [] },
    });
    expect(browseQuery(state!).filter).toEqual({
      all: [
        { facet: 'type', any: [browseTypes.communities] },
        { facet: 'concept', all: [iri(1)] },
      ],
    });
    expect(parseBrowseState({ type: 'communities', tab: 'works' })).toBeNull();
    expect(parseBrowseState({ type: 'communities', topic: 'invalid' })).toBeNull();
    expect(parseBrowseState({ ci: `${id(1)},,${id(2)}` })).toBeNull();
  });
});
describe('G-945 pending served contract', () => {
  test('the client forwards language, actor, cursor and page bounds without multilingual fan-out', async () => {
    const calls: unknown[] = [];
    const main = {
      v1: {
        discovery: {
          concepts: {
            get: async (options: unknown) => {
              calls.push(options);
              return { data: page([]), error: null };
            },
          },
        },
      },
    };
    await discoveryApi(main, 'ja', iri(8)).concepts({ q: '宇宙', cursor: 'next', realm: iri(9) });
    expect(calls).toEqual([
      {
        query: {
          q: '宇宙',
          cursor: 'next',
          scope: 'realm',
          realm: iri(9),
          limit: 20,
          actingSubject: iri(8),
        },
        headers: { 'accept-language': 'ja' },
      },
    ]);
  });
  test('Query results require the new profile; stale cursors remain refusals', async () => {
    const wrong = {
      v1: {
        query: {
          post: async () => ({
            data: { result: { ...page<ResourceCard>([]), profile: 'concept-works-v1' } },
            error: null,
          }),
        },
      },
    };
    await expect(
      discoveryApi(wrong, 'en').resources(browseQuery(emptyBrowse)),
    ).rejects.toBeInstanceOf(BrowseReadError);
    const stale = {
      v1: {
        query: {
          post: async () => ({
            data: null,
            error: { status: 409, value: { code: 'read_basis_changed' } },
          }),
        },
      },
    };
    try {
      await discoveryApi(stale, 'en').resources(browseQuery(emptyBrowse));
      throw new Error('Expected refusal');
    } catch (error) {
      expect(error).toMatchObject({ status: 409, code: 'read_basis_changed' });
    }
  });
  test('rating populations forward the real target and reader identity on every page', async () => {
    let input: unknown;
    const main = {
      v1: {
        'rating-populations': {
          get: async (options: unknown) => {
            input = options;
            return { data: page([]), error: null };
          },
        },
      },
    };
    await discoveryApi(main, 'fr', iri(8)).populations(iri(99), {
      q: 'lecteurs',
      cursor: 'past-20',
    });
    expect(input).toMatchObject({
      query: {
        target: iri(99),
        actingSubject: iri(8),
        q: 'lecteurs',
        cursor: 'past-20',
        limit: 20,
      },
    });
  });
  test('a partial page cannot hide missing or nonprogressing continuation', () => {
    for (const broken of [
      { ...page([]), complete: false },
      { ...page([]), complete: false, nextCursor: 'same' },
      { ...page([]), nextCursor: 'unexpected' },
    ])
      expect(() => checkedPage(broken, 'same')).toThrow(BrowseReadError);
  });
  test('section continuation is taken from the nested page, never the section-list cursor', async () => {
    const item = { id: 'sites', reason: { kind: 'new-sites' }, page: page([], 'next-site') };
    const main = {
      v1: {
        discovery: {
          sections: {
            get: async () => ({
              data: { ...page([item]), personalized: false },
              error: null,
            }),
          },
        },
      },
    };
    const read = await discoveryApi(main, 'en').sections({
      section: 'sites',
      cursor: 'first-site',
    });
    expect(read.nextCursor).toBeNull();
    expect(read.items[0]!.page.nextCursor).toBe('next-site');
  });
});
describe('G-945 traversable remote choices', () => {
  test('more than two thousand choices remain searchable and reachable past the first page', async () => {
    const all = Array.from({ length: 2400 }, (_, n) => ({
      value: id(n + 1),
      label: `Community ${n + 1}`,
    }));
    const source = new EntityPickerSource(async ({ q, cursor }) => {
      const matches = all.filter((item) => item.label.includes(q)),
        offset = Number(cursor ?? 0);
      return {
        items: matches.slice(offset, offset + 20),
        nextCursor: offset + 20 < matches.length ? String(offset + 20) : null,
        complete: offset + 20 >= matches.length,
      };
    });
    await source.search('');
    await source.more();
    expect(source.getSnapshot().items[39]!.label).toBe('Community 40');
    expect(source.getSnapshot().complete).toBe(false);
    await source.search('2400');
    expect(source.getSnapshot()).toMatchObject({
      items: [all[2399]!],
      complete: true,
      nextCursor: null,
    });
  });
  test('a failed continuation preserves prior choices and retries the same cursor', async () => {
    let fail = true;
    const cursors: (string | null)[] = [];
    const source = new EntityPickerSource(async ({ cursor }) => {
      cursors.push(cursor);
      if (cursor && fail) {
        fail = false;
        throw new Error('Unavailable');
      }
      return {
        items: [{ value: cursor ? id(2) : id(1), label: cursor ? 'Second' : 'First' }],
        nextCursor: cursor ? null : 'next',
        complete: Boolean(cursor),
      };
    });
    await source.search('');
    await source.more();
    expect(source.getSnapshot()).toMatchObject({
      items: [{ value: id(1), label: 'First' }],
      error: true,
      nextCursor: 'next',
    });
    await source.retry();
    expect(cursors).toEqual([null, 'next', 'next']);
    expect(source.getSnapshot().items.map((item) => item.label)).toEqual(['First', 'Second']);
  });
});
