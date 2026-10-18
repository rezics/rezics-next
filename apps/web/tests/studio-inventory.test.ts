import { beforeEach, describe, expect, test } from 'bun:test';
import { seedServedTypes } from '../features/catalogue/type-fixtures.ts';
import { agents, ids, inventory } from '../features/studio/fixtures.ts';
import { readInventory } from '../features/studio/read.ts';
import { inventoryAddress, inventoryQuery, type MainClient }
  from '../features/studio/types.ts';

beforeEach(seedServedTypes);

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
        expect(query.sort).toBe('title');
        const start = Number(query.cursor ?? 0);
        return { error: null, data: { ...inventory.page, items: source.slice(start, start + query.limit),
          nextCursor: start + query.limit < source.length ? `${start + query.limit}` : null } };
      } } };
    } } } } as unknown as MainClient;
    const found: string[] = [];
    let cursor: string | undefined;
    do {
      const result = await readInventory(agents[0]!.iri, { q: 'Archive', sort: 'title', state: 'draft' }, cursor, main);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('inventory unavailable');
      found.push(...result.data.page.items.map(item => item.id));
      cursor = result.data.page.nextCursor ?? undefined;
    } while (cursor);
    expect(found).toEqual(source.map(item => item.id));
    expect(new Set(found).size).toBe(105);
    expect(queries).toHaveLength(6);
  });

  test('consumes the owner count and completeness without reading contents or author-only chapter facts', async () => {
    for (const chapterCount of [{ value: 23, complete: true }, { value: 4, complete: false },
      { value: 0, complete: false }, { value: 0, complete: true }]) {
      const main = { v1: { me: { agents: () => ({ works: { get: async () => ({ error: null,
        data: { ...inventory.page, items: [{ ...inventory.page.items[0]!, chapterCount }] } }) } }) } } } as unknown as MainClient;
      const result = await readInventory(agents[0]!.iri, {}, undefined, main);
      expect(result.ok && result.data.page.items[0]!.chapterCount).toEqual(chapterCount);
    }
  });

  test('a failed inventory remains a refusal and never becomes a definite zero count', async () => {
    const main = { v1: { me: { agents: () => ({ works: { get: async () =>
      ({ data: null, error: { status: 403 } }) } }) } } } as unknown as MainClient;
    expect(await readInventory(agents[0]!.iri, {}, undefined, main)).toMatchObject({ ok: false, failure: 'denied' });
  });

  test('title, order and state survive continuation, first-page links and a return address; changing conditions drops the cursor', () => {
    const query = inventoryQuery({ q: '  雨 & Tides  ', sort: 'title' });
    const base = '/studio/@lin_mei';
    const more = new URL(inventoryAddress(base, 'draft', query, 'opaque/+?'), 'https://rezics.test');
    expect([...more.searchParams]).toEqual([['view', 'draft'], ['q', '雨 & Tides'], ['sort', 'title'], ['cursor', 'opaque/+?']]);
    expect(inventoryQuery(Object.fromEntries(more.searchParams))).toEqual(query);
    expect(new URL(inventoryAddress(base, 'published', query), more).searchParams.has('cursor')).toBe(false);
    expect(inventoryQuery({ q: ['bad'], sort: 'invalid' })).toEqual({ q: '', sort: 'recent' });
  });
});
