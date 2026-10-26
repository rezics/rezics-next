import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const FILES = [
  'growth-ban.test.ts',
  'growth-membership.test.ts',
  'participation.test.ts',
  'growth-membership-history.test.ts',
  '../../../../specs/community-outcomes.test.ts',
];

for (const file of FILES) {
  test(`${file} measures three scales with an equal ratio of at least four and the largest at most 4096`, () => {
    const source = readFileSync(new URL(`./${file}`, import.meta.url), 'utf8');
    const lists = [...source.matchAll(/\bscales\s*[:=]\s*\[([^\]]*)\]/gi)].map((match) =>
      match[1]!
        .split(',')
        .map((value) => value.trim().replaceAll('_', ''))
        .filter((value) => value.length > 0)
        .map(Number),
    );
    expect(lists.length).toBeGreaterThan(0);
    for (const list of lists) {
      expect(list).toHaveLength(3);
      const [a, b, c] = list as [number, number, number];
      expect([a, b, c].every(Number.isSafeInteger)).toBe(true);
      expect(b * b).toBe(a * c);
      expect(b / a).toBeGreaterThanOrEqual(4);
      expect(c).toBeLessThanOrEqual(4096);
    }
  });
}
