import { describe, expect, test } from 'bun:test';
import { createMemoryEpisodes, memoryEpisodeApi, type MemoryEpisodes } from '../features/tracking/episode-memory.ts';
import { episodeProgressWhere } from '../features/tracking/episode-progress.tsx';
import { standingOf, totalOf } from '../features/tracking/episodes.ts';
import { episodeSeries, saoOne } from '../features/tracking/fixtures.ts';
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
    expect(await where(memory)).toBe('Last watched: episode 1001');
  });

  test('a run plus a later episode', async () => {
    const memory = store(12);
    finish(memory, 1, 2, 3, 9);
    expect(await where(memory)).toBe('Watched through episode 3 of 12');
  });
});
