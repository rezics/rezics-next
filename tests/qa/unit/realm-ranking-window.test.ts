import { expect, test } from 'bun:test';
import { realmTopWindow } from '../../../services/main/tests/g-1034-fixture.ts';

test('retained Top windows expire by recorded reply time at every backup age', () => {
  const builtAt = new Date('2025-01-01T00:00:00Z');
  const retained = [
    { reply: 'winner', placement: 'a', score: 2, occurred_at: builtAt },
    { reply: 'opening', placement: 'b', score: 1, occurred_at: builtAt },
  ];
  for (const ageDays of [0, 8, 32, 366]) {
    const now = new Date(builtAt.getTime() + ageDays * 86_400_000);
    // A measured reply is posted through the product after every restore.
    const fresh = { reply: 'fresh', placement: 'c', score: 0, occurred_at: now };
    const rows = [...retained, fresh];
    expect(realmTopWindow(rows, 'all', now).map((row) => row.reply)).toEqual([
      'winner',
      'opening',
      'fresh',
    ]);
    for (const [period, days] of [
      ['week', 7],
      ['month', 30],
    ] as const) {
      expect(realmTopWindow(rows, period, now).map((row) => row.reply)).toEqual(
        ageDays < days ? ['winner', 'opening', 'fresh'] : ['fresh'],
      );
    }
  }
  for (const [period, days] of [
    ['week', 7],
    ['month', 30],
  ] as const) {
    const boundary = new Date(builtAt.getTime() + days * 86_400_000);
    expect(realmTopWindow(retained, period, new Date(boundary.getTime() - 1))).toHaveLength(2);
    expect(realmTopWindow(retained, period, boundary)).toEqual([]);
  }
  expect(retained.every((row) => row.occurred_at === builtAt)).toBe(true);
});
