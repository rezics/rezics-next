import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ContentItem } from '@rezics/ui/content-item';
import { ShelfList, ShelfListRow } from '@rezics/ui/shelf-list';

function assertPrimaryAnchorHasNoInteractiveDescendants(anchorMarkup: string) {
  const openingTag = anchorMarkup.match(/^<a\b[^>]*data-slot="list-row-link"[^>]*>/)?.[0];
  expect(openingTag).toBeDefined();
  const closingTagStart = anchorMarkup.lastIndexOf('</a>');
  expect(closingTagStart).toBeGreaterThanOrEqual(openingTag!.length);
  expect(anchorMarkup.slice(openingTag!.length, closingTagStart)).not.toMatch(/<(?:a|button|input)\b/);
}

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
  assertPrimaryAnchorHasNoInteractiveDescendants(primaryLink!);

  const slotOrder = ['visual', 'context', 'title', 'metadata', 'preview', 'state', 'actions', 'trailing'].map((slot) =>
    html.indexOf(`data-content-item-slot="${slot}"`),
  );
  expect(slotOrder.every((position) => position >= 0)).toBe(true);
  expect(slotOrder).toEqual([...slotOrder].sort((left, right) => left - right));

  const plainItem = html.slice(html.indexOf('data-testid="plain-item"'));
  expect(plainItem).not.toContain('data-slot="list-row-link"');
  expect(plainItem).not.toContain('data-content-item-slot="visual"');
  expect(plainItem).not.toContain('data-content-item-slot="state"');
  expect(plainItem).not.toContain('data-content-item-slot="actions"');
  expect(plainItem).not.toContain('data-content-item-slot="trailing"');
});

test('ContentItem names supplied primary summaries without replacing the visible heading or independent controls', () => {
  const summary = 'A reply from Momo. Momo. Reply. Unread. Thursday, October 29, 2026 at 10:00:00 AM UTC';
  const html = renderToStaticMarkup(
    createElement(
      'ul',
      null,
      createElement(ContentItem, {
        title: 'A reply from Momo',
        href: '/threads/one',
        primaryLinkLabel: summary,
        metadata: createElement('a', { href: '/people/momo' }, 'Momo'),
        actions: createElement('button', { type: 'button' }, 'Mark read'),
        'data-testid': 'summary-item',
      }),
      createElement(ContentItem, {
        title: 'A default title',
        href: '/works/default',
        'data-testid': 'default-item',
      }),
      createElement(ContentItem, {
        title: 'A whitespace fallback title',
        href: '/works/fallback',
        primaryLinkLabel: ' \n\t ',
        'data-testid': 'fallback-item',
      }),
      createElement(ContentItem, {
        title: 'A heading without a destination',
        primaryLinkLabel: 'A hidden announcement must not be created',
        context: 'Supplied plain summary context',
        'data-testid': 'plain-item',
      }),
    ),
  );

  const row = (testId: string) => {
    const rendered = html.match(new RegExp(`<li\\b[^>]*data-testid="${testId}"[^>]*>[\\s\\S]*?<\\/li>`));
    expect(rendered).toBeDefined();
    return rendered![0];
  };
  const primaryLink = (renderedRow: string) => {
    const rendered = renderedRow.match(/<a\b[^>]*data-slot="list-row-link"[^>]*>[\s\S]*?<\/a>/);
    expect(rendered).toBeDefined();
    return rendered![0];
  };

  const summaryRow = row('summary-item');
  const summaryLink = primaryLink(summaryRow);
  expect(summaryLink).toContain(`aria-label="${summary}"`);
  expect(summaryLink).not.toContain('aria-labelledby=');
  assertPrimaryAnchorHasNoInteractiveDescendants(summaryLink);
  expect(summaryRow).toContain('<h2');
  expect(summaryRow).toContain('A reply from Momo');
  expect(summaryRow).toContain('href="/people/momo"');
  expect(summaryRow).toContain('Mark read');

  for (const testId of ['default-item', 'fallback-item']) {
    const renderedRow = row(testId);
    const renderedLink = primaryLink(renderedRow);
    expect(renderedLink).not.toContain('aria-label=');
    expect(renderedLink).toMatch(/aria-labelledby="[^\"]+"/);
  }

  const plainRow = row('plain-item');
  expect(plainRow).not.toContain('data-slot="list-row-link"');
  expect(plainRow).not.toContain('aria-label=');
  expect(plainRow).toContain('<h2');
  expect(plainRow).toContain('A heading without a destination');
  expect(plainRow).toContain('Supplied plain summary context');
});

