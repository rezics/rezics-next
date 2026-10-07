import { describe, expect, test } from 'bun:test';
import type { MainClient } from '../features/discover/types.ts';
import { createMemoryEpisodes, memoryEpisodeApi } from '../features/tracking/episode-memory.ts';
import { mainEpisodeApi } from '../features/tracking/episode-api.ts';
import { episodeSeries, saoOne } from '../features/tracking/fixtures.ts';
import { markPosition, parseMarkPosition, standingOf } from '../features/tracking/episodes.ts';

async function standing(store: ReturnType<typeof createMemoryEpisodes>) {
  const read = await standingOf(memoryEpisodeApi(store), saoOne);
  if (!read.ok || !read.data) throw new Error('no standing');
  return read.data;
}

const finish = (store: ReturnType<typeof createMemoryEpisodes>, ...numbers: number[]) => {
  for (const number of numbers) {
    const item = store.items.find(entry => !entry.special && entry.ordinal === number)!;
    store.progress.set(item.occurrence, { completed: true, position: markPosition(item, number), version: 1 });
  }
};

describe('where the reader stands in a series', () => {
  test('a reader who has finished nothing continues from the first main episode', async () => {
    const read = await standing(createMemoryEpisodes(episodeSeries({ mains: 12, specials: 2 })));
    expect(read.through).toBeNull();
    expect(read.next?.ordinal).toBe(1);
    expect(read.total).toBe(12);
    expect(read.specials).toHaveLength(2);
  });

  test('episode 7 finished continues from episode 8', async () => {
    const store = createMemoryEpisodes(episodeSeries({ mains: 12, specials: 2 }));
    finish(store, 1, 2, 3, 4, 5, 6, 7);
    const read = await standing(store);
    expect(read.through?.ordinal).toBe(7);
    expect(read.next?.ordinal).toBe(8);
  });

  test('a special finished last does not advance the main count', async () => {
    const store = createMemoryEpisodes(episodeSeries({ mains: 12, specials: 2 }));
    finish(store, 1, 2, 3, 4, 5, 6, 7);
    const special = store.items.find(item => item.special)!;
    store.progress.set(special.occurrence, { completed: true, position: markPosition(special, 1), version: 1 });
    const read = await standing(store);
    // Main's furthest-finished resolution is the special, which stands last in reading order.
    expect(read.through?.ordinal).toBe(7);
    expect(read.next?.ordinal).toBe(8);
  });

  test('only a special finished leaves the main run at its start', async () => {
    const store = createMemoryEpisodes(episodeSeries({ mains: 12, specials: 2 }));
    const special = store.items.find(item => item.special)!;
    store.progress.set(special.occurrence, { completed: true, position: markPosition(special, 1), version: 1 });
    const read = await standing(store);
    expect(read.through).toBeNull();
    expect(read.next?.ordinal).toBe(1);
  });

  test('the last episode finished leaves nothing to continue', async () => {
    const store = createMemoryEpisodes(episodeSeries({ mains: 3 }));
    finish(store, 1, 2, 3);
    const read = await standing(store);
    expect(read.through?.ordinal).toBe(3);
    expect(read.next).toBeNull();
  });

  test('chapter 1000 of a thousand is reached beyond the first page by its number and found again from its mark', async () => {
    const store = createMemoryEpisodes(episodeSeries({ mains: 1000, role: 'chapter' }));
    finish(store, 1000);
    const api = memoryEpisodeApi(store);
    const read = await standing(store);
    expect(read.complete).toBe(false);
    expect(read.total).toBeNull();
    expect(read.kind).toBe('chapter');
    expect(read.through?.ordinal).toBe(1000);
    expect(read.next).toBeNull();
    // A page of a hundred, one progress read for the position, one lookup of 1000 and one of 1001.
    expect(store.calls.filter(call => call.startsWith('list'))).toEqual(['list', 'list:1000', 'list:1001']);
    expect((await api.list(saoOne, { q: '1000' }))).toMatchObject({ ok: true, data: { items: [{ ordinal: 1000 }] } });
  });

  test('the furthest episode past the first page of a long series with specials is found from its mark', async () => {
    const store = createMemoryEpisodes(episodeSeries({ mains: 150, specials: 1 }));
    finish(store, 120);
    const read = await standing(store);
    expect(read.through?.ordinal).toBe(120);
    expect(read.next?.ordinal).toBe(121);
  });

  test('a series with no episodes has no standing', async () => {
    const read = await standingOf(memoryEpisodeApi(createMemoryEpisodes([])), saoOne);
    expect(read).toEqual({ ok: true, data: null });
  });

  test('marks leave the number a later device reads back', () => {
    const [episode] = episodeSeries({ mains: 1, role: 'chapter' });
    expect(markPosition(episode!, 1000)).toBe('chapter:1000');
    expect(parseMarkPosition('chapter:1000')).toEqual({ kind: 'chapter', number: 1000 });
    expect(parseMarkPosition('paragraph:4')).toBeNull();
    expect(parseMarkPosition(null)).toBeNull();
  });
});

