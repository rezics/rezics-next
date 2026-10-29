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
  const expected = new Map([
    [
      'Notifications inbox (`/inbox`)',
      [
        '- **Touches:** One private notification page read, then at most one existing post, decision or report read per distinct target; the navigation badge reads the capped count after hydration.',
        '- **Bound:** A page contains at most 20 notices; at most `1 + D + 1` kernel reads for `D` distinct targets, plus one count read per navigation inside its 60-second stale time. Opening marks the newest notice once.',
        '- **Growth check:** `tests/notifications-inbox.test.ts` checks pages of 5 and 20 notices naming three repeated posts and limits reads to the list, distinct targets and count.',
      ],
    ],
    [
      'Moderation decision (`/moderation/decisions/<id>`)',
      [
        '- **Touches:** One private decision read and one existing read of its post or thread; one appeal write and one decision re-read after submission.',
        "- **Bound:** Exactly two kernel reads per page view. The author can appeal through the decision's `:appeal` method through the inclusive 183-day deadline; successful and terminal-conflict submissions use the next decision read to show current state.",
        '- **Growth check:** `tests/moderation-decision.test.ts` checks the two-read bound, author and deadline gates, pending appeal state, overlong draft preservation and refreshed late/duplicate states.',
      ],
    ],
  ]);
  for (const [title, bullets] of expected) {
    const index = headings.findIndex((heading) => heading.level === 3 && heading.title === title);
    expect(index).toBeGreaterThanOrEqual(0);
    expect([...headings.slice(0, index)].reverse().find((heading) => heading.level === 2)?.title).toBe('Cost');
    expect(bodyOf(index)).toContain('**Touches:**');
    expect(bodyOf(index)).toContain('**Bound:**');
    expect(bodyOf(index)).toContain('**Growth check:**');
    expect(
      bodyOf(index)
        .split('\n')
        .filter((line) => line.startsWith('- **')),
    ).toEqual(bullets);
  }
});

test('every level two heading appears once', () => {
  const levelTwo = headings.filter((heading) => heading.level === 2).map((heading) => heading.title);
  expect(new Set(levelTwo).size).toBe(levelTwo.length);
});
