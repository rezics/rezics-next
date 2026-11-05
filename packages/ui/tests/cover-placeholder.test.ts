import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Cover } from '../src/components/cover.tsx';
import { CoverCard, CoverGrid, CoverRow } from '../src/components/cover-card.tsx';

const subject = { id: 'norwegian-wood', title: 'Norwegian Wood', types: ['schema:Book'] };
const cover = { subject, cover: null, src: () => '' };
const card = (props: Record<string, unknown> = {}) =>
  createElement(CoverCard, { cover, title: subject.title, ...props } as never);
const render = (element: React.ReactElement) => renderToStaticMarkup(element);
const slot = (html: string, name: string) => html.match(new RegExp(`<[^>]+data-slot="${name}"[^>]*>`))?.[0] ?? '';
const classes = (tag: string) => tag.match(/\sclass="([^"]*)"/)?.[1] ?? '';

test('a subject without a cover shows the same titled colour field in a tile, a list row and a bare Cover', () => {
  const tile = render(card());
  const row = render(createElement(CoverRow, { ratio: '2:3', label: 'Books', children: card() }));
  const bare = render(createElement(Cover, { ...cover, size: 'fill' }));
  for (const html of [tile, row, bare]) {
    expect(html).toContain('Norwegian Wood');
    expect(html).toContain('data-state="placeholder"');
  }
  const color = (html: string) => html.match(/background-color:(#[0-9a-f]+)/i)?.[1];
  expect(color(tile)).toBe(color(row));
  expect(color(row)).toBe(color(bare));
});

test('below 64 px the placeholder is a colour field with one neutral image icon and never initials', () => {
  for (const size of ['xs', 'sm', 'md', 'lg', 'xl', 'fill'] as const) {
    const html = render(createElement(Cover, { ...cover, size }));
    expect(html).not.toContain('>NW<');
    expect(html).not.toContain('>N<');
  }
  const small = render(createElement(Cover, { ...cover, size: 'xs' }));
  expect(small.match(/data-slot="cover-placeholder-icon"/g)).toHaveLength(1);
  expect(slot(small, 'cover-placeholder-icon')).toContain('text-muted-foreground');
  expect(small).not.toContain('data-slot="cover-placeholder-title"');
});

test('CoverCard does not disable placeholder text and the showPlaceholderText prop is gone', () => {
  const tile = render(card());
  expect(tile).toContain('Norwegian Wood');
  expect(tile).not.toContain('showPlaceholderText');
});

test('the menu shares the bottom action row after state or progress and rows align to the card bottom', () => {
  const state = render(card({ state: 'Reading', menu: createElement('span', null, 'Remove') }));
  const progress = render(
    card({ progress: { value: 0.5, label: '50%' }, menu: createElement('span', null, 'Remove') }),
  );
  for (const html of [state, progress]) {
    const actionRow = slot(html, 'cover-card-actions-row');
    expect(classes(actionRow)).toContain('mt-auto');
    expect(classes(actionRow)).toContain('justify-between');
    expect(html.indexOf('data-slot="cover-card-state-content"')).toBeLessThan(
      html.indexOf('data-slot="cover-card-actions"'),
    );
  }
});

test('a tile without a menu or state has no empty last row, and a menu trigger remains a button', () => {
  const empty = render(card());
  expect(empty).not.toContain('data-slot="cover-card-actions-row"');
  const withMenu = render(card({ menu: createElement('span', null, 'Remove') }));
  expect(withMenu).toContain('<button');
  expect(withMenu).toContain('More actions for Norwegian Wood');
  expect(withMenu).toContain('data-slot="cover-card-actions-row"');
});

test('placeholder titles wrap at word boundaries and shrink a single word rather than splitting it', () => {
  const html = render(createElement(Cover, { ...cover, size: 'fill' }));
  const title = slot(html, 'cover-placeholder-title');
  expect(title).toContain('word-break:normal');
  expect(title).toContain('overflow-wrap:normal');
  expect(title).not.toMatch(/(?:break-all|break-words|wrap-anywhere|overflow-wrap:anywhere)/);
  expect(html).toContain('container-type:inline-size');
});
