import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ListRow, ListRowControl, ListRowLink } from '@rezics/ui/list-row';
import { ShelfList, ShelfListRow } from '@rezics/ui/shelf-list';

const cover = { subject: { id: 'book', title: 'Book', types: ['schema:Book'] }, cover: null, src: () => '' };
const labels = { select: 'Select book', menu: 'More actions' };

test('a list row has no divider or border at rest and shows its rounded overlay only on hover with a fine pointer, on keyboard focus inside it and while pressed', () => {
  const html = renderToStaticMarkup(
    createElement(ListRow, {
      children: createElement(ListRowLink, { href: '/book', children: 'Book' }),
    }),
  );
  expect(html).toContain('before:rounded-xl');
  expect(html).toContain('before:bg-foreground/[0.03]');
  expect(html).toContain('[@media(hover:hover)_and_(pointer:fine)]:hover:before:opacity-100');
  expect(html).toContain('has-[:focus-visible]:before:opacity-100');
  expect(html).toContain('active:before:opacity-100');
  expect(html).toContain('before:-inset-1');
  expect(html).toContain('before:opacity-0');
  expect(html).not.toContain('divide-y');
  expect(html).not.toMatch(/(?:^|\s)border(?:-|\s|\")/);
});

test('a click anywhere on a row that is not a control follows the row link; its menu, status, stepper, checkbox and other links keep their own target', () => {
  const shelfRow = createElement(ShelfListRow, {
    key: 'book',
    href: '/book',
    cover,
    title: 'Book',
    status: createElement('a', { href: '/status' }, 'Reading'),
    stepper: { onStep: () => {}, decreaseLabel: 'Decrease', increaseLabel: 'Increase' },
    menu: createElement('span', null, 'Remove'),
    labels,
    selectable: true,
    selected: false,
    onSelectedChange: () => {},
  });
  const html = renderToStaticMarkup(
    createElement(ShelfList, {
      children: [
        shelfRow,
        createElement(
          ListRow,
          { key: 'other' },
          createElement(ListRowLink, { href: '/another', children: 'Another item' }),
          createElement(
            ListRowControl,
            null,
            createElement('input', { type: 'checkbox', 'aria-label': 'Select another' }),
            createElement('button', { type: 'button', 'aria-label': 'More actions' }),
            createElement('a', { href: '/other' }, 'Other item'),
          ),
        ),
      ],
    }),
  );
  expect(html).toContain('href="/book"');
  expect(html).toContain('data-slot="list-row-link"');
  expect(html).toContain('absolute inset-1 z-0');
  expect(html.match(/data-slot="list-row-control"/g)?.length).toBeGreaterThanOrEqual(4);
  expect(html).toContain('href="/status"');
  expect(html).toContain('href="/other"');
  expect(html).toContain('aria-label="Select book"');
  expect(html).toContain('aria-label="Decrease"');
  expect(html).toContain('aria-label="Increase"');
  expect(html).toContain('aria-label="More actions"');
  expect(html).toContain('>Reading</a>');
});

test("a shelf list row's vertical cover is at least 72 px wide on a phone and 96 px from sm up, and the row height follows the cover instead of a fixed height", () => {
  const html = renderToStaticMarkup(
    createElement(ShelfList, {
      children: createElement(ShelfListRow, { href: '/book', cover, title: 'Book', labels }),
    }),
  );
  expect(html).toContain('w-[72px]');
  expect(html).toContain('sm:w-24');
  expect(html).toContain('style="aspect-ratio:5 / 7"');
  expect(html).not.toMatch(/\bh-\d+/);
  expect(html).not.toContain('divide-y');
});
