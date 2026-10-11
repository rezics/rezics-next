import { describe, expect, test } from 'bun:test';
import { createMemoryEpisodes, memoryEpisodeApi, type MemoryEpisodes } from '../features/tracking/episode-memory.ts';
import { episodeProgressWhere } from '../features/tracking/episode-progress.tsx';
import { standingOf, totalOf, type Standing } from '../features/tracking/episodes.ts';
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
});
