import { beforeEach, describe, expect, test } from 'bun:test';
import { seedServedTypes } from '../features/catalogue/type-fixtures.ts';
import { countBookChapters } from '../features/studio/counts.ts';
import { agents, ids, inventory, position } from '../features/studio/fixtures.ts';
import { readInventory } from '../features/studio/read.ts';
import { inventoryAddress, inventoryQuery, type ContentsItem, type ContentsPage, type MainClient }
  from '../features/studio/types.ts';

beforeEach(seedServedTypes);

const chapter = (occurrence: string, available = true): ContentsItem => ({ occurrence, parent: 'root',
  role: 'chapter', division: null, label: null, number: null, childCount: null,
  target: available ? `${occurrence}/target` : null, selectedRevision: null, progress: null,
  availability: available ? 'available' : 'unavailable' });
const group = (occurrence: string, division: 'volume' | 'part' | 'extras'): ContentsItem =>
  ({ ...chapter(occurrence), role: 'group', division, childCount: 2 });
const page = (items: ContentsItem[], nextCursor: string | null = null): ContentsPage => ({
  profile: 'work-contents-v1', work: ids.serial, version: 'version', composition: 'root',
  compositionRevision: 'head', language: 'zh-Hans', items, nextCursor, sourcePosition: position,
  count: { kind: 'exact-page', value: items.length, total: null },
}) as ContentsPage;

describe('Studio chapter totals', () => {
  test('counts top-level, volume, nested part and extras chapters, following every parent cursor', async () => {
    const calls: Array<[string | undefined, string | undefined]> = [];
    const levels = new Map([
      ['root:top-next', page([group('extras', 'extras'), chapter('last')])],
      ['volume:', page([chapter('one'), group('part', 'part')], 'volume-next')],
      ['volume:volume-next', page([chapter('two', false)])],
      ['part:', page([chapter('three')])],
      ['extras:', page([chapter('bonus')])],
    ]);
    const result = await countBookChapters(page([chapter('opening'), group('volume', 'volume')], 'top-next'),
      async (parent, cursor) => {
        calls.push([parent, cursor]);
        return { ok: true, data: levels.get(`${parent ?? 'root'}:${cursor ?? ''}`)! };
      });
    expect(result).toEqual({ count: 6, published: 5, more: false });
    expect(calls).toEqual(expect.arrayContaining([[undefined, 'top-next'], ['volume', undefined],
      ['volume', 'volume-next'], ['part', undefined], ['extras', undefined]]));
  });

  test('a groups-only first page does not establish an empty book when its child read fails', async () => {
    expect(await countBookChapters(page([group('volume', 'volume')]), async () =>
      ({ ok: false, failure: 'unavailable' }))).toEqual({ count: 0, published: 0, more: true });
    expect(await countBookChapters(page([]), async () => { throw new Error('nothing to read'); }))
      .toEqual({ count: 0, published: 0, more: false });
  });

  test('more than a hundred chapters are counted across pages without treating a page size as a total', async () => {
    const all = Array.from({ length: 125 }, (_, index) => chapter(`chapter-${index}`, index % 2 === 0));
    expect(await countBookChapters(page(all.slice(0, 20), '20'), async (_parent, cursor) => {
      const start = Number(cursor);
      return { ok: true, data: page(all.slice(start, start + 20), start + 20 < all.length ? `${start + 20}` : null) };
    })).toEqual({ count: 125, published: 63, more: false });
  });

  test('budgets, unavailable continuations, overlapping pages, loops and changed compositions retain a lower bound', async () => {
    const first = page([chapter('one')], 'next');
    expect(await countBookChapters(first, async () => ({ ok: true, data: page([chapter('two')]) }), 1))
      .toEqual({ count: 1, published: 1, more: true });
    expect(await countBookChapters(first, async () => ({ ok: false, failure: 'denied' })))
      .toEqual({ count: 1, published: 1, more: true });
    expect(await countBookChapters(first, async () => ({ ok: true, data: page([chapter('one')]) })))
      .toEqual({ count: 1, published: 1, more: true });
    expect(await countBookChapters(first, async () => ({ ok: true, data: page([chapter('two')], 'next') })))
      .toEqual({ count: 2, published: 2, more: true });
    expect(await countBookChapters(first, async () => ({ ok: true,
      data: { ...page([chapter('two')]), compositionRevision: 'changed' } })))
      .toEqual({ count: 1, published: 1, more: true });
  });
});

