import { expect, test } from 'bun:test';
import { bookConcepts, freeConcepts, genreConcepts, seededBookIds } from './genres-plan.ts';

test('G-426 bilingual genre vocabulary has ordered in-scheme parents and every seeded Book uses it', () => {
  const genres = Object.entries(genreConcepts);
  const indexes = new Map(genres.map(([id], index) => [id, index]));
  expect(genres[0]?.[0]).toBe('fiction');
  for (const [index, [id, value]] of genres.entries()) {
    expect(value.en.length).toBeGreaterThan(0);
    expect(value.zh.length).toBeGreaterThan(0);
    if (value.broader) {
      expect(indexes.get(value.broader)).toBeLessThan(index);
      expect(value.broader).not.toBe(id);
    }
  }
  for (const value of Object.values(freeConcepts)) {
    expect(value.en.length).toBeGreaterThan(0);
    expect(value.zh.length).toBeGreaterThan(0);
  }
  expect(new Set(seededBookIds).size).toBe(seededBookIds.length);
  for (const work of seededBookIds) {
    expect(bookConcepts[work]?.length).toBeGreaterThanOrEqual(2);
    for (const concept of bookConcepts[work] ?? []) {
      expect(Object.hasOwn(genreConcepts, concept) || Object.hasOwn(freeConcepts, concept)).toBe(
        true,
      );
    }
  }
  expect(genreConcepts.urban.zh).toBe('都市');
  expect(genreConcepts.mystery.zh).toBe('悬疑');
});
