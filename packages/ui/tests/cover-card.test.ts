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

test('card renders a title link and separate actions, with wrapping text and a fill cover', () => {
  const html = renderToStaticMarkup(card());
  expect(html).toContain('href="/book"');
  expect(html).toContain('More actions for A book');
  expect(html).toContain('data-size="fill"');
  expect(html).toContain('wrap-anywhere');
  expect(html).toContain('whitespace-normal');
  expect(html).not.toContain('line-clamp-');
  expect(html.match(/<a\b/g)?.length).toBe(1);
  expect(html.indexOf('</a>')).toBeLessThan(html.indexOf('<button'));
});

test('member Types set known list frames and composition supplies the unknown Type fallback', () => {
  const unknown = { id: 'unknown', title: 'Unknown', types: ['type:NotReleased'] };
  const grid = renderToStaticMarkup(createElement(CoverGrid, { ratio: '1:1', children: [card(), card(unknown)] }));
  const row = renderToStaticMarkup(
    createElement(CoverRow, { ratio: '2:3', label: 'Continue', children: card(unknown) }),
  );
  expect([...grid.matchAll(/data-ratio="([^"]+)"/gu)].map((match) => match[1])).toEqual(['5:7', '1:1']);
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

test('CoverCard keeps supplied metadata and exactly one known or unknown progress row with its missing-cover frame', () => {
  const html = renderToStaticMarkup(
    createElement(
      'div',
      null,
      createElement(CoverCard, {
        href: '/works/known',
        title: 'Known progress',
        cover,
        secondary: createElement('a', { href: '/people/author' }, 'A. Author'),
        progress: { value: 0.5, label: 'Ep 6/12' },
      }),
      createElement(CoverCard, {
        href: '/works/unknown',
        title: 'Unknown progress',
        cover,
        meta: 'Finished yesterday',
        progress: { value: null, label: 'Position unavailable' },
      }),
    ),
  );
  const cards = [...html.matchAll(/<article\b[^>]*data-slot="cover-card"[\s\S]*?<\/article>/gu)].map(([card]) => card!);
  expect(cards).toHaveLength(2);
  expect(cards[0]!.match(/data-slot="cover-card-state"/g)).toHaveLength(1);
  expect(cards[0]!.match(/data-slot="progress-row"/g)).toHaveLength(1);
  expect(cards[0]!.match(/role="progressbar"/g)).toHaveLength(1);
  expect(cards[0]).toContain('href="/people/author"');
  expect(cards[0]).toContain('data-slot="cover-placeholder-title"');
  expect(cards[1]!.match(/data-slot="cover-card-state"/g)).toHaveLength(1);
  expect(cards[1]!.match(/data-slot="progress-row"/g)).toHaveLength(1);
  expect(cards[1]!).not.toContain('role="progressbar"');
  expect(cards[1]!.match(/Position unavailable/g)).toHaveLength(1);
  expect(cards[1]).toContain('Finished yesterday');
  expect(cards[1]).toContain('data-slot="cover-placeholder-title"');
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
