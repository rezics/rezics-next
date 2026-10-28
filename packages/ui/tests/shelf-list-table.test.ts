import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ShelfList, ShelfListRow } from '@rezics/ui/shelf-list';
import { ShelfTable, ShelfColumnPicker, defaultShelfColumns } from '@rezics/ui/shelf-table';
import { RelativeTime } from '@rezics/ui/relative-time';

const cover = { subject: { id: 'book', title: 'Book', types: ['schema:Book'] }, cover: null, src: () => '' };
const labels = { select: 'Select Book', menu: 'More', decrease: 'Decrease', increase: 'Increase' };
const columns = defaultShelfColumns.map((column) => ({ ...column, label: column.id }));

test('list row renders its cover, one title link, state, actions and mobile layout', () => {
  const row = createElement(ShelfListRow, {
    href: '/book',
    title: 'Book',
    cover,
    meta: 'Author',
    status: 'Reading',
    statusMenu: createElement('span', null, 'Done'),
    progress: { value: 0.5, label: 'Ep 3/6' },
    stepper: { onStep: () => {}, decreaseLabel: 'Decrease', increaseLabel: 'Increase' },
    date: 'Today',
    menu: createElement('span', null, 'Remove'),
    labels,
    selectable: true,
    selected: true,
    onSelectedChange: () => {},
  });
  const html = renderToStaticMarkup(createElement(ShelfList, { children: row }));
  expect(html).toContain('<ul');
  expect(html.match(/<a\b/g)?.length).toBe(1);
  for (const text of [
    'href="/book"',
    'Author',
    'Reading',
    'Ep 3/6',
    'Today',
    'More',
    'Decrease',
    'Increase',
    'aria-checked="true"',
    'w-[72px]',
    'sm:w-24',
    'style="aspect-ratio:5 / 7"',
    'sm:line-clamp-1',
    'line-clamp-2',
    'sm:hidden',
  ])
    expect(html).toContain(text);
  expect(html).not.toContain('divide-y');
  expect(html).not.toContain('h-32');
  expect(html).not.toContain('sm:h-24');
});

test('table renders visible columns, sticky sortable header and caller supplied editors', () => {
  const html = renderToStaticMarkup(
    createElement(ShelfTable, {
      columns,
      rows: [
        {
          id: 'book',
          href: '/book',
          title: 'Book',
          cover,
          status: createElement('button', null, 'Reading'),
          progress: createElement('button', null, 'Ep 3/6'),
          rating: createElement('button', null, 'Rate'),
          selectable: true,
          selected: true,
          onSelectedChange: () => {},
          selectLabel: 'Select Book',
        },
      ],
      sort: { field: 'title', direction: 'asc' },
      onSort: () => {},
    }),
  );
  for (const text of [
    '<table',
    'sticky',
    'aria-sort="ascending"',
    'Book',
    'Reading',
    'Ep 3/6',
    'Rate',
    'w-10',
    'aria-checked="true"',
  ])
    expect(html).toContain(text);
  expect(html).not.toContain('>creator</');
  const picker = renderToStaticMarkup(
    createElement(ShelfColumnPicker, {
      columns,
      onColumnsChange: () => {},
      labels: {
        visible: 'Visible',
        hidden: 'Hidden',
        show: 'Show',
        hide: 'Hide',
        moveUp: 'Move up',
        moveDown: 'Move down',
      },
    }),
  );
  for (const text of ['Visible', 'Hidden', 'creator', 'Move up', 'Move down', 'draggable="true"'])
    expect(picker).toContain(text);
});

test('relative time uses localized calendar days and an exact tooltip', () => {
  const now = new Date('2026-10-27T12:00:00Z');
  const render = (value: string) =>
    renderToStaticMarkup(createElement(RelativeTime, { value, now, locale: 'en-US', timeZone: 'UTC' }));
  expect(render('2026-10-27T00:00:00Z')).toContain('>today</time>');
  expect(render('2026-10-26T00:00:00Z')).toContain('>yesterday</time>');
  expect(render('2026-10-21T00:00:00Z')).toContain('>6 days ago</time>');
  const older = render('2026-10-20T00:00:00Z');
  expect(older).toContain('10/20/26');
  expect(older).toContain('dateTime="2026-10-20T00:00:00.000Z"');
  expect(older).toContain('title=');
});
