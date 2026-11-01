import { expect, test } from 'bun:test';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ContentItem } from '@rezics/ui/content-item';
import { CoverCard, CoverGrid, CoverRow, type CoverCardLink } from '@rezics/ui/cover-card';

const subject = { id: 'book', title: 'A book with supplied title', types: ['schema:Book'] };
const cover = { subject, cover: null, src: () => '' };

const RouterLink: CoverCardLink = ({ href, children, ...props }) =>
  createElement('a', { href, ...props, 'data-router-link': 'true' }, children);

const qualifiedCredit: ReactNode = createElement(
  'ul',
  { className: 'flex min-w-0 flex-col gap-1' },
  createElement(
    'li',
    { key: 'role' },
    'Writer: ',
    createElement('a', { href: '/credits/writer' }, 'A. Author'),
  ),
  createElement(
    'li',
    { key: 'character' },
    'Character: ',
    createElement('a', { href: '/credits/character' }, 'Mira'),
  ),
);

test('CoverCard adapts shared tile semantics in grids and rows while preserving ContentItem row behavior', () => {
  const html = renderToStaticMarkup(
    createElement(
      'main',
      null,
      createElement(
        CoverGrid,
        {
          ratio: '2:3',
          children: [
            createElement(CoverCard, {
              key: 'linked',
              href: '/works/book',
              link: RouterLink,
              title: 'A translated book',
              titleLang: 'ja',
              linkLabel: 'Continue A translated book',
              cover,
              status: { label: 'Reading', href: '/library/book' },
              progress: { value: null, label: 'Progress unknown' },
              menuEntries: [{ type: 'item', label: 'Remove', onSelect: () => {} }],
            }),
            createElement(CoverCard, {
              key: 'selected',
              href: '/works/selected',
              title: 'Selected book',
              cover,
              selectable: true,
              selected: true,
              onSelectedChange: () => {},
            }),
          ],
        },
      ),
      createElement(
        CoverRow,
        {
          ratio: '2:3',
          label: 'Continue',
          children: createElement(CoverCard, {
            href: '/works/credit',
            link: RouterLink,
            title: 'Qualified credit book',
            cover,
            essentialCredit: qualifiedCredit,
            onSelect: () => {},
            menuEntries: [{ type: 'item', label: 'Manage credit', onSelect: () => {} }],
          }),
        },
      ),
      createElement(
        'ul',
        null,
        createElement(ContentItem, {
          title: 'A row title',
          titleLang: 'zh-Hant',
          headingLevel: 3,
          href: '/works/row',
          metadata: createElement('a', { href: '/people/author' }, 'Row author'),
          actions: createElement('button', { type: 'button' }, 'Save'),
        }),
      ),
    ),
  );

  expect(html.match(/<article\b[^>]*data-slot="cover-card"/g)).toHaveLength(3);
  expect(html).toContain('<div data-slot="cover-grid"');
  expect(html).toMatch(
    /<div role="region" aria-label="Continue" tabindex="0" data-slot="cover-row"[^>]*><article\b/,
  );
  expect(html).toMatch(
    /<h3\b[^>]*lang="ja"[^>]*><a\b[^>]*href="\/works\/book"[^>]*aria-label="Continue A translated book"[^>]*data-slot="cover-card-title"/,
  );
  expect(html).toContain('data-router-link="true"');
  expect(html).toContain('href="/library/book"');
  expect(html).toContain('aria-pressed="true"');
  expect(html).toContain('role="checkbox" aria-checked="false" aria-label="Qualified credit book"');
  expect(html).toContain('href="/credits/writer"');
  expect(html).toContain('href="/credits/character"');
  expect(html).toContain('Writer: ');
  expect(html).toContain('Character: ');
  expect(html).toContain('Mira');
  expect(html).toContain('aria-label="More actions for A translated book"');
  expect(html).toContain('aria-label="More actions for Qualified credit book"');
  expect(html).toContain('data-slot="cover-card-essential-credit"');
  expect(html).toContain('size-11');
  expect(html).toContain('Progress unknown');
  expect(html).not.toContain('role="progressbar"');

  const primaryEnd = html.indexOf('</a>', html.indexOf('data-slot="cover-card-title"'));
  const statusStart = html.indexOf('data-slot="cover-card-status"');
  expect(primaryEnd).toBeGreaterThan(-1);
  expect(statusStart).toBeGreaterThan(primaryEnd);

  const rowStart = html.indexOf('<li data-slot="list-row"');
  const row = html.slice(rowStart);
  expect(row).toContain('<h3');
  expect(row).toContain('lang="zh-Hant"');
  expect(row).toContain('data-slot="list-row-link"');
  expect(row).toContain('href="/people/author"');
  expect(row).toContain('relative z-10');
  const rowPrimary = row.match(/<a\b[^>]*data-slot="list-row-link"[^>]*>[\s\S]*?<\/a>/)?.[0];
  expect(rowPrimary).toBeDefined();
  expect(rowPrimary).not.toMatch(/<(?:a|button|input)\b/);
});
