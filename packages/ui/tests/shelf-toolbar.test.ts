import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ShelfTabs, ShelfTypeChips, ShelfToolbar } from '@rezics/ui/shelf-toolbar';
import { ShelfEmpty } from '@rezics/ui/shelf-empty';

const labels = {
  sort: 'Sort',
  direction: 'Direction',
  ascending: 'Ascending',
  descending: 'Descending',
  filter: 'Filter',
  clearFilters: 'Clear filters',
  removeFilter: 'Remove filter',
  layout: 'Layout',
  grid: 'Grid',
  list: 'List',
  table: 'Table',
  display: 'Display',
  density: 'Density',
  small: 'Small',
  medium: 'Medium',
  large: 'Large',
  select: 'Select',
  view: 'View',
  items: 'items',
};
test('tabs expose link destinations and filtered counts, and types are a single-select group', () => {
  const tabs = renderToStaticMarkup(
    createElement(ShelfTabs, {
      tabs: [{ value: 'all', label: 'All', count: 10, shown: 3, href: '/all' }],
      value: 'all',
      onValueChange() {},
    }),
  );
  expect(tabs).toContain('href="/all"');
  expect(tabs).toContain('3 / 10');
  expect(tabs).toContain('overflow-x-auto');
  const chips = renderToStaticMarkup(
    createElement(ShelfTypeChips, {
      label: 'Type',
      options: [{ value: 'book', label: 'Books' }],
      value: 'book',
      onValueChange() {},
    }),
  );
  expect(chips).toContain('toggle-group');
  expect(chips).toContain('Books');
});
test('toolbar renders responsive controls and active filter chips', () => {
  const html = renderToStaticMarkup(
    createElement(ShelfToolbar, {
      labels,
      sorts: [{ value: 'title', label: 'Title' }],
      sort: 'title',
      direction: 'asc',
      onSortChange() {},
      filters: createElement('div', null, 'Filter form'),
      active: [{ key: 'type', label: 'Books' }],
      onRemoveFilter() {},
      onClearFilters() {},
      layout: 'grid',
      onLayoutChange() {},
      density: 'medium',
      onDensityChange() {},
      onSelect() {},
      count: 10,
    }),
  );
  for (const value of ['View', 'Select', 'Grid', 'List', 'Table', 'Books', 'Clear filters', '10 items'])
    expect(html).toContain(value);
  expect(html).not.toContain('Search');
  expect(html).toContain('md:');
  expect(html).toContain('sm:');
});
test('empty variants render caller wording and actions', () => {
  for (const kind of ['library', 'tab', 'no-match'] as const) {
    const html = renderToStaticMarkup(
      createElement(ShelfEmpty, {
        kind,
        title: `Title ${kind}`,
        description: 'Description',
        actions: createElement('button', null, 'Next'),
      }),
    );
    expect(html).toContain(`Title ${kind}`);
    expect(html).toContain('Description');
    expect(html).toContain('Next');
  }
});
test('shelf page stories pass accessible browser tests', async () => {
  const run = Bun.spawn(['bun', 'x', 'vitest', 'run', 'src/components/shelf-page.stories.tsx'], {
    cwd: new URL('..', import.meta.url).pathname,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, CI: '1' },
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(run.stdout).text(),
    new Response(run.stderr).text(),
    run.exited,
  ]);
  expect(code, `${stdout}\n${stderr}`).toBe(0);
}, 300_000);
