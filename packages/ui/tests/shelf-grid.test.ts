import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CoverCard, CoverGrid } from '@rezics/ui/cover-card';
import { Cover } from '@rezics/ui/cover';
import { ProgressRow } from '@rezics/ui/progress-row';

const cover = { subject: { id: 'book', title: 'A book', types: ['schema:Book'] }, cover: null, src: () => '' };
const card = (props: Record<string, unknown> = {}) =>
  createElement(CoverCard, { href: '/book', title: 'A book', cover, ...props });

test('density presets use the container width and preserve the original default', () => {
  for (const [density, columns] of Object.entries({
    small: [4, 6, 8, 10, 12],
    medium: [3, 4, 6, 7, 8],
    large: [2, 3, 4, 5, 6],
  })) {
    const html = renderToStaticMarkup(createElement(CoverGrid, { ratio: '2:3', density, children: card() }));
    expect(html).toContain(`grid-cols-${columns[0]}`);
    for (const [index, width] of [640, 1024, 1280, 1536].entries())
      expect(html).toContain(`@min-[${width}px]:grid-cols-${columns[index + 1]}`);
  }
  expect(renderToStaticMarkup(createElement(CoverGrid, { ratio: '2:3', children: card() }))).toContain(
    'repeat(auto-fill,minmax(9rem,1fr))',
  );
});

test('small cards retain an accessible title and progress without visible value', () => {
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
  expect(html).toContain('A book</a>');
  expect(html).toContain('role="progressbar"');
  expect(html).toContain('aria-valuenow="50"');
  expect(html).toContain('Reading');
  expect(html).toContain('2 new');
  expect(html).not.toContain('Author');
  expect(html).toContain('[&_.tabular-nums]:sr-only');
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
