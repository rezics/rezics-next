import { describe, expect, test } from 'bun:test';
import type { MainClient } from '../features/discover/types.ts';
import { mainEpisodeApi } from '../features/tracking/episode-api.ts';
import { createMemoryEpisodes, memoryEpisodeApi, type MemoryEpisodes } from '../features/tracking/episode-memory.ts';
import { MAX_PAGES, markPosition, reach, standingOf } from '../features/tracking/episodes.ts';
import { episodeSeries, saoOne } from '../features/tracking/fixtures.ts';

const store = (mains: number, specials = 0, page?: number) => createMemoryEpisodes({ ...episodeSeries({ mains, specials }), ...(page ? { page } : {}) });

async function standing(memory: MemoryEpisodes) {
  const read = await standingOf(memoryEpisodeApi(memory), saoOne);
  if (!read.ok || !read.data) throw new Error('no standing');
  return read.data;
}

const finish = (memory: MemoryEpisodes, ...numbers: number[]) => {
  for (const number of numbers) {
    memory.progress.set(memory.mains[number - 1]!.occurrence, { completed: true, position: `episode:${number}`, version: 1 });
  }
};

describe('where the reader stands in a series', () => {
  test('a reader who has finished nothing continues from the first main episode', async () => {
    const memory = store(12, 2);
    const read = await standing(memory);
    expect(read.through).toBeNull();
    expect(read.next?.number).toBe(1);
    expect(read.mains.items).toHaveLength(12);
    expect(read.specials.map(group => [group.label, group.walk.items.length])).toEqual([['Specials', 2]]);
    // One read for the first episode, nothing past it.
    expect(memory.calls.filter(call => call.startsWith('progress'))).toHaveLength(1);
  });

  test('episode 7 finished continues from episode 8, found by halving', async () => {
    const memory = store(12, 2);
    finish(memory, 1, 2, 3, 4, 5, 6, 7);
    const read = await standing(memory);
    expect(read.through?.number).toBe(7);
    expect(read.next?.number).toBe(8);
    expect(memory.calls.filter(call => call.startsWith('progress')).length).toBeLessThanOrEqual(6);
  });

  test('a special finished does not move the main run', async () => {
    const memory = store(12, 2);
    finish(memory, 1, 2, 3, 4, 5, 6, 7);
    const special = memory.groups[0]!.parts[0]!;
    memory.progress.set(special.occurrence, { completed: true, position: 'special:1', version: 1 });
    const read = await standing(memory);
    expect(read.through?.number).toBe(7);
    expect(read.next?.number).toBe(8);
  });

  test('only a special finished leaves the main run at its start', async () => {
    const memory = store(12, 2);
    memory.progress.set(memory.groups[0]!.parts[0]!.occurrence, { completed: true, position: 'special:1', version: 1 });
    const read = await standing(memory);
    expect(read.through).toBeNull();
    expect(read.next?.number).toBe(1);
  });

  test('the last episode finished leaves nothing to continue', async () => {
    const memory = store(3);
    finish(memory, 1, 2, 3);
    const read = await standing(memory);
    expect(read.through?.number).toBe(3);
    expect(read.next).toBeNull();
  });

  test('a run past the first page reads pages only as far as it goes', async () => {
    const memory = store(400, 0, 100);
    finish(memory, ...Array.from({ length: 150 }, (_, index) => index + 1));
    const read = await standing(memory);
    expect(read.through?.number).toBe(150);
    expect(read.next?.number).toBe(151);
    expect(memory.calls.filter(call => call.startsWith('page:root'))).toEqual(['page:root:first', 'page:root:100']);
  });

  test('episode 1000 of a thousand is reached by its number, a page at a time', async () => {
    const memory = store(1000, 0, 100);
    const api = memoryEpisodeApi(memory);
    const read = await standing(memory);
    expect(read.mains.items).toHaveLength(100);
    const last = await reach(api, read.mains, 1000);
    expect(last?.number).toBe(1000);
    expect(last?.label).toBe('Episode 1000');
    expect(read.mains.items).toHaveLength(1000);
    expect(read.mains.next).toBeNull();
    expect(await reach(api, read.mains, 1001)).toBeNull();
  });

  test('a series longer than the walk bound is not read without end', async () => {
    const memory = store(MAX_PAGES * 2 + 5, 0, 2);
    const api = memoryEpisodeApi(memory);
    const read = await standing(memory);
    expect(await reach(api, read.mains, MAX_PAGES * 2 + 1)).toBeNull();
    expect(read.mains.pages).toBe(MAX_PAGES);
  });

  test('a series with no episodes has no standing', async () => {
    expect(await standingOf(memoryEpisodeApi(store(0)), saoOne)).toEqual({ ok: true, data: null });
  });

  test('a mark leaves the number a later device reads back', async () => {
    const read = await standing(store(2, 1));
    expect(markPosition(read.mains.items[1]!)).toBe('episode:2');
    expect(markPosition(read.specials[0]!.walk.items[0]!)).toBe('special:1');
  });
});

