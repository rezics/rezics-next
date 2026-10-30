import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CoverCard, CoverGrid, CoverRow } from '@rezics/ui/cover-card';
import { ProgressRow } from '@rezics/ui/progress-row';

const cover = { subject: { id: 'book', title: 'A book', types: ['schema:Book'] }, cover: null, src: () => '' };
const card = (subject = cover.subject) =>
  createElement(CoverCard, {
    href: '/book',
    title: 'A book',
    cover: { ...cover, subject },
    secondary: 'Author',
    state: 'Reading',
    menu: createElement('span', null, 'Remove'),
  });

test('card renders a title link and separate actions, with clamped text and a fill cover', () => {
  const html = renderToStaticMarkup(card());
  expect(html).toContain('href="/book"');
  expect(html).toContain('More actions for A book');
  expect(html).toContain('data-size="fill"');
  expect(html).toContain('line-clamp-2');
  expect(html).toContain('line-clamp-1');
  expect(html.match(/<a\b/g)?.length).toBe(1);
  expect(html.indexOf('</a>')).toBeLessThan(html.indexOf('<button'));
});

test('member Types set known list frames and composition supplies the unknown Type fallback', () => {
  const unknown = { id: 'unknown', title: 'Unknown', types: ['type:NotReleased'] };
  const grid = renderToStaticMarkup(createElement(CoverGrid, { ratio: '1:1', children: [card(), card(unknown)] }));
  const row = renderToStaticMarkup(
    createElement(CoverRow, { ratio: '2:3', label: 'Continue', children: card(unknown) }),
  );
  expect([...grid.matchAll(/data-ratio="([^"]+)"/gu)].map((match) => match[1])).toEqual(['3:4', '1:1']);
  expect(row).toContain('data-ratio="2:3"');
  expect(row).toContain('aria-label="Continue"');
  expect(row).toContain('tabindex="0"');
});

test('progress is a single row, with a bar only when progress is known', () => {
  for (const value of [0, 0.42, 1]) {
    const html = renderToStaticMarkup(createElement(ProgressRow, { value, label: 'Ep 3/12' }));
    expect(html).toContain('role="progressbar"');
    expect(html).toContain(`aria-valuenow="${value * 100}"`);
    expect(html).toContain('tabular-nums');
  }
  expect(renderToStaticMarkup(createElement(ProgressRow, { value: null, label: 'Unknown' }))).not.toContain(
    'progressbar',
  );
});

test('card and progress stories pass accessible browser tests', async () => {
  const run = Bun.spawn(
    ['bun', 'x', 'vitest', 'run', 'src/components/cover-card.stories.tsx', 'src/components/progress-row.stories.tsx'],
    { cwd: new URL('..', import.meta.url).pathname, stdout: 'pipe', stderr: 'pipe', env: { ...process.env, CI: '1' } },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(run.stdout).text(),
    new Response(run.stderr).text(),
    run.exited,
  ]);
  expect(code, `${stdout}\n${stderr}`).toBe(0);
}, 300_000);
