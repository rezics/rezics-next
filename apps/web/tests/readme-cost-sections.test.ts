import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const readme = readFileSync(resolve(import.meta.dir, '../README.md'), 'utf8');
const headings = [...readme.matchAll(/^(#{2,3}) (.+?)\s*$/gm)].map((match) => ({
  level: match[1]!.length,
  title: match[2]!,
  start: match.index!,
  end: match.index! + match[0].length,
}));

function bodyOf(index: number) {
  const heading = headings[index]!;
  const next = headings.slice(index + 1).find((candidate) => candidate.level <= heading.level);
  return readme.slice(heading.end, next?.start ?? readme.length).trim();
}

test('every cost subsection is under Cost', () => {
  const misplaced = headings.flatMap((heading, index) => {
    if (heading.level !== 3) return [];
    const body = bodyOf(index);
    if (!['**Touches:**', '**Bound:**', '**Growth check:**'].every((bullet) => body.includes(bullet))) return [];
    const parent = [...headings.slice(0, index)].reverse().find((candidate) => candidate.level === 2);
    return parent?.title === 'Cost' ? [] : [heading.title];
  });
  expect(misplaced).toEqual([]);
});

test('Notifications inbox and Moderation decision cost text is preserved under Cost', () => {
  for (const title of ['Notifications inbox (`/inbox`)', 'Moderation decision (`/moderation/decisions/<id>`)']) {
    const index = headings.findIndex((heading) => heading.level === 3 && heading.title === title);
    expect(index).toBeGreaterThanOrEqual(0);
    expect([...headings.slice(0, index)].reverse().find((heading) => heading.level === 2)?.title).toBe('Cost');
    expect(bodyOf(index)).toContain('**Touches:**');
    expect(bodyOf(index)).toContain('**Bound:**');
    expect(bodyOf(index)).toContain('**Growth check:**');
  }
});

test('every level two heading appears once', () => {
  const levelTwo = headings.filter((heading) => heading.level === 2).map((heading) => heading.title);
  expect(new Set(levelTwo).size).toBe(levelTwo.length);
});
