import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CoverCard, CoverGrid, type CoverCardProps } from '@rezics/ui/cover-card';
import { Cover } from '@rezics/ui/cover';

const cover = { subject: { id: 'book', title: 'A book', types: ['schema:Book'] }, cover: null, src: () => '' };
const card = (props: Partial<CoverCardProps> = {}) =>
  createElement(CoverCard, { href: '/book', title: 'A book', cover, ...props });

test('grid densities keep 8 px gaps and shrink their track minimum inside a narrow container', () => {
  const densities = [
    ['small', '8rem', 134.4],
    ['medium', '8.75rem', 224],
    ['large', '10.5rem', 336],
  ] as const;
  for (const [density, minimum, coverHeight] of densities) {
    const html = renderToStaticMarkup(createElement(CoverGrid, { ratio: '2:3', density, children: card() }));
    const grid = html.match(/<div\b[^>]*data-slot="cover-grid"[^>]*>/)?.[0];
    expect(grid).toContain(`repeat(auto-fill,minmax(min(100%,${minimum}),1fr))`);
    expect(grid).toContain('gap-2');
    expect(html.match(/<div\b[^>]*data-slot="cover"[^>]*>/)?.[0]).toContain(`max-block-size:${coverHeight}px`);
  }
  const defaultGrid = renderToStaticMarkup(createElement(CoverGrid, { ratio: '2:3', children: card() }));
  expect(defaultGrid).toContain('repeat(auto-fill,minmax(min(100%,8.75rem),1fr))');
});

test('small cards retain an accessible title and visible progress label', () => {
  const html = renderToStaticMarkup(
    createElement(CoverGrid, {
      ratio: '2:3',
      density: 'small',
      children: card({
        secondary: 'Author',
        progress: { value: 0.5, label: '50%' },
        status: { label: 'Reading', href: '/library/reading' },
        badge: '2 new',
      }),
    }),
  );
  expect(html).toContain('title="A book"');
  expect(html).toMatch(/<a[^>]*data-slot="cover-card-title"[^>]*>A book<\/a>/);
  const progressBar = html.match(/<div\b[^>]*role="progressbar"[^>]*>/)?.[0];
  expect(progressBar).toContain('aria-valuenow="50"');
  expect(progressBar).toContain('aria-label="50%"');
  const statusLink = html.match(/<a\b[^>]*data-slot="cover-card-status"[^>]*>Reading<\/a>/)?.[0];
  expect(statusLink).toContain('href="/library/reading"');
  expect(statusLink).toContain('relative z-20');
  expect(statusLink).toContain('min-h-6');
  expect(html).toContain('2 new');
  expect(html).toContain('Author');
  expect(html).toMatch(/<span[^>]*tabular-nums[^>]*>50%<\/span>/);
});

test('selection replaces subject navigation with a pressed action while preserving supplied status and badge', () => {
  const html = renderToStaticMarkup(
    card({
      selectable: true,
      selected: true,
      onSelectedChange: () => {},
      status: { label: 'Reading' },
      badge: '2 new',
    }),
  );
  expect(html).toMatch(/<span\b[^>]*data-slot="cover-card-status"[^>]*>Reading<\/span>/);
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
    credit: { rightsHolder: 'Supplied owner' },
  };
  const html = renderToStaticMarkup(
    createElement(Cover, { ...cover, cover: image, size: 'fill', src: () => '/published-cover.webp' }),
  );
  expect(html).toContain('data-fit="contain"');
  expect(html).toContain('data-slot="cover-backdrop"');
  expect(html).toContain('object-contain');
  expect(html).toContain('blur');

  const unavailable = renderToStaticMarkup(createElement(Cover, { ...cover, cover: image, size: 'fill' }));
  expect(unavailable).toContain('data-state="placeholder"');
  expect(unavailable).toContain('data-ratio="5:7"');
  expect(unavailable).not.toMatch(/<(?:img|source)\b/);
});

test('meta replaces secondary and an independent labelled checkbox remains available for selection', () => {
  const html = renderToStaticMarkup(card({ secondary: 'Author', meta: 'Finished yesterday', onSelect: () => {} }));
  expect(html).toContain('Finished yesterday');
  expect(html).not.toContain('Author');
  const checkbox = html.match(/<[^>]+role="checkbox"[^>]*>/)?.[0];
  expect(checkbox).toContain('aria-label="A book"');
  expect(checkbox).toContain('aria-checked="false"');
  expect(html).toContain('href="/book"');
});
