import { describe, expect, test } from 'bun:test';
import type { MainClient } from '../features/discover/types.ts';
import { mainEpisodeApi } from '../features/tracking/episode-api.ts';
import { createMemoryEpisodes, memoryEpisodeApi, type MemoryEpisodes } from '../features/tracking/episode-memory.ts';
import { MAX_PAGES, advance, markPosition, reach, standingOf } from '../features/tracking/episodes.ts';
import { episodeProgressWhere } from '../features/tracking/episode-progress.tsx';
import { copyOf } from '../features/tracking/messages.ts';
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
  test('a reader without a named resume has no inferred continuation', async () => {
    const memory = store(12, 2);
    const read = await standing(memory);
    expect(read.next).toBeNull();
    expect(read.mains.items).toHaveLength(12);
    expect(read.specials.map(group => [group.label, group.walk.items.length])).toEqual([['Specials', 2]]);
    // Inventory does not establish progress; only resume supplies that fact.
    expect(memory.calls.filter(call => call.startsWith('progress'))).toHaveLength(0);
  });

  test('episode 7 is named by resume without proving or inferring neighbours', async () => {
    const memory = store(12, 2);
    finish(memory, 1, 2, 3, 4, 5, 6, 7);
    const read = await standing(memory);
    expect(read.next).toBeNull();
    expect(memory.calls.filter(call => call.startsWith('progress'))).toHaveLength(0);
  });

  test('a special finished does not move the main run', async () => {
    const memory = store(12, 2);
    finish(memory, 1, 2, 3, 4, 5, 6, 7);
    const special = memory.groups[0]!.parts[0]!;
    memory.progress.set(special.occurrence, { completed: true, position: 'special:1', version: 1 });
    const read = await standing(memory);
    expect(read.next).toBeNull();
  });

  test('only a special finished leaves the main run at its start', async () => {
    const memory = store(12, 2);
    memory.progress.set(memory.groups[0]!.parts[0]!.occurrence, { completed: true, position: 'special:1', version: 1 });
    const read = await standing(memory);
    expect(read.next).toBeNull();
  });

  test('the last episode finished leaves nothing to continue', async () => {
    const memory = store(3);
    finish(memory, 1, 2, 3);
    const read = await standing(memory);
    expect(read.next).toBeNull();
  });

  test('a resume past the first page never triggers an inventory walk', async () => {
    const memory = store(400, 0, 100);
    finish(memory, ...Array.from({ length: 150 }, (_, index) => index + 1));
    const read = await standing(memory);
    expect(read.next).toBeNull();
    expect(memory.calls.filter(call => call.startsWith('page:root'))).toEqual(['page:root:first']);
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

  test('a cancelled jump cannot append over a newer selection or mark the wrong occurrence', async () => {
    const memory = store(60, 2, 20);
    const api = memoryEpisodeApi(memory);
    const read = await standing(memory);
    const page = api.page;
    let release!: () => void;
    let started!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const requested = new Promise<void>(resolve => { started = resolve; });
    let delay = true;
    api.page = async (structure, options) => {
      const result = await page(structure, options);
      if (delay && !options?.parent && options?.after === '20') {
        delay = false;
        started();
        await held;
      }
      return result;
    };
    let token = 1;
    const cancelled = reach(api, read.mains, 21, () => token === 1);
    await requested;
    token = 2;
    await api.progress(read.specials[0]!.walk.items[0]!);
    token = 3;
    expect((await reach(api, read.mains, 21, () => token === 3))?.occurrence).toBe(memory.mains[20]!.occurrence);
    const before = { items: [...read.mains.items], groups: [...read.mains.groups], next: read.mains.next, pages: read.mains.pages };
    release();
    expect(await cancelled).toBeNull();
    expect(read.mains).toMatchObject(before);
    token = 4;
    const selected = await reach(api, read.mains, 41, () => token === 4);
    expect(selected).toMatchObject({ occurrence: memory.mains[40]!.occurrence, number: 41, label: 'Episode 41' });
    if (!selected) throw new Error('no episode 41');
    await api.mark(selected, { completed: true, position: markPosition(selected) });
    expect([...memory.progress.entries()]).toEqual([[memory.mains[40]!.occurrence,
      { completed: true, position: 'episode:41', version: 1 }]]);
  });

  test('overlapping inventory pages deduplicate parts and groups by occurrence', async () => {
    const memory = store(60, 2, 20);
    const api = memoryEpisodeApi(memory);
    const page = api.page;
    api.page = async (structure, options) => {
      const result = await page(structure, options);
      if (!result.ok || options?.parent) return result;
      return { ok: true, data: { ...result.data,
        parts: options?.after ? [memory.mains[19]!, ...result.data.parts, result.data.parts[0]!] : result.data.parts,
        groups: [memory.groups[0]!, memory.groups[0]!],
      } };
    };
    const loaded = await standingOf(api, saoOne);
    if (!loaded.ok || !loaded.data) throw new Error('no standing');
    const read = loaded.data;
    expect(read.mains.groups).toHaveLength(1);
    expect(read.specials).toHaveLength(1);
    expect((await reach(api, read.mains, 41))?.occurrence).toBe(memory.mains[40]!.occurrence);
    expect(read.mains.items).toHaveLength(60);
    expect(new Set(read.mains.items.map(item => item.occurrence)).size).toBe(60);
    read.mains.items.reverse();
    expect((await reach(api, read.mains, 1))?.occurrence).toBe(memory.mains[0]!.occurrence);
  });

  test('a cancelled inventory request changes no items, groups, cursor or page budget', async () => {
    const memory = store(60, 2, 20);
    const api = memoryEpisodeApi(memory);
    const read = await standing(memory);
    const before = { items: [...read.mains.items], groups: [...read.mains.groups], next: read.mains.next, pages: read.mains.pages };
    let current = true;
    const page = api.page;
    api.page = async (structure, options) => { const result = await page(structure, options); current = false; return result; };
    expect(await advance(api, read.mains, () => current)).toBe(false);
    expect(read.mains).toMatchObject(before);
    const calls = memory.calls.length;
    expect(await reach(api, read.mains, 41, () => current)).toBeNull();
    expect(memory.calls).toHaveLength(calls);
  });

  test('a series longer than the walk bound is not read without end', async () => {
    const memory = store(MAX_PAGES * 2 + 5, 0, 2);
    const api = memoryEpisodeApi(memory);
    const read = await standing(memory);
    await expect(reach(api, read.mains, MAX_PAGES * 2 + 1)).rejects.toThrow('budget');
    expect(read.mains.pages).toBe(MAX_PAGES);
  });

  test('marking episode 1001 of 1002 does not infer a successor', async () => {
    const memory = store(1002, 0, 20);
    finish(memory, 1001);
    const read = await standing(memory);
    expect(read.next).toBeNull();
    expect(memory.calls.filter(call => call.startsWith('progress'))).toHaveLength(0);
    expect(memory.calls.filter(call => call.startsWith('page:root')).length).toBeLessThanOrEqual(MAX_PAGES);
  });

  test('an empty inventory cannot establish saved progress', async () => {
    const read = await standingOf(memoryEpisodeApi(store(0)), saoOne);
    if (!read.ok || !read.data) throw new Error('unknown standing must remain visible');
    expect(episodeProgressWhere(read.data, copyOf('en'))).toBe('Unknown');
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

  function main(handlers: { get?: () => unknown; put?: (body: unknown) => unknown; parts?: () => unknown; page?: () => unknown; resume?: () => unknown }) {
    const asked: { parts: unknown[]; pages: unknown[]; puts: { body: unknown; key: string | undefined }[]; resumes: unknown[] } = { parts: [], pages: [], puts: [], resumes: [] };
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
        'reading-positions': () => ({ get: async (request: { query: unknown }) => {
          asked.resumes.push(request.query);
          return handlers.resume?.() ?? { data: { scope: 'positions', resolved: 'start', items: [] }, error: null };
        } }),
      },
    } as unknown as MainClient;
    return { api: mainEpisodeApi('https://rezics.com/id/agent', () => client), asked };
  }

  test('a Structure of episodes is the Work\'s own, and one that places Works is the series panel\'s', async () => {
    const episodes = main({ parts: () => ({ data: { structure, parts: [{ role: 'group', occurrence: group }], next: null }, error: null }) });
    expect(await episodes.api.structure(saoOne)).toEqual({ ok: true, data: { structure, placesWorks: false } });
    expect(episodes.asked.parts).toEqual([{ actingSubject: 'https://rezics.com/id/agent', limit: 20 }]);
    const volumes = main({ parts: () => ({ data: { structure, parts: [{ role: 'part', occurrence: at('1'), work: at('2') }], next: null }, error: null }) });
    expect(await volumes.api.structure(saoOne)).toEqual({ ok: true, data: { structure, placesWorks: true } });
  });

  test('a Work with no series Structure has nothing to track, and a failed read is a failure', async () => {
    expect(await main({ parts: () => ({ data: null, error: { status: 404, value: {} } }) }).api.structure(saoOne)).toEqual({ ok: true, data: null });
    expect(await main({ parts: () => ({ data: null, error: { status: 503, value: {} } }) }).api.structure(saoOne)).toMatchObject({ ok: false });
  });

  test('Mine names a fenced completed occurrence, while a positions window is unknown', async () => {
    const resumed = main({ resume: () => ({ data: { scope: 'resume', resolved: at('e1001'),
      complete: true, items: [{ occurrence: at('e1001'), displayLabel: 'Episode 1001' }] }, error: null }) });
    expect(await resumed.api.resume(saoOne)).toEqual({ ok: true, data: { occurrence: at('e1001'), label: 'Episode 1001' } });
    expect(resumed.asked.resumes).toEqual([{ actingSubject: 'https://rezics.com/id/agent', position: 'mine', limit: 1 }]);
    expect(await main({}).api.resume(saoOne)).toEqual({ ok: true, data: null });
    expect(await main({ resume: () => ({ data: { scope: 'positions', resolved: at('e1001'), complete: true,
      items: [{ occurrence: at('e1001'), displayLabel: 'Episode 1001' }] }, error: null }) }).api.resume(saoOne))
      .toEqual({ ok: true, data: null });
  });

  test('revoked eligibility after a mark leaves progress unknown, not empty', async () => {
    let eligible = true;
    const episode = { occurrence: at('e1'), label: 'Episode 1' };
    const { api } = main({
      page: () => ({ data: { occurrences: [{ ...episode, role: 'part', target: at('1'), labels: [{ value: episode.label }] }], next: null }, error: null }),
      resume: () => ({ data: eligible
        ? { scope: 'resume', resolved: episode.occurrence, complete: true, items: [{ ...episode, displayLabel: episode.label }] }
        : { scope: 'positions', resolved: 'start', complete: true, items: [] }, error: null }),
      put: () => { eligible = false; return { data: { completed: true, position: 'episode:1', version: 1 }, error: null }; },
    });
    const before = await standingOf(api, saoOne);
    if (!before.ok || !before.data) throw new Error('no standing');
    expect(episodeProgressWhere(before.data, copyOf('en'))).toBe('Last watched: Episode 1');
    expect(await api.mark({ structure, occurrence: episode.occurrence }, { completed: true })).toMatchObject({ ok: true });
    const after = await standingOf(api, saoOne);
    if (!after.ok || !after.data) throw new Error('unknown standing must remain visible');
    expect(episodeProgressWhere(after.data, copyOf('en'))).toBe('Unknown');
  });

  test('an incomplete Main resume is unknown, not unavailable or no episode watched', async () => {
    const { api } = main({ resume: () => ({ data: {
      scope: 'resume', resolved: 'pending', complete: false, items: [], nextCursor: 'resume-more', visibility: 'pending',
    }, error: null }) });
    expect(await api.resume(saoOne)).toEqual({ ok: true, data: null });
    const read = await standingOf(api, saoOne);
    if (!read.ok || !read.data) throw new Error('unknown standing must remain visible');
    expect(episodeProgressWhere(read.data, copyOf('en'))).toBe('Unknown');
  });

  test('a page tells episodes from groups, names them, and continues from Main\'s cursor', async () => {
    const { api, asked } = main({ page: () => ({ data: { next: 'cursor-2', occurrences: [
      { occurrence: at('e11'), role: 'part', target: at('1'), labels: [], qualifier: { type: 'work-part', displayLabel: 'Episode 1', inclusion: 'required' } },
      { occurrence: at('e12'), role: 'part', target: at('2'), labels: [{ value: 'Two', language: 'en' }] },
      { occurrence: at('e13'), role: 'part', labels: [] },
      { occurrence: group, role: 'group', labels: [{ value: 'Specials', language: 'en' }] },
    ] }, error: null }) });
    const page = await api.page(structure, { parent: group, after: 'cursor-1' });
    expect(asked.pages).toEqual([{ actingSubject: 'https://rezics.com/id/agent', limit: 20, parent: group, after: 'cursor-1' }]);
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

  test('a chapter or game keeps both versions when another device wrote first', async () => {
    const { api, asked } = main({
      get: () => ({ data: { completed: true, position: 'chapter:2:3', version: 4 }, error: null }),
      put: () => ({ data: null, error: { status: 409, value: { code: 'stale_progress' } } }),
    });
    const written = await api.mark({ structure, occurrence: at('ch') },
      { completed: false, position: 'chapter:2:3' }, { conflict: true });
    expect(written.ok).toBe(false);
    if (written.ok || written.failure !== 'stale') throw new Error('expected both versions');
    expect(written.current).toMatchObject({ completed: true, version: 4 });
    expect(written.submitted).toEqual({ completed: false, position: 'chapter:2:3' });
    expect(asked.puts).toHaveLength(1);
  });

  test('stale answers are reported after a few tries, not retried forever', async () => {
    const { api, asked } = main({ put: () => ({ data: null, error: { status: 409, value: { code: 'stale_progress' } } }) });
    expect(await api.mark({ structure, occurrence: at('e17') }, { completed: true })).toEqual({ ok: false, failure: 'moved',
      status: 409, problem: { code: 'stale_progress' } });
    expect(asked.puts).toHaveLength(5);
  });

  test('a write Main could not answer is sent again as the same command', async () => {
    let attempt = 0;
    const { api, asked } = main({ put: body => (attempt++ === 0 ? { data: null, error: { status: 503, value: { code: 'dependency_unavailable' } } }
      : { data: { ...(body as object), version: 1 }, error: null }) });
    expect((await api.mark({ structure, occurrence: at('e17') }, { completed: true })).ok).toBe(true);
    expect(asked.puts).toHaveLength(2);
    expect(asked.puts[1]!.key).toBe(asked.puts[0]!.key);
    expect(asked.puts[1]!.body).toEqual(asked.puts[0]!.body);
  });

  test('a write refused for what it asks is not sent again', async () => {
    const { api, asked } = main({ put: () => ({ data: null, error: { status: 404, value: {} } }) });
    expect(await api.mark({ structure, occurrence: at('e17') }, { completed: true })).toEqual({ ok: false, failure: 'missing',
      status: 404, problem: {} });
    expect(asked.puts).toHaveLength(1);
  });

  test('a read that Main could not answer is tried again', async () => {
    let asks = 0;
    const { api } = main({ page: () => (asks++ === 0 ? { data: null, error: { status: 503, value: {} } }
      : { data: { occurrences: [], next: null }, error: null }) });
    expect(await api.page(structure)).toMatchObject({ ok: true });
    expect(asks).toBe(2);
  });

  test('a read Main asks to restart is restarted', async () => {
    let asks = 0;
    const { api } = main({ page: () => (asks++ === 0 ? { data: null, error: { status: 409, value: { code: 'read_basis_changed' } } }
      : { data: { occurrences: [], next: null }, error: null }) });
    expect(await api.page(structure)).toMatchObject({ ok: true });
    expect(asks).toBe(2);
  });
});