describe('Studio inventory owner reads and addresses', () => {
  test('title search and order reach Main, and continuations preserve its ordering beyond a hundred works', async () => {
    const source = Array.from({ length: 105 }, (_, index) => ({ ...inventory.page.items[1]!,
      id: `work-${index}`, title: { value: `Archive ${index}`, language: 'en' } })).reverse();
    const queries: unknown[] = [];
    const main = { v1: { me: { agents: ({ agent }: { agent: string }) => {
      expect(agent).toBe(agents[0]!.iri.slice(-36));
      return { works: { get: async ({ query }: { query: { q: string; sort: string; cursor?: string; limit: number } }) => {
        queries.push(query);
        expect(query.q).toBe('Archive');
        expect(query.sort).toBe('oldest');
        const start = Number(query.cursor ?? 0);
        return { error: null, data: { ...inventory.page, items: source.slice(start, start + query.limit),
          nextCursor: start + query.limit < source.length ? `${start + query.limit}` : null } };
      } } };
    } } } } as unknown as MainClient;
    const found: string[] = [];
    let cursor: string | undefined;
    do {
      const result = await readInventory(agents[0]!.iri, { q: 'Archive', sort: 'oldest', state: 'draft' }, cursor, main);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('inventory unavailable');
      found.push(...result.data.page.items.map(item => item.id));
      cursor = result.data.page.nextCursor ?? undefined;
    } while (cursor);
    expect(found).toEqual(source.map(item => item.id));
    expect(new Set(found).size).toBe(105);
    expect(queries).toHaveLength(6);
  });

  test('inventory counts use the same Agent, language and Version on nested owner reads', async () => {
    const queries: Array<Record<string, unknown>> = [];
    const main = { v1: {
      me: { agents: () => ({ works: { get: async () => ({ error: null, data: {
        ...inventory.page, items: [inventory.page.items[0]!] } }) } }) },
      works: () => ({ contents: { get: async ({ query }: { query: Record<string, unknown> }) => {
        queries.push(query);
        const data = query.parent ? page([chapter('private-draft', false), chapter('published')])
          : query.language ? page([group('volume', 'volume')]) : { ...page([]), language: null };
        return { error: null, data };
      } } }),
    } } as unknown as MainClient;
    const result = await readInventory(agents[0]!.iri, {}, undefined, main);
    expect(result.ok && result.data.books[ids.serial]).toEqual({ count: 2, published: 1, more: false });
    expect(queries).toHaveLength(3);
    expect(queries[1]).toMatchObject({ actingSubject: agents[0]!.iri, language: 'zh-Hans' });
    expect(queries[2]).toMatchObject({ actingSubject: agents[0]!.iri, language: 'zh-Hans', parent: 'volume', version: 'version' });
  });

  test('a failed contents read is unknown, while a failed inventory remains a refusal', async () => {
    let inventoryFails = false;
    const main = { v1: {
      me: { agents: () => ({ works: { get: async () => inventoryFails
        ? { data: null, error: { status: 403 } }
        : { error: null, data: { ...inventory.page, items: [inventory.page.items[0]!] } } } }) },
      works: () => ({ contents: { get: async () => ({ data: null, error: { status: 503 } }) } }),
    } } as unknown as MainClient;
    const result = await readInventory(agents[0]!.iri, {}, undefined, main);
    expect(result.ok && result.data.books).toEqual({});
    inventoryFails = true;
    expect(await readInventory(agents[0]!.iri, {}, undefined, main)).toMatchObject({ ok: false, failure: 'denied' });
  });

  test('title, order and state survive continuation, first-page links and a return address; changing conditions drops the cursor', () => {
    const query = inventoryQuery({ q: '  雨 & Tides  ', sort: 'oldest' });
    const base = '/studio/@lin_mei';
    const more = new URL(inventoryAddress(base, 'draft', query, 'opaque/+?'), 'https://rezics.test');
    expect([...more.searchParams]).toEqual([['view', 'draft'], ['q', '雨 & Tides'], ['sort', 'oldest'], ['cursor', 'opaque/+?']]);
    expect(inventoryQuery(Object.fromEntries(more.searchParams))).toEqual(query);
    expect(new URL(inventoryAddress(base, 'published', query), more).searchParams.has('cursor')).toBe(false);
    expect(inventoryQuery({ q: ['bad'], sort: 'invalid' })).toEqual({ q: '', sort: 'updated' });
  });
});