test('ContentItem layers native independent controls per slot and keeps plain and unavailable rows intact', () => {
  const html = renderToStaticMarkup(
    createElement(
      'ul',
      null,
      createElement(ContentItem, {
        title: 'A work with independent controls',
        href: '/works/independent',
        visual: createElement(
          'div',
          null,
          createElement('a', { href: '/people/artist', 'aria-label': 'Artist profile' }, 'Artist'),
          createElement('button', { type: 'button', 'aria-label': 'Visual options' }, 'Options'),
        ),
        context: createElement(
          'div',
          null,
          createElement('a', { href: '/series/stars' }, 'The Stars series'),
          createElement('button', { type: 'button', 'aria-label': 'Follow the series' }, 'Follow'),
        ),
        metadata: createElement('a', { href: '/people/editor' }, 'Editor'),
        preview: createElement(
          'div',
          null,
          createElement('p', null, 'Plain preview excerpt.'),
          createElement(
            'details',
            null,
            createElement('summary', null, 'Show complete note'),
            createElement('p', null, 'The complete supplied note.'),
            createElement(
              'form',
              { action: '/annotations', method: 'post' },
              createElement(
                'label',
                null,
                createElement('input', { type: 'checkbox', name: 'keep-private' }),
                ' Keep this note private',
              ),
              createElement(
                'select',
                { 'aria-label': 'Note visibility', defaultValue: 'private' },
                createElement('option', { value: 'private' }, 'Private'),
                createElement('option', { value: 'shared' }, 'Shared'),
              ),
              createElement('label', null, 'Personal note', createElement('textarea', { name: 'note' })),
              createElement('button', { type: 'submit' }, 'Save note'),
              createElement('a', { href: '/works/source' }, 'Open source'),
            ),
          ),
        ),
        state: createElement('a', { href: '/status', 'aria-label': 'Reading status' }, 'Reading'),
        actions: createElement('button', { type: 'button', 'aria-label': 'Save work' }, 'Save'),
        trailing: createElement('button', { type: 'button', 'aria-label': 'More actions' }, 'More'),
        'data-testid': 'independent-item',
      }),
      createElement(ContentItem, {
        title: 'A plain preview row',
        href: '/works/plain',
        preview: 'Plain preview text stays in the row.',
        'data-testid': 'plain-preview-item',
      }),
      createElement(ContentItem, {
        title: 'An unavailable item',
        context: 'No destination is available.',
        'data-testid': 'unavailable-item',
      }),
    ),
  );

  const row = (testId: string) => {
    const rendered = html.match(new RegExp(`<li\\b[^>]*data-testid="${testId}"[^>]*>[\\s\\S]*?<\\/li>`));
    expect(rendered).toBeDefined();
    return rendered![0];
  };
  const slotOpening = (renderedRow: string, slot: string) => {
    const opening = renderedRow.match(new RegExp(`<[^>]*data-content-item-slot="${slot}"[^>]*>`));
    expect(opening).toBeDefined();
    return opening![0];
  };

  const controlledRow = row('independent-item');
  const independentPrimaryLink = controlledRow.match(/<a\b[^>]*data-slot="list-row-link"[^>]*>[\s\S]*?<\/a>/)?.[0];
  expect(independentPrimaryLink).toBeDefined();
  assertPrimaryAnchorHasNoInteractiveDescendants(independentPrimaryLink!);

  const raisedSelectors = [
    '[&_a]:relative',
    '[&_a]:z-10',
    '[&_button]:relative',
    '[&_button]:z-10',
    '[&_summary]:relative',
    '[&_summary]:z-10',
    '[&_label]:relative',
    '[&_label]:z-10',
    '[&_input]:relative',
    '[&_input]:z-10',
    '[&_select]:relative',
    '[&_select]:z-10',
    '[&_textarea]:relative',
    '[&_textarea]:z-10',
  ];
  for (const slot of ['visual', 'context', 'preview']) {
    const opening = slotOpening(controlledRow, slot);
    for (const selector of raisedSelectors) expect(opening).toContain(selector);
  }
  expect(slotOpening(controlledRow, 'preview')).toContain('[&_summary:focus-visible]:outline-ring');
  expect(slotOpening(controlledRow, 'preview')).toContain('[&_textarea:focus-visible]:outline-ring');

  for (const slot of ['metadata', 'state', 'actions', 'trailing']) {
    expect(slotOpening(controlledRow, slot)).toContain('relative z-10');
  }
  for (const accessibleName of [
    'Artist profile',
    'Visual options',
    'The Stars series',
    'Follow the series',
    'Show complete note',
    'Keep this note private',
    'Note visibility',
    'Personal note',
    'Save note',
    'Open source',
    'Reading status',
    'Save work',
    'More actions',
  ]) {
    expect(controlledRow).toContain(accessibleName);
  }

  const plainPreviewRow = row('plain-preview-item');
  expect(plainPreviewRow).toContain('href="/works/plain"');
  expect(plainPreviewRow).toContain('Plain preview text stays in the row.');
  const plainPreviewOpening = slotOpening(plainPreviewRow, 'preview');
  const plainPreviewClasses = plainPreviewOpening.match(/\bclass="([^"]*)"/)?.[1]?.split(/\s+/) ?? [];
  expect(plainPreviewClasses).not.toContain('relative');
  expect(plainPreviewClasses).not.toContain('z-10');
  expect(plainPreviewOpening).not.toContain('select-none');

  const unavailableRow = row('unavailable-item');
  expect(unavailableRow).not.toContain('data-slot="list-row-link"');
  expect(unavailableRow).toContain('<h2');
  expect(unavailableRow).toContain('No destination is available.');
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
  assertPrimaryAnchorHasNoInteractiveDescendants(primaryLink!);
  expect(html).toContain('Progress unknown');
  expect(html).not.toContain('aria-label="Progress unknown"');
  expect(html).not.toContain('style="width:0%"');
  expect(html).toContain('line-clamp-2');
  expect(html).toContain('sm:line-clamp-1');
});
