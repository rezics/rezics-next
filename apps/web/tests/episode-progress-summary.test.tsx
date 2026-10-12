import { describe, expect, test } from 'bun:test';
import { createMemoryEpisodes, memoryEpisodeApi, type MemoryEpisodes } from '../features/tracking/episode-memory.ts';
import { episodeProgressCompletion, episodeProgressWhere } from '../features/tracking/episode-progress.tsx';
import { MAX_COMPLETION_READS, MAX_PAGES, standingOf, totalOf, type Standing } from '../features/tracking/episodes.ts';
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
  return episodeProgressWhere(read.data, totalOf(read.data), t);
}

const labelled = (labels: string[]) => createMemoryEpisodes({
  structure: iri('e00'), page: 20,
  mains: labels.map((label, index) => ({ occurrence: iri(`e1${index + 1}`), label })),
  groups: [],
});

describe('episode progress summary', () => {
  for (const page of [1, MAX_COMPLETION_READS + 1]) {
    test(`a bounded proof with page size ${page} reports an unknown prefix`, async () => {
      const memory = store(MAX_COMPLETION_READS + 1, page);
      finish(memory, ...Array.from({ length: memory.mains.length }, (_, index) => index + 1));
      const result = await standingOf(memoryEpisodeApi(memory), saoOne);
      if (!result.ok || !result.data) throw new Error('no standing');
      expect(result.data.through).toBeNull();
      expect(episodeProgressWhere(result.data, totalOf(result.data), t)).toBe(`Last watched: Episode ${MAX_COMPLETION_READS + 1}`);
      expect(episodeProgressCompletion(result.data, totalOf(result.data))).toEqual({ percent: null, allWatched: false });
      expect(memory.calls.filter(call => call.startsWith('progress')).length).toBeLessThanOrEqual(MAX_COMPLETION_READS);
      expect(result.data.mains.pages).toBeLessThanOrEqual(MAX_PAGES);
    });
  }

  test('a failure inside the prefix does not turn a completed endpoint into proof', async () => {
    const memory = store(12);
    finish(memory, 1, 12);
    const api = memoryEpisodeApi(memory);
    const progress = api.progress;
    api.progress = episode => episode.occurrence === memory.mains[1]!.occurrence
      ? Promise.resolve({ ok: false, failure: 'unavailable' }) : progress(episode);
    expect(await standingOf(api, saoOne)).toEqual({ ok: false, failure: 'unavailable' });
  });

  for (const last of [6, 12]) {
    test(`episodes 1 and ${last} do not prove the intervening run`, async () => {
      const memory = store(12);
      finish(memory, 1, last);
      const result = await standingOf(memoryEpisodeApi(memory), saoOne);
      if (!result.ok || !result.data) throw new Error('no standing');
      const read = result.data;
      expect(episodeProgressWhere(read, totalOf(read), t)).toBe('Watched through episode 1 of 12');
      expect(episodeProgressCompletion(read, totalOf(read))).toEqual({ percent: 8, allWatched: false });
      expect(read.furthest?.occurrence).toBe(memory.mains[last - 1]!.occurrence);
      expect(read.next?.number ?? null).toBe(last === 12 ? null : 7);
    });
  }

  test('unmarking episode 2 breaks a formerly completed run', async () => {
    const memory = store(12);
    finish(memory, ...Array.from({ length: 12 }, (_, index) => index + 1));
    const api = memoryEpisodeApi(memory);
    await api.mark({ structure: memory.structure, occurrence: memory.mains[1]!.occurrence }, { completed: false });
    expect(await where(memory)).toBe('Watched through episode 1 of 12');
  });

  test('a completed page endpoint cannot hide a gap across pages', async () => {
    const memory = store(12, 3);
    finish(memory, 1, 2, 3, 5, 6, 12);
    expect(await where(memory)).toBe('Watched through episode 3 of 12');
  });

  test('an incomplete run never rounds to 100 percent', async () => {
    const memory = store(200, 200);
    finish(memory, ...Array.from({ length: 199 }, (_, index) => index + 1));
    const result = await standingOf(memoryEpisodeApi(memory), saoOne);
    if (!result.ok || !result.data) throw new Error('no standing');
    expect(episodeProgressCompletion(result.data, totalOf(result.data))).toEqual({ percent: 99, allWatched: false });
  });

  test('a fully verified run is 100 percent and all watched', async () => {
    const memory = store(12);
    finish(memory, ...Array.from({ length: 12 }, (_, index) => index + 1));
    const result = await standingOf(memoryEpisodeApi(memory), saoOne);
    if (!result.ok || !result.data) throw new Error('no standing');
    expect(episodeProgressCompletion(result.data, totalOf(result.data))).toEqual({ percent: 100, allWatched: true });
  });

  test('none watched', async () => {
    expect(await where(store(12))).toBe('No episode watched yet');
  });

  test('an unbroken run', async () => {
    const memory = store(12);
    finish(memory, 1, 2, 3, 4, 5, 6, 7);
    expect(await where(memory)).toBe('Watched through episode 7 of 12');
  });

  test('only episode 1001 watched', async () => {
    const memory = store(1002, 20);
    finish(memory, 1001);
    expect(await where(memory)).toBe('Last watched: Episode 1001');
  });

  test('a run plus a later episode', async () => {
    const memory = store(12);
    finish(memory, 1, 2, 3, 9);
    expect(await where(memory)).toBe('Watched through episode 3 of 12');
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
      specials: [], through: null, next: null,
      furthest: { occurrence: iri('e199'), label: null },
    } satisfies Standing;
    expect(episodeProgressWhere(read, null, t)).toBe('Some episodes watched');
  });

  test('an episode labelled some is last watched, not the unnamed line', async () => {
    const memory = labelled(['before', 'some', 'after']);
    memory.progress.set(memory.mains[1]!.occurrence, { completed: true, position: 'episode:some', version: 1 });
    expect(await where(memory)).toBe('Last watched: some');
  });
});
