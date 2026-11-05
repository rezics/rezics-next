import { afterAll, expect, mock, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import * as start from '../.storybook/react-start';
import { shelfHref, shelfSort, validateShelfSearch } from '../src/library/shelf-params';

mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));
afterAll(() => mock.restore());
const { readEntryPage } = await import('../src/library/entries-read');
const { resolveShelfPresentation } = await import('../src/library/shelf-preferences');

test('priority addresses default to rank 1 first and retain the exact filtered continuation in either direction', () => {
  expect(shelfSort({ orderBy: 'priority' })).toEqual({ orderBy: 'priority', direction: 'asc' });
  expect(
    resolveShelfPresentation(
      { orderBy: 'priority', cursor: 'original' },
      { sorts: { all: { field: 'added', direction: 'desc' } } },
    ).sort,
  ).toEqual({ orderBy: 'priority', direction: 'asc' });
  for (const direction of ['asc', 'desc'] as const) {
    const address = validateShelfSearch({
      type: 'schema:Book',
      state: 'reading.arc-1',
      orderBy: 'priority',
      direction,
      cursor: 'opaque:+/next?x',
      layout: 'table',
      size: 'l',
      columns: 'title,status',
    });
    expect(address.orderBy).toBe('priority');
    const resolved = resolveShelfPresentation(address, undefined);
    expect(resolved.sort).toEqual({ orderBy: 'priority', direction });
    expect(resolved.search.cursor).toBe(address.cursor);
    const href = shelfHref('zh-Hant', resolved.search);
    expect(href.startsWith('/zh-Hant/library?')).toBe(true);
    expect(validateShelfSearch(Object.fromEntries(new URL(href, 'https://site.test').searchParams))).toEqual(address);
  }
});

test('priority order sends native direction and continuation and preserves rank ties and missing rows', async () => {
  const requests: URL[] = [];
  const nativeRows = [
    { subjectId: 'rank-tie-b', state: 'reading.arc-1', revision: 2, priority: 7 },
    { subjectId: 'rank-tie-a', state: 'reading.arc-1', revision: 1, priority: 7 },
    { subjectId: 'rank-missing', state: 'reading.arc-1', revision: 3, priority: null },
  ];
  let responseNumber = 0;
  const fetch = mock((input: RequestInfo | URL) => {
    requests.push(new URL(input instanceof Request ? input.url : String(input)));
    const next = responseNumber++ % 2 === 0 ? 'opaque:native-next' : null;
    return Promise.resolve(Response.json({ libraryEntries: nativeRows, next }));
  });
  const client = createKernelClient('https://api.test', { fetch });
  for (const direction of ['asc', 'desc'] as const) {
    const first = await readEntryPage(
      client,
      'Bearer owner',
      undefined,
      'reading.arc-1',
      20,
      { orderBy: 'priority', direction },
      'schema:Book',
    );
    expect(Object.fromEntries(requests.at(-1)!.searchParams)).toEqual({
      view: 'FULL',
      limit: '20',
      state: 'reading.arc-1',
      orderBy: 'priority',
      direction,
      type: 'schema:Book',
    });
    expect(first.next).toBe('opaque:native-next');
    const next = await readEntryPage(
      client,
      'Bearer owner',
      first.next ?? undefined,
      'reading.arc-1',
      20,
      { orderBy: 'priority', direction },
      'schema:Book',
    );
    expect(Object.fromEntries(requests.at(-1)!.searchParams)).toEqual({
      view: 'FULL',
      limit: '20',
      cursor: 'opaque:native-next',
      state: 'reading.arc-1',
      orderBy: 'priority',
      direction,
      type: 'schema:Book',
    });
    expect(next.libraryEntries.map((entry) => [entry.subjectId, entry.priority])).toEqual([
      ['rank-tie-b', 7],
      ['rank-tie-a', 7],
      ['rank-missing', null],
    ]);
    expect(next.next).toBeNull();
  }
  expect(fetch).toHaveBeenCalledTimes(4);
});
