import { expect, test } from 'bun:test';
import { countSerialWords } from '../src/modules/work/serial-projection.ts';
import { enrichSerialSearch } from '../src/modules/work/summary-serial.ts';

test('G291: projected words use Unicode word boundaries for English and Chinese chapters', () => {
  expect(countSerialWords('The first chapter begins.')).toBe(4);
  expect(countSerialWords('第一章 雨夜')).toBeGreaterThan(0);
});

test('G291: public Work search matches carry projected serial facts', async () => {
  const work = 'https://rezics.com/id/11111111-1111-4111-a111-111111111111';
  const relation = { resultGrain: 'mainVersion', sourcePosition: { dataEpoch: 'epoch', sequence: '7' },
    results: [{ work, score: 1 }] };
  const calls: string[][] = [];
  const projected = await enrichSerialSearch(relation, { batch: async (works: readonly string[], sequence?: string) => {
    calls.push([...works, sequence!]);
    return new Map([[work, { chapterCount: 3, wordCount: 14,
      lastUpdatedAt: '2026-09-27T00:00:00.000Z' }]]);
  } } as never);
  expect(calls).toEqual([[work, '7']]);
  expect(projected.results[0]).toMatchObject({ chapterCount: 3, wordCount: 14,
    lastUpdatedAt: '2026-09-27T00:00:00.000Z' });
});