describe('Main behind the episode api', () => {
  const structure = 'https://rezics.com/id/00000000-0000-7000-8000-000000000e00';
  const group = 'https://rezics.com/id/00000000-0000-7000-8000-000000000e01';
  const at = (id: string) => `https://rezics.com/id/00000000-0000-7000-8000-${id.padStart(12, '0')}`;

  function main(handlers: { get?: () => unknown; put?: (body: unknown) => unknown; positions?: () => unknown }) {
    const asked: { positions: unknown[]; puts: { body: unknown; key: string | undefined }[] } = { positions: [], puts: [] };
    const progress = {
      get: async () => handlers.get?.() ?? { data: { completed: false, position: null, version: 0 }, error: null },
      put: async (body: unknown, options: { headers: Record<string, string> }) => {
        asked.puts.push({ body, key: options.headers['idempotency-key'] });
        return handlers.put?.(body) ?? { data: body, error: null };
      },
    };
    const client = {
      v1: {
        'reading-positions': () => ({ get: async (request: { query: unknown }) => {
          asked.positions.push(request.query);
          return handlers.positions?.() ?? { data: { items: [], complete: true, resolved: 'start' }, error: null };
        } }),
        compositions: () => ({ occurrences: () => ({ progress }) }),
      },
    } as unknown as MainClient;
    return { api: mainEpisodeApi('https://rezics.com/id/agent', () => client), asked };
  }

  test('lists in reading order for the reader, telling the group apart and dropping what is not readable', async () => {
    const { api, asked } = main({ positions: () => ({ data: { resolved: at('e12'), complete: true, items: [
      { occurrence: at('e11'), structure, parent: structure, role: 'part', target: at('1'), ordinal: 1, displayLabel: 'Episode 1' },
      { occurrence: at('e12'), structure, parent: group, role: 'part', target: at('2'), ordinal: 1, labels: [{ value: 'Special', language: 'en' }] },
      { occurrence: at('e13'), structure, parent: structure, role: 'part', target: null, ordinal: 2 },
    ] }, error: null }) });
    const page = await api.list(at('100'), { q: '1' });
    expect(asked.positions).toEqual([{ actingSubject: 'https://rezics.com/id/agent', position: 'mine', limit: 100, q: '1' }]);
    expect(page).toMatchObject({ ok: true, data: { complete: true, resolved: at('e12') } });
    if (!page.ok) return;
    expect(page.data.items.map(item => [item.ordinal, item.special, item.label])).toEqual([[1, false, 'Episode 1'], [1, true, 'Special']]);
  });

  test('"start" and "all" are not an occurrence', async () => {
    const { api } = main({});
    expect(await api.list(at('100'))).toMatchObject({ ok: true, data: { resolved: null } });
  });

  test('a mark reads the version, writes it with a fresh key, and applies the same intent again after a stale answer', async () => {
    let attempt = 0;
    const { api, asked } = main({
      get: () => ({ data: { completed: false, position: 'episode:7', version: attempt === 0 ? 3 : 4 }, error: null }),
      put: body => (attempt++ === 0 ? { data: null, error: { status: 409, value: { code: 'stale_progress' } } }
        : { data: { ...(body as object), version: 5 }, error: null }),
    });
    const written = await api.mark({ structure, occurrence: at('e17') }, { completed: true });
    expect(written.ok).toBe(true);
    expect(asked.puts.map(put => (put.body as { expectedVersion: number }).expectedVersion)).toEqual([3, 4]);
    expect(asked.puts[0]!.key).not.toBe(asked.puts[1]!.key);
    expect(asked.puts[1]!.body).toMatchObject({ completed: true, position: 'episode:7' });
  });

  test('two stale answers in a row are reported, not retried forever', async () => {
    const { api, asked } = main({ put: () => ({ data: null, error: { status: 409, value: {} } }) });
    expect(await api.mark({ structure, occurrence: at('e17') }, { completed: true })).toEqual({ ok: false, failure: 'moved' });
    expect(asked.puts).toHaveLength(2);
  });
});
