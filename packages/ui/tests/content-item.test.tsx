import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ContentItem } from '@rezics/ui/content-item';
import { ShelfList, ShelfListRow } from '@rezics/ui/shelf-list';

test('ContentItem composes its slots as one named heading, one stretched link and raised independent controls', () => {
  const title = 'A translated title';
  const html = renderToStaticMarkup(
    createElement(
      'ul',
      null,
      createElement(ContentItem, {
        title,
        titleLang: 'ja',
        headingLevel: 3,
        href: '/works/book',
        visual: createElement('div', { className: 'w-20' }, 'Cover'),
        context: 'Continue reading',
        metadata: createElement('a', { href: '/people/author' }, 'A. Author'),
        preview: 'A short supplied description.',
        state: 'Episode 3 of 12',
        actions: createElement('button', { type: 'button' }, 'Continue'),
        trailing: createElement('button', { type: 'button' }, 'More actions'),
        'data-testid': 'content-item',
      }),
      createElement(ContentItem, {
        title: 'A heading without a destination',
        headingLevel: 4,
        context: 'No destination is available',
        visual: false,
        state: false,
        actions: false,
        trailing: false,
        'data-testid': 'plain-item',
      }),
    ),
  );

  expect(html.match(/<li\b/g)?.length).toBe(2);
  expect(html).toContain('<li data-testid="content-item"');
  expect(html).toContain('<h3');
  expect(html).toContain('<h4');
  expect(html).toContain('lang="ja"');
  expect(html.match(/data-slot="list-row-link"/g)?.length).toBe(1);
  expect(html).toContain('href="/people/author"');
  expect(html).toContain('relative z-10');
  expect(html).toContain('motion-reduce:before:transition-none');
  expect(html).toContain('[&_button]:min-h-11');

  const headingId = html.match(/<h3 id="([^"]+)" lang="ja"/)?.[1];
  expect(headingId).toBeDefined();
  expect(html).toContain(`aria-labelledby="${headingId}"`);

  const primaryLink = html.match(/<a\b[^>]*data-slot="list-row-link"[^>]*>[\s\S]*?<\/a>/)?.[0];
  expect(primaryLink).toBeDefined();
  expect(primaryLink).not.toMatch(/<(?:a|button|input)\b/);

  const slotOrder = [
    'visual',
    'context',
    'title',
    'metadata',
    'preview',
    'state',
    'actions',
    'trailing',
  ].map((slot) => html.indexOf(`data-content-item-slot="${slot}"`));
  expect(slotOrder.every((position) => position >= 0)).toBe(true);
  expect(slotOrder).toEqual([...slotOrder].sort((left, right) => left - right));

  const plainItem = html.slice(html.indexOf('data-testid="plain-item"'));
  expect(plainItem).not.toContain('data-slot="list-row-link"');
  expect(plainItem).not.toContain('data-content-item-slot="visual"');
  expect(plainItem).not.toContain('data-content-item-slot="state"');
  expect(plainItem).not.toContain('data-content-item-slot="actions"');
  expect(plainItem).not.toContain('data-content-item-slot="trailing"');
});

test('ShelfListRow preserves its selection controls, independent status link, cover ratio and unknown progress', () => {
  const html = renderToStaticMarkup(
    createElement(
      ShelfList,
      null,
      createElement(ShelfListRow, {
        href: '/works/book',
        cover: {
          subject: { id: 'book', title: 'Book', types: ['schema:Book'] },
          cover: null,
          src: () => '',
        },
        title: 'Book',
        status: createElement('a', { href: '/status' }, 'Reading'),
        progress: { value: null, label: 'Progress unknown' },
        stepper: { onStep: () => {}, decreaseLabel: 'Decrease', increaseLabel: 'Increase' },
        labels: { select: 'Select book', menu: 'More actions' },
        selectable: true,
        selected: true,
      }),
    ),
  );

  expect(html.match(/<li\b/g)?.length).toBe(1);
  expect(html.match(/data-slot="list-row-link"/g)?.length).toBe(1);
  expect(html).toContain('<h2');
  expect(html).toContain('href="/works/book"');
  expect(html).toContain('href="/status"');
  expect(html).toContain('aria-label="Select book"');
  expect(html).toContain('aria-checked="true"');
  expect(html).toContain('aria-label="Decrease"');
  expect(html).toContain('aria-label="Increase"');
  expect(html).toContain('w-[72px]');
  expect(html).toContain('sm:w-24');
  expect(html).toContain('style="aspect-ratio:5 / 7"');
  const primaryLink = html.match(/<a\b[^>]*data-slot="list-row-link"[^>]*>[\s\S]*?<\/a>/)?.[0];
  expect(primaryLink).toBeDefined();
  expect(primaryLink).not.toMatch(/<(?:a|button|input)\b/);
  expect(html).toContain('Progress unknown');
  expect(html).not.toContain('aria-label="Progress unknown"');
  expect(html).not.toContain('style="width:0%"');
  expect(html).toContain('line-clamp-2');
  expect(html).toContain('sm:line-clamp-1');
});
