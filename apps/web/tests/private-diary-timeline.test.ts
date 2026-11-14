import { expect, test } from 'bun:test';
import { chronologicalGroups, recordedDayLabel } from '../src/library/private-diary/timeline';

test('date grouping preserves native order, duplicate occurrences and adjacent boundaries', () => {
  const rows = [
    { id: 'repeat', at: '2026-11-13T23:30:00.000Z' },
    { id: 'repeat', at: '2026-11-13T01:00:00.000Z' },
    { id: 'older', at: '2026-11-02T09:00:00.000Z' },
    { id: 'native-order', at: '2026-11-13T00:00:00.000Z' },
  ];
  const groups = chronologicalGroups(rows, (row) => row.at);
  expect(groups.map(({ date, offset }) => ({ date, offset }))).toEqual([
    { date: '2026-11-13', offset: 0 },
    { date: '2026-11-02', offset: 2 },
    { date: '2026-11-13', offset: 3 },
  ]);
  expect(groups.flatMap((group) => group.rows)).toEqual(rows);
  expect(groups[0]!.rows).toHaveLength(2);
  expect(chronologicalGroups([], () => '')).toEqual([]);
});

test('recorded date headings use an explicit UTC day in all supported locales', () => {
  for (const locale of ['en', 'de', 'es', 'fr', 'ja', 'ko', 'zh-Hans', 'zh-Hant']) {
    expect(recordedDayLabel('2026-11-13', locale)).toBe(new Intl.DateTimeFormat(locale, {
      year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC',
    }).format(new Date('2026-11-13T00:00:00Z')));
  }
});
