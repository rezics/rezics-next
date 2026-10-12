import { describe, expect, test } from 'bun:test';
import { createMemoryEpisodes, memoryEpisodeApi, type MemoryEpisodes } from '../features/tracking/episode-memory.ts';
import { episodeProgressWhere } from '../features/tracking/episode-progress.tsx';
import { standingOf, type Standing } from '../features/tracking/episodes.ts';
import { episodeSeries, iri, saoOne } from '../features/tracking/fixtures.ts';
import { copyOf } from '../features/tracking/messages.ts';

const t = copyOf('en');
const store = (mains: number, page?: number) =>
  createMemoryEpisodes({ ...episodeSeries({ mains }), ...(page ? { page } : {}) });

const finish = (memory: MemoryEpisodes, ...numbers: number[]) => {
  for (const number of numbers) {
    memory.progress.set(memory.mains[number - 1]!.occurrence, { completed: true, position: `episode:${number}`, version: 1 });
  }
};

async function where(memory: MemoryEpisodes) {
  const read = await standingOf(memoryEpisodeApi(memory), saoOne);
  if (!read.ok || !read.data) throw new Error('no standing');
  return episodeProgressWhere(read.data, t);
}

const labelled = (labels: string[]) => createMemoryEpisodes({
  structure: iri('e00'), page: 20,
  mains: labels.map((label, index) => ({ occurrence: iri(`e1${index + 1}`), label })),
  groups: [],
});

describe('episode progress summary', () => {
  test('201 completed episodes with a failed resume are unavailable', async () => {
    const memory = store(201);
    finish(memory, ...Array.from({ length: 201 }, (_, index) => index + 1));
    const api = memoryEpisodeApi(memory);
    api.resume = async () => ({ ok: false, failure: 'unavailable' });
    expect(await standingOf(api, saoOne)).toEqual({ ok: false, failure: 'unavailable' });
    expect(memory.calls.filter(call => call.startsWith('progress:'))).toHaveLength(0);
  });

  test('another device unmarking 1 and marking 2 cannot produce a mixed prefix', async () => {
    const memory = store(2);
    finish(memory, 1);
    const api = memoryEpisodeApi(memory);
    const resume = api.resume;
    api.resume = async work => {
      memory.progress.delete(memory.mains[0]!.occurrence);
      finish(memory, 2);
      return resume(work);
    };
    const read = await standingOf(api, saoOne);
    if (!read.ok || !read.data) throw new Error('no standing');
    expect(episodeProgressWhere(read.data, t)).toBe('Last watched: Episode 2');
    expect(read.data).not.toHaveProperty('through');
    expect(memory.calls.filter(call => call.startsWith('progress:'))).toHaveLength(0);
    expect(memory.calls.filter(call => call === 'resume')).toHaveLength(1);
  });

  test('a selected-revision completion uses Main\'s resume semantics', async () => {
    const memory = store(2);
    finish(memory, 1);
    const api = memoryEpisodeApi(memory);
    // The null-revision row is unfinished; the owner's resume includes the completed selection.
    api.resume = async () => ({ ok: true, data: { occurrence: memory.mains[1]!.occurrence, label: 'Episode 2' } });
    const read = await standingOf(api, saoOne);
    if (!read.ok || !read.data) throw new Error('no standing');
    expect(episodeProgressWhere(read.data, t)).toBe('Last watched: Episode 2');
    expect(read.data).not.toHaveProperty('through');
    expect(memory.calls.filter(call => call.startsWith('progress:'))).toHaveLength(0);
  });

  test('2020 episodes with resume at 2019 never fall back to episode 1', async () => {
    const memory = store(2020, 20);
    finish(memory, 2019);
    const read = await standingOf(memoryEpisodeApi(memory), saoOne);
    if (!read.ok || !read.data) throw new Error('no standing');
    expect(episodeProgressWhere(read.data, t)).toBe('Last watched: Episode 2019');
    expect(read.data.next).toBeNull();
    expect(memory.calls.filter(call => call.startsWith('page:root:'))).toHaveLength(1);
    expect(memory.calls.filter(call => call.startsWith('progress:'))).toHaveLength(0);
  });

  for (const last of [6, 12]) {
    test(`episodes 1 and ${last} do not prove the intervening run`, async () => {
      const memory = store(12);
      finish(memory, 1, last);
      const result = await standingOf(memoryEpisodeApi(memory), saoOne);
      if (!result.ok || !result.data) throw new Error('no standing');
      const read = result.data;
      expect(episodeProgressWhere(read, t)).toBe(`Last watched: Episode ${last}`);
      expect(read).not.toHaveProperty('through');
      expect(read.furthest?.occurrence).toBe(memory.mains[last - 1]!.occurrence);
      expect(read.next).toBeNull();
    });
  }

  test('unmarking episode 2 breaks a formerly completed run', async () => {
    const memory = store(12);
    finish(memory, ...Array.from({ length: 12 }, (_, index) => index + 1));
    const api = memoryEpisodeApi(memory);
    await api.mark({ structure: memory.structure, occurrence: memory.mains[1]!.occurrence }, { completed: false });
    expect(await where(memory)).toBe('Last watched: Episode 12');
  });

  test('a completed page endpoint cannot hide a gap across pages', async () => {
    const memory = store(12, 3);
    finish(memory, 1, 2, 3, 5, 6, 12);
    expect(await where(memory)).toBe('Last watched: Episode 12');
  });

  test('none watched', async () => {
    expect(await where(store(12))).toBe('No episode watched yet');
  });

  test('an unbroken run', async () => {
    const memory = store(12);
    finish(memory, 1, 2, 3, 4, 5, 6, 7);
    expect(await where(memory)).toBe('Last watched: Episode 7');
  });

  test('only episode 1001 watched', async () => {
    const memory = store(1002, 20);
    finish(memory, 1001);
    expect(await where(memory)).toBe('Last watched: Episode 1001');
  });

  test('a run plus a later episode', async () => {
    const memory = store(12);
    finish(memory, 1, 2, 3, 9);
    expect(await where(memory)).toBe('Last watched: Episode 9');
  });

  test('non-dense labels name the watched part, not an ordinal neighbour', async () => {
    const special = labelled(['12', '12.5', '13']);
    special.progress.set(special.mains[1]!.occurrence, { completed: true, position: 'episode:12.5', version: 1 });
    expect(await where(special)).toBe('Last watched: 12.5');

    const gap = labelled(['998', '1001']);
    gap.progress.set(gap.mains[1]!.occurrence, { completed: true, position: 'episode:1001', version: 1 });
    expect(await where(gap)).toBe('Last watched: 1001');
  });

  test('a furthest part without a name is some episodes watched', () => {
    const read = {
      structure: iri('e00'),
      mains: { structure: iri('e00'), parent: null, special: false, items: [], groups: [], next: null, pages: 0 },
      specials: [], next: null,
      furthest: { occurrence: iri('e199'), label: null },
    } satisfies Standing;
    expect(episodeProgressWhere(read, t)).toBe('Some episodes watched');
  });

  test('an episode labelled some is last watched, not the unnamed line', async () => {
    const memory = labelled(['before', 'some', 'after']);
    memory.progress.set(memory.mains[1]!.occurrence, { completed: true, position: 'episode:some', version: 1 });
    expect(await where(memory)).toBe('Last watched: some');
  });
});
