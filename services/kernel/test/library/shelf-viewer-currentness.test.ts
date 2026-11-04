import { expect, test } from 'bun:test';
import { assertShelfPageCurrent } from '../../src/library/shelf-viewer-currentness.ts';

test('shelf currentness preserves the original cursor and rejects changed rows or unavailable state', () => {
  const observed = {
    entries: [{ subjectId: 'book', state: 'completed', revision: 1 }],
    next: 'original-expiring-cursor',
    scoreQuestion: { id: 'question' },
  };
  expect(() =>
    assertShelfPageCurrent(observed, {
      ...observed,
      entries: [...observed.entries],
      next: 'fresh-cursor-bytes',
    }),
  ).not.toThrow();
  expect(() =>
    assertShelfPageCurrent(observed, {
      ...observed,
      entries: [{ ...observed.entries[0]!, state: 'paused' }],
    }),
  ).toThrow();
  expect(() => assertShelfPageCurrent(observed, { entries: [], next: null })).toThrow();
});
