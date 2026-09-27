import { expect, test } from 'bun:test';
import { rankingBuckets } from '../src/modules/rankings/projection.ts';

test('G291: day, ISO week and month baselines cross UTC boundaries exactly', () => {
  const at = new Date('2026-01-01T00:00:00.000Z');
  expect(rankingBuckets(at, 'day')).toEqual({ current: '2026-01-01', previous: '2025-12-31' });
  expect(rankingBuckets(at, 'week')).toEqual({ current: '2025-12-29', previous: '2025-12-22' });
  expect(rankingBuckets(at, 'month')).toEqual({ current: '2026-01-01', previous: '2025-12-01' });
});
