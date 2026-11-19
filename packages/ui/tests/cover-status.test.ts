import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CoverCard, CoverGrid, CoverRow } from '@rezics/ui/cover-card';

const cover = { subject: { id: 'book', title: 'A book', types: ['schema:Book'] }, cover: null, src: () => '' };
const status = { label: 'In progress', href: '/library?status=active' };
const tile = (props: Record<string, unknown> = {}) =>
  createElement(CoverCard, {
    href: '/book',
    title: 'A book',
    cover,
    secondary: 'An author',
    progress: { value: 0.4, label: '40%' },
    ...props,
  } as never);

test('status appears once in a grid and row caption after the title and before progress', () => {
  const grid = renderToStaticMarkup(
    createElement(CoverGrid, { ratio: '2:3', children: tile({ status: { label: status.label } }) }),
  );
  const row = renderToStaticMarkup(
    createElement(CoverRow, {
      ratio: '2:3',
      label: 'Library',
      children: tile({ status: { label: status.label } }),
    }),
  );

  for (const html of [grid, row]) {
    expect(html.match(/data-slot="cover-card-status"/g)).toHaveLength(1);
    expect(html.indexOf('data-slot="cover-card-title"')).toBeLessThan(html.indexOf('data-slot="cover-card-status"'));
    expect(html.indexOf('data-slot="cover-card-status"')).toBeLessThan(html.indexOf('data-slot="cover-card-state"'));
    expect(html).toContain(status.label);
  }
});

test('a linked status is separate from the subject link and keyboard follows title, status, menu', () => {
  const html = renderToStaticMarkup(tile({ status, menu: createElement('span', null, 'Remove') }));
  const titleEnd = html.indexOf('</a>');
  const statusStart = html.indexOf('href="/library?status=active"');
  const statusLinkStart = html.lastIndexOf('<a', statusStart);
  const menuStart = html.indexOf('<button');

  expect(html.match(/data-slot="cover-card-status"/g)).toHaveLength(1);
  expect(titleEnd).toBeLessThan(statusStart);
  expect(statusStart).toBeLessThan(menuStart);
  expect(titleEnd).toBeLessThan(statusLinkStart);
  expect(html.includes('text-foreground') || html.includes('text-muted-foreground')).toBe(true);
  expect(html).not.toContain('text-primary');
});

test('a tile without status has no status element or reserved caption space', () => {
  const html = renderToStaticMarkup(tile());
  expect(html).not.toContain('cover-card-status');
  expect(html).not.toContain('In progress');
});

test('long status labels render in full and can wrap within the tile', () => {
  const label = 'A very long localized library status label that must not widen the tile';
  const html = renderToStaticMarkup(tile({ status: { label } }));
  const [, chip, text] = html.match(/(<span\b[^>]*data-slot="cover-card-status"[^>]*>)([^<]*)<\/span>/) ?? [];
  expect(chip).toContain('max-w-full');
  expect(chip).toContain('whitespace-normal');
  expect(chip).toContain('wrap-anywhere');
  expect(chip).toContain(`aria-label="${label}"`);
  expect(text).toBe(label);
});
