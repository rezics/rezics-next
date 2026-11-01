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
  createElement('li', { key: 'role' }, 'Writer: ', createElement('a', { href: '/credits/writer' }, 'A. Author')),
  createElement('li', { key: 'character' }, 'Character: ', createElement('a', { href: '/credits/character' }, 'Mira')),
);

function assertPrimaryAnchorHasNoInteractiveDescendants(
  anchorMarkup: string,
  slot: 'cover-card-title' | 'list-row-link',
) {
  const openingTag = anchorMarkup.match(new RegExp(`^<a\\b[^>]*data-slot="${slot}"[^>]*>`))?.[0];
  expect(openingTag).toBeDefined();
  const closingTagStart = anchorMarkup.lastIndexOf('</a>');
  expect(closingTagStart).toBeGreaterThanOrEqual(openingTag!.length);
  expect(anchorMarkup.slice(openingTag!.length, closingTagStart)).not.toMatch(/<(?:a|button|input)\b/);
}

test('CoverCard adapts shared tile semantics in grids and rows while preserving ContentItem row behavior', () => {
  const html = renderToStaticMarkup(
    createElement(
      'main',
      null,
      createElement(CoverGrid, {
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
      }),
      createElement(CoverRow, {
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
      }),
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
  expect(html).toMatch(/<div role="region" aria-label="Continue" tabindex="0" data-slot="cover-row"[^>]*><article\b/);
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
  assertPrimaryAnchorHasNoInteractiveDescendants(rowPrimary!, 'list-row-link');
});

test('Nonselectable qualified credits stretch the existing primary destination while qualifiers and controls remain independent; descendant assertions exclude only their actual root', () => {
  const credit = createElement(
    'ul',
    null,
    createElement(
      'li',
      { key: 'source' },
      'Adapted from ',
      createElement('a', { href: '/sources/book' }, 'Source book'),
    ),
    createElement('li', { key: 'writer' }, 'Writer: ', createElement('a', { href: '/credits/writer' }, 'A. Author')),
    createElement(
      'li',
      { key: 'character' },
      'Character: ',
      createElement('a', { href: '/credits/character' }, 'Mira'),
    ),
  );
  const html = renderToStaticMarkup(
    createElement(CoverCard, {
      href: '/works/credit',
      link: RouterLink,
      title: 'Qualified credit book',
      cover,
      essentialCredit: credit,
      status: { label: 'In library', href: '/library/credit' },
      onSelect: () => {},
      menuEntries: [{ type: 'item', label: 'Edit credit', onSelect: () => {} }],
    }),
  );

  const primary = html.match(/<a\b[^>]*data-slot="cover-card-title"[^>]*>[\s\S]*?<\/a>/)?.[0];
  expect(primary).toBeDefined();
  expect(html.match(/data-slot="cover-card-title"/g)).toHaveLength(1);
  expect(primary).toContain('href="/works/credit"');
  expect(primary).toContain('data-router-link="true"');
  expect(primary).toContain('after:absolute after:inset-0 after:z-[1]');
  assertPrimaryAnchorHasNoInteractiveDescendants(primary!, 'cover-card-title');

  const creditControl = html.match(
    /<div\b(?=[^>]*data-slot="list-row-control")(?=[^>]*class="[^"]*\bz-20\b[^"]*")[^>]*>[\s\S]*?data-slot="cover-card-essential-credit"[\s\S]*?<\/div>/,
  )?.[0];
  expect(creditControl).toBeDefined();
  expect(creditControl).toContain('href="/sources/book"');
  expect(creditControl).toContain('href="/credits/writer"');
  expect(creditControl).toContain('href="/credits/character"');

  const raisedControls = [
    ...html.matchAll(
      /<div\b(?=[^>]*data-slot="list-row-control")(?=[^>]*class="[^"]*\bz-20\b[^"]*")[^>]*>[\s\S]*?<\/div>/g,
    ),
  ].map(([control]) => control);
  expect(raisedControls.some((control) => control.includes('href="/library/credit"'))).toBe(true);

  const selection = html.match(/<button\b(?=[^>]*role="checkbox")(?=[^>]*class="[^"]*\bz-20\b[^"]*")[^>]*>/)?.[0];
  expect(selection).toContain('aria-label="Qualified credit book"');

  const menu = html.match(
    /<span\b(?=[^>]*data-slot="cover-card-actions")(?=[^>]*class="[^"]*\bz-20\b[^"]*")[^>]*>[\s\S]*?<\/span>/,
  )?.[0];
  expect(menu).toContain('aria-label="More actions for Qualified credit book"');
});

test('CoverCard keeps selectable and destination-free qualified titles out of the primary link layer', () => {
  const selectable = renderToStaticMarkup(
    createElement(CoverCard, {
      href: '/works/selectable-credit',
      title: 'Selectable credit book',
      cover,
      essentialCredit: qualifiedCredit,
      selectable: true,
      selected: true,
    }),
  );
  expect(selectable).toContain('aria-pressed="true"');
  expect(selectable).not.toMatch(/<a\b[^>]*href="\/works\/selectable-credit"/);

  const noDestination = renderToStaticMarkup(
    createElement(CoverCard, {
      title: 'Credit without a destination',
      cover,
      essentialCredit: qualifiedCredit,
    }),
  );
  expect(noDestination).toContain('Credit without a destination');
  expect(noDestination).not.toMatch(/<a\b[^>]*data-slot="cover-card-title"/);
});

test('CoverCard layers each supplied native control above the stretched link without raising plain slot content', () => {
  const secondary = createElement(
    'div',
    null,
    createElement('a', { href: '/series/stars' }, 'The Stars series'),
    createElement('button', { type: 'button' }, 'Follow series'),
    createElement(
      'details',
      null,
      createElement('summary', null, 'Read supplied note'),
      createElement('label', null, createElement('input', { type: 'checkbox' }), ' Keep this private'),
      createElement(
        'select',
        { 'aria-label': 'Note visibility', defaultValue: 'private' },
        createElement('option', { value: 'private' }, 'Private'),
      ),
      createElement('textarea', { 'aria-label': 'Personal note' }),
    ),
    createElement('p', null, 'Plain supplied context remains in ordinary flow.'),
  );
  const metadata = createElement(
    'div',
    null,
    createElement('a', { href: '/people/editor' }, 'Editor profile'),
    createElement('button', { type: 'button' }, 'Check metadata'),
  );
  const state = createElement(
    'div',
    null,
    createElement(
      'details',
      null,
      createElement('summary', null, 'Expand status'),
      createElement('p', null, 'Current'),
    ),
    createElement('button', { type: 'button' }, 'Refresh status'),
  );
  const html = renderToStaticMarkup(
    createElement(
      'main',
      null,
      createElement(CoverCard, {
        href: '/works/secondary',
        link: RouterLink,
        title: 'Secondary controls',
        cover,
        secondary,
        state,
      }),
      createElement(CoverCard, {
        href: '/works/metadata',
        title: 'Metadata controls',
        cover,
        meta: metadata,
        state: createElement('a', { href: '/status' }, 'Reading'),
      }),
      createElement(CoverCard, {
        href: '/works/selected',
        title: 'Selected controls',
        cover,
        selectable: true,
        selected: true,
        secondary: createElement('button', { type: 'button' }, 'Independent selection action'),
      }),
      createElement(CoverCard, { title: 'Unavailable destination', cover }),
    ),
  );
  const cards = [...html.matchAll(/<article\b[^>]*data-slot="cover-card"[\s\S]*?<\/article>/gu)].map(([card]) => card!);
  expect(cards).toHaveLength(4);

  const controlSelectors = [
    '[&_a]:relative [&_a]:z-20',
    '[&_button]:relative [&_button]:z-20',
    '[&_summary]:relative [&_summary]:z-20',
    '[&_label]:relative [&_label]:z-20',
    '[&_input]:relative [&_input]:z-20',
    '[&_select]:relative [&_select]:z-20',
    '[&_textarea]:relative [&_textarea]:z-20',
    '[&_a:focus-visible]:outline-ring',
    '[&_button:focus-visible]:outline-ring',
    '[&_summary:focus-visible]:outline-ring',
    '[&_input:focus-visible]:outline-ring',
    '[&_select:focus-visible]:outline-ring',
    '[&_textarea:focus-visible]:outline-ring',
  ];
  const opening = (card: string, slot: string) =>
    card.match(new RegExp(`<div\\b(?=[^>]*data-slot="${slot}")[^>]*>`))?.[0];
  for (const [index, slot] of [
    [0, 'cover-card-secondary'],
    [0, 'cover-card-state-content'],
    [1, 'cover-card-secondary'],
    [1, 'cover-card-state-content'],
    [2, 'cover-card-secondary'],
  ] as const) {
    const slotOpening = opening(cards[index]!, slot);
    expect(slotOpening).toBeDefined();
    for (const selector of controlSelectors) expect(slotOpening).toContain(selector);
    expect(slotOpening).not.toContain('class="relative z-20');
  }

  for (const [card, destination] of [
    [cards[0]!, '/works/secondary'],
    [cards[1]!, '/works/metadata'],
  ] as const) {
    const primary = card.match(/<a\b[^>]*data-slot="cover-card-title"[^>]*>[\s\S]*?<\/a>/)?.[0];
    expect(primary).toContain(`href="${destination}"`);
    assertPrimaryAnchorHasNoInteractiveDescendants(primary!, 'cover-card-title');
  }
  expect(cards[0]).toContain('href="/series/stars"');
  expect(cards[0]).toContain('Follow series');
  expect(cards[0]).toContain('Read supplied note');
  expect(cards[0]).toContain('Keep this private');
  expect(cards[0]).toContain('Note visibility');
  expect(cards[0]).toContain('Personal note');
  expect(cards[0]).toContain('Plain supplied context remains in ordinary flow.');
  expect(cards[1]).toContain('href="/people/editor"');
  expect(cards[1]).toContain('href="/status"');

  expect(cards[2]).toContain('aria-pressed="true"');
  expect(cards[2]).toContain('Independent selection action');
  expect(cards[2]).not.toContain('href="/works/selected"');
  expect(cards[3]).toContain('data-slot="cover-placeholder-title"');
  expect(cards[3]).toContain('Unavailable destination');
  expect(cards[3]).not.toMatch(/<a\b[^>]*data-slot="cover-card-title"/);
});
