import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./reaction-totals.test.ts', import.meta.url), 'utf8');

test('reaction-totals measures three scales whose largest is at most 4096', () => {
  const lists = [...source.matchAll(/scales\s*[:=]\s*\[([^\]]*)\]/g)].map((match) =>
    match[1]!
      .split(',')
      .map((value) => value.trim().replaceAll('_', ''))
      .filter((value) => value.length > 0)
      .map(Number),
  );
  expect(lists.length).toBeGreaterThan(0);
  for (const list of lists) {
    expect(list).toHaveLength(3);
    expect(list.every(Number.isSafeInteger)).toBe(true);
    expect(Math.max(...list)).toBeLessThanOrEqual(4096);
  }
});
