import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test } from 'bun:test';
import { CoverCard, CoverGrid, CoverRow } from '../src/components/cover-card.tsx';
import { Cover, coverRadius, placeholderColors, type CoverSubject } from '../src/components/cover.tsx';

const subject: CoverSubject = {
  id: 'wind-up-bird',
  title: 'The Wind-Up Bird Chronicle',
  types: ['schema:Book'],
  byline: 'Haruki Murakami',
};

const coverProps = { subject, cover: null, src: () => '' };
const tileElement = (props: Record<string, unknown> = {}) =>
  createElement(CoverCard, { cover: coverProps, title: subject.title, ...props } as never);
const tile = (props: Record<string, unknown> = {}) => renderToStaticMarkup(tileElement(props));
const cover = (props: Record<string, unknown> = {}) =>
  renderToStaticMarkup(createElement(Cover, { ...coverProps, size: 'md', ...props } as never));
const tagWithSlot = (html: string, slot: string) =>
  html.match(new RegExp(`<[^>]+data-slot="${slot}"[^>]*>`))?.[0] ?? '';
const classOf = (tag: string) => tag.match(/\sclass="([^"]*)"/)?.[1] ?? '';
const background = (html: string) => html.match(/background-color:(#[0-9a-f]+)/i)?.[1];

test('a cover tile has no card surface: no background, outline, border or shadow wraps the cover and its caption, and the caption sits on the page background', () => {
  const html = tile();
  const article = tagWithSlot(html, 'cover-card');
  const caption = tagWithSlot(html, 'cover-card-text');
  const frame = tagWithSlot(html, 'aspect-ratio');
  expect(classOf(article)).not.toMatch(/\b(?:bg-|outline(?:-|\s)|border(?:-|\s)|shadow(?:-|\s))/);
  expect(classOf(article)).toContain('focus-within:ring-2');
  expect(classOf(caption)).not.toMatch(/\b(?:bg-|outline(?:-|\s)|border(?:-|\s)|shadow(?:-|\s))/);
  expect(classOf(frame)).not.toContain('bg-muted');
  expect(classOf(frame)).not.toContain('ring-1');
});

test('the placeholder depends only on the subject ID: the same ID gives the same placeholder whatever its title, and different IDs give different ones', () => {
  const renamed = { ...subject, title: 'Another title', byline: 'Another byline' };
  expect(placeholderColors(renamed)).toEqual(placeholderColors(subject));
  expect(
    placeholderColors({ ...subject, types: ['schema:Person'] }),
    'the same ID has one colour across subject types',
  ).toEqual(placeholderColors(subject));
  const first = background(cover());
  const otherId = background(cover({ subject: { ...subject, id: 'another-subject' } }));
  expect(first).toBeDefined();
  expect(otherId).not.toBe(first);
});

test('a placeholder inside a tile with a visible caption contains no title or byline text, and a cover without a caption keeps the typographic title', () => {
  const html = tile();
  expect(html.match(/The Wind-Up Bird Chronicle/g)).toHaveLength(1);
  expect(html).not.toContain('Haruki Murakami');
  expect(html).not.toContain('>TW<');

  const standalone = cover();
  expect(standalone).toContain('The Wind-Up Bird Chronicle');
  expect(standalone).toContain('Haruki Murakami');
});

test('the tile, the row item and the standalone Cover use one corner radius', () => {
  const standalone = cover();
  const row = renderToStaticMarkup(
    createElement(CoverRow, { ratio: '5:7', label: 'Continue', children: tileElement() }),
  );
  const grid = renderToStaticMarkup(createElement(CoverGrid, { ratio: '5:7', children: tileElement() }));

  expect(classOf(tagWithSlot(tile(), 'cover-card'))).not.toMatch(/\brounded(?:-[^\s]+)?/);
  expect(classOf(tagWithSlot(row, 'cover-row'))).toContain(coverRadius);
  expect(classOf(tagWithSlot(tile(), 'aspect-ratio'))).toContain(coverRadius);
  expect(classOf(tagWithSlot(row, 'aspect-ratio'))).toContain(coverRadius);
  expect(classOf(tagWithSlot(grid, 'aspect-ratio'))).toContain(coverRadius);
  expect(classOf(tagWithSlot(standalone, 'aspect-ratio'))).toContain(coverRadius);
});

test('a tile given progress renders ProgressRow on one row: the bar and percent when a fraction is known, otherwise the position text', () => {
  const known = tile({ progress: { value: 0.42, label: '42%' } });
  expect(known).toContain('data-slot="progress-row"');
  expect(known).toContain('role="progressbar"');
  expect(known).toContain('42%');
  expect(classOf(tagWithSlot(known, 'progress-row'))).toContain('flex');

  const unknown = tile({ progress: { value: null, label: 'Ch 5' } });
  expect(unknown).toContain('data-slot="progress-row"');
  expect(unknown).not.toContain('role="progressbar"');
  expect(unknown).toContain('Ch 5');
});
