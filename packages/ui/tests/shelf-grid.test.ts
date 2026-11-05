import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CoverCard, CoverGrid } from '@rezics/ui/cover-card';
import { Cover } from '@rezics/ui/cover';
import { ProgressRow } from '@rezics/ui/progress-row';

const cover = { subject: { id: 'book', title: 'A book', types: ['schema:Book'] }, cover: null, src: () => '' };
const card = (props: Record<string, unknown> = {}) =>
  createElement(CoverCard, { href: '/book', title: 'A book', cover, ...props });

test('each density fills its container from a minimum card width with an 8 px gap', () => {
  for (const [density, minimum] of Object.entries({ small: '8rem', medium: '8.75rem', large: '10.5rem' })) {
    const html = renderToStaticMarkup(createElement(CoverGrid, { ratio: '2:3', density, children: card() }));
    expect(html).toContain(`repeat(auto-fill,minmax(${minimum},1fr))`);
    expect(html).toContain('gap-2');
    expect(html).toContain('data-slot="cover-grid"');
  }
  const defaultGrid = renderToStaticMarkup(createElement(CoverGrid, { ratio: '2:3', children: card() }));
  expect(defaultGrid).toContain('repeat(auto-fill,minmax(8.75rem,1fr))');
});

test('small cards retain an accessible title and visible progress label', () => {
  const html = renderToStaticMarkup(
    createElement(CoverGrid, {
      ratio: '2:3',
      density: 'small',
      children: card({
        secondary: 'Author',
        state: createElement(ProgressRow, { value: 0.5, label: '50%' }),
        status: 'Reading',
        badge: '2 new',
      }),
    }),
  );
  expect(html).toContain('title="A book"');
  expect(html).toMatch(/<a[^>]*data-slot="cover-card-title"[^>]*>A book<\/a>/);
  expect(html).toContain('role="progressbar"');
  expect(html).toContain('aria-valuenow="50"');
  expect(html).toContain('Reading');
  expect(html).toContain('2 new');
  expect(html).toContain('Author');
  expect(html).toContain('tabular-nums');
  expect(html).toContain('50%');
});

test('selection controls replace status and announce checked state', () => {
  const html = renderToStaticMarkup(
    card({ selectable: true, selected: true, onSelectedChange: () => {}, status: 'Reading', badge: '2 new' }),
  );
  expect(html).not.toContain('Reading');
  expect(html).toContain('2 new');
  expect(html).toContain('aria-pressed="true"');
  expect(html).not.toContain('href="/book"');
});

test('mismatched images use a blurred backdrop and never stretch', () => {
  const image = {
    media: 'image',
    width: 1000,
    height: 500,
    placeholder: { color: '#123456', thumbhash: '' },
    variants: [{ format: 'webp', width: 320 }],
    focalPoint: null,
    credit: null,
  };
  const html = renderToStaticMarkup(createElement(Cover, { ...cover, cover: image, size: 'fill' }));
  expect(html).toContain('data-fit="contain"');
  expect(html).toContain('data-slot="cover-backdrop"');
  expect(html).toContain('object-contain');
  expect(html).toContain('blur');
});

test('meta replaces secondary and hover selection is offered', () => {
  const html = renderToStaticMarkup(card({ secondary: 'Author', meta: 'Finished yesterday', onSelect: () => {} }));
  expect(html).toContain('Finished yesterday');
  expect(html).not.toContain('Author');
  expect(html).toContain('pointer-fine');
  expect(html).toContain('checkbox');
});