describe('Main behind the episode api', () => {
  const structure = 'https://rezics.com/id/00000000-0000-7000-8000-000000000e00';
  const group = 'https://rezics.com/id/00000000-0000-7000-8000-000000000e01';
  const at = (id: string) => `https://rezics.com/id/00000000-0000-7000-8000-${id.padStart(12, '0')}`;

  function main(handlers: { get?: () => unknown; put?: (body: unknown) => unknown; parts?: () => unknown; page?: () => unknown }) {
    const asked: { parts: unknown[]; pages: unknown[]; puts: { body: unknown; key: string | undefined }[] } = { parts: [], pages: [], puts: [] };
    const progress = {
      get: async () => handlers.get?.() ?? { data: { completed: false, position: null, version: 0 }, error: null },
      put: async (body: unknown, options: { headers: Record<string, string> }) => {
        asked.puts.push({ body, key: options.headers['idempotency-key'] });
        return handlers.put?.(body) ?? { data: body, error: null };
      },
    };
    const client = {
      v1: {
        resources: () => ({ parts: { get: async (request: { query: unknown }) => {
          asked.parts.push(request.query);
          return handlers.parts?.() ?? { data: { structure, parts: [], next: null }, error: null };
        } } }),
        compositions: () => Object.assign(() => ({}), {
          get: async (request: { query: unknown }) => {
            asked.pages.push(request.query);
            return handlers.page?.() ?? { data: { occurrences: [], next: null }, error: null };
          },
          occurrences: () => ({ progress }),
        }),
      },
    } as unknown as MainClient;
    return { api: mainEpisodeApi('https://rezics.com/id/agent', () => client), asked };
  }

  test('a Structure of episodes is the Work\'s own, and one that places Works is the series panel\'s', async () => {
    const episodes = main({ parts: () => ({ data: { structure, parts: [{ role: 'group', occurrence: group }], next: null }, error: null }) });
    expect(await episodes.api.structure(saoOne)).toEqual({ ok: true, data: { structure, placesWorks: false } });
    expect(episodes.asked.parts).toEqual([{ actingSubject: 'https://rezics.com/id/agent', limit: 100 }]);
    const volumes = main({ parts: () => ({ data: { structure, parts: [{ role: 'part', occurrence: at('1'), work: at('2') }], next: null }, error: null }) });
    expect(await volumes.api.structure(saoOne)).toEqual({ ok: true, data: { structure, placesWorks: true } });
  });

  test('a Work with no series Structure has nothing to track, and a failed read is a failure', async () => {
    expect(await main({ parts: () => ({ data: null, error: { status: 404, value: {} } }) }).api.structure(saoOne)).toEqual({ ok: true, data: null });
    expect(await main({ parts: () => ({ data: null, error: { status: 503, value: {} } }) }).api.structure(saoOne)).toMatchObject({ ok: false });
  });

  test('a page tells episodes from groups, names them, and continues from Main\'s cursor', async () => {
    const { api, asked } = main({ page: () => ({ data: { next: 'cursor-2', occurrences: [
      { occurrence: at('e11'), role: 'part', target: at('1'), labels: [], qualifier: { type: 'work-part', displayLabel: 'Episode 1', inclusion: 'required' } },
      { occurrence: at('e12'), role: 'part', target: at('2'), labels: [{ value: 'Two', language: 'en' }] },
      { occurrence: at('e13'), role: 'part', labels: [] },
      { occurrence: group, role: 'group', labels: [{ value: 'Specials', language: 'en' }] },
    ] }, error: null }) });
    const page = await api.page(structure, { parent: group, after: 'cursor-1' });
    expect(asked.pages).toEqual([{ actingSubject: 'https://rezics.com/id/agent', limit: 100, parent: group, after: 'cursor-1' }]);
    expect(page).toEqual({ ok: true, data: { next: 'cursor-2',
      parts: [{ occurrence: at('e11'), label: 'Episode 1' }, { occurrence: at('e12'), label: 'Two' }],
      groups: [{ occurrence: group, label: 'Specials' }] } });
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

  test('stale answers are reported after a few tries, not retried forever', async () => {
    const { api, asked } = main({ put: () => ({ data: null, error: { status: 409, value: { code: 'stale_progress' } } }) });
    expect(await api.mark({ structure, occurrence: at('e17') }, { completed: true })).toEqual({ ok: false, failure: 'moved' });
    expect(asked.puts).toHaveLength(5);
  });

  test('a read Main asks to restart is restarted', async () => {
    let asks = 0;
    const { api } = main({ page: () => (asks++ === 0 ? { data: null, error: { status: 409, value: { code: 'read_basis_changed' } } }
      : { data: { occurrences: [], next: null }, error: null }) });
    expect(await api.page(structure)).toMatchObject({ ok: true });
    expect(asks).toBe(2);
  });
});
