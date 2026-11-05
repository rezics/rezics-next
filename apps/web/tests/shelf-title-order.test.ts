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
  expect(shelfSort(validateShelfSearch({ orderBy: 'priority' }))).toEqual({ orderBy: 'priority', direction: 'asc' });
  const { cursor: _cursor, ...first } = search;
  const href = shelfHref('en', { ...first, layout: 'list' });
  expect(href).toContain('orderBy=title');
  expect(href).toContain('direction=asc');
  expect(href).toContain('type=schema%3ABook');
  expect(href).not.toContain('cursor=');
  expect(validateShelfSearch({ ...search, label: '01900000-0000-7000-8000-000000000001' }).orderBy).toBeUndefined();
});

test('saved title and score orders are native executable addresses', () => {
  const shelf = { sorts: { all: { field: 'title' as const, direction: 'asc' as const } } };
  expect(resolveShelfPresentation({}, shelf).sort).toEqual({ orderBy: 'title', direction: 'asc' });
  expect(unsupportedShelfSorts(shelf)).toEqual([]);
  expect(resolveShelfPresentation({ orderBy: 'title', direction: 'asc' }, shelf).sort.orderBy).toBe('title');
  const score = { sorts: { all: { field: 'rating' as const, direction: 'asc' as const } } };
  expect(resolveShelfPresentation({}, score).sort.orderBy).toBe('personalScore');
  expect(unsupportedShelfSorts(score)).toEqual([]);
});

test('localized title order reads one native FULL page in the selected direction without reordering it', async () => {
  const requests: Array<{ url: URL; headers: Headers }> = [];
  const nativeRows = [
    { subjectId: 'z-native-first', state: 'planned', revision: 1 },
    { subjectId: 'a-native-second', state: 'planned', revision: 2 },
  ];
  let responseNumber = 0;
  const client = createKernelClient('https://kernel.invalid', {
    headers: { 'accept-language': 'ja-JP, ja;q=0.9' },
    fetch: async (input, init) => {
      requests.push({
        url: new URL(input instanceof Request ? input.url : String(input)),
        headers: new Headers(init?.headers),
      });
      const next = responseNumber++ % 2 === 0 ? 'opaque:title-next' : null;
      return Response.json({ libraryEntries: nativeRows, next });
    },
  });
  for (const direction of ['asc', 'desc'] as const) {
    const first = await readEntryPage(
      client,
      'Bearer current',
      undefined,
      'planned',
      20,
      { orderBy: 'title', direction },
      'schema:Book',
    );
    expect(Object.fromEntries(requests.at(-1)!.url.searchParams)).toEqual({
      view: 'FULL',
      limit: '20',
      state: 'planned',
      orderBy: 'title',
      direction,
      type: 'schema:Book',
    });
    expect(requests.at(-1)!.headers.get('authorization')).toBe('Bearer current');
    expect(requests.at(-1)!.headers.get('accept-language')).toBe('ja-JP, ja;q=0.9');
    expect(first.libraryEntries.map((entry) => entry.subjectId)).toEqual(['z-native-first', 'a-native-second']);
    expect(first.next).toBe('opaque:title-next');
    const next = await readEntryPage(
      client,
      'Bearer current',
      first.next ?? undefined,
      'planned',
      20,
      { orderBy: 'title', direction },
      'schema:Book',
    );
    expect(Object.fromEntries(requests.at(-1)!.url.searchParams)).toEqual({
      view: 'FULL',
      limit: '20',
      cursor: 'opaque:title-next',
      state: 'planned',
      orderBy: 'title',
      direction,
      type: 'schema:Book',
    });
    expect(next.libraryEntries.map((entry) => entry.subjectId)).toEqual(['z-native-first', 'a-native-second']);
    expect(next.next).toBeNull();
    expect(requests.at(-1)!.headers.get('authorization')).toBe('Bearer current');
    expect(requests.at(-1)!.headers.get('accept-language')).toBe('ja-JP, ja;q=0.9');
  }
});
