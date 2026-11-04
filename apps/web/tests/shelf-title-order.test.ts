import { expect, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { readEntryPage } from '../src/library/entries-read';
import { shelfHref, shelfSort, validateShelfSearch } from '../src/library/shelf-params';
import { resolveShelfPresentation, unsupportedShelfSorts } from '../src/library/shelf-preferences';

test('title URLs retain native intent across filters and display changes, with an explicit first-page restart', () => {
  const search = validateShelfSearch({
    orderBy: 'title',
    direction: 'asc',
    state: 'planned',
    type: 'schema:Book',
    cursor: 'native-page',
    layout: 'table',
    size: 's',
  });
  expect(shelfSort(search)).toEqual({ orderBy: 'title', direction: 'asc' });
  const { cursor: _cursor, ...first } = search;
  const href = shelfHref('en', { ...first, layout: 'list' });
  expect(href).toContain('orderBy=title');
  expect(href).toContain('direction=asc');
  expect(href).toContain('type=schema%3ABook');
  expect(href).not.toContain('cursor=');
  expect(validateShelfSearch({ ...search, label: '01900000-0000-7000-8000-000000000001' }).orderBy).toBeUndefined();
});

test('a title preference cannot select an uninstalled index', () => {
  const shelf = { sorts: { all: { field: 'title' as const, direction: 'asc' as const } } };
  expect(resolveShelfPresentation({}, shelf).sort.orderBy).toBe('lastActivity');
  expect(unsupportedShelfSorts(shelf)).toEqual([{ tab: 'all', field: 'title' }]);
  expect(resolveShelfPresentation({ orderBy: 'title', direction: 'asc' }, shelf).sort.orderBy).toBe('title');
});

test('the unpublished title client remains explicit preparation without fetching or sorting a date page', async () => {
  let calls = 0;
  const client = createKernelClient('https://kernel.invalid', {
    fetch: async () => {
      calls++;
      return new Response('{}', { status: 503 });
    },
  });
  await expect(
    readEntryPage(client, 'Bearer current', undefined, undefined, 20, { orderBy: 'title', direction: 'asc' }),
  ).rejects.toMatchObject({ state: 'preparing' });
  expect(calls).toBe(0);
});
