import { afterAll, expect, mock, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createKernelClient } from '@rezics/client';
import * as start from '../.storybook/react-start';
import { shelfHref, shelfSort, validateShelfSearch } from '../src/library/shelf-params';

mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));
afterAll(() => mock.restore());
const { readEntryPage } = await import('../src/library/entries-read');
const { ShelfScoreUnavailable } = await import('../src/library/shelf-view');
const { resolveShelfPresentation } = await import('../src/library/shelf-preferences');

test('priority addresses default to rank 1 first and retain the exact filtered continuation in either direction', () => {
  expect(shelfSort({ orderBy: 'priority' })).toEqual({ orderBy: 'priority', direction: 'asc' });
  for (const direction of ['asc', 'desc'] as const) {
    const address = validateShelfSearch({
      type: 'schema:Book', state: 'reading.arc-1', orderBy: 'priority', direction,
      cursor: 'opaque:+/next?x', layout: 'table', size: 'l', columns: 'title,status',
    });
    expect(address.orderBy).toBe('priority');
    const resolved = resolveShelfPresentation(address, undefined);
    expect(resolved.sort).toEqual({ orderBy: 'priority', direction });
    expect(resolved.search.cursor).toBe(address.cursor);
    const href = shelfHref('zh-Hant', resolved.search);
    expect(href.startsWith('/zh-Hant/library?')).toBe(true);
    expect(validateShelfSearch(Object.fromEntries(new URL(href, 'https://site.test').searchParams))).toEqual(address);
    const html = renderToStaticMarkup(createElement(ShelfScoreUnavailable, { locale: 'en', view: address }));
    expect(html).toContain('data-shelf-priority-state="unavailable"');
    expect(html).toContain('Priority order is not available yet.');
    const links = [...html.matchAll(/href="([^"]+)"/g)].map((match) =>
      new URL(match[1]!.replaceAll('&amp;', '&'), 'https://site.test'));
    const restart = validateShelfSearch(Object.fromEntries(links[0]!.searchParams));
    expect(restart).toEqual({ ...address, cursor: undefined });
    const date = validateShelfSearch(Object.fromEntries(links[1]!.searchParams));
    expect(date).toMatchObject({ type: address.type, state: address.state, layout: address.layout });
    expect(date.orderBy).toBe('lastActivity');
    expect(date.cursor).toBeUndefined();
  }
});

test('unpublished priority input never substitutes dates or another native read', async () => {
  const fetch = mock(() => Promise.resolve(Response.json({ libraryEntries: [], next: null })));
  const client = createKernelClient('https://api.test', { fetch });
  for (const direction of ['asc', 'desc'] as const) {
    await expect(readEntryPage(client, 'Bearer owner', 'original', 'reading.arc-1', 20,
      { orderBy: 'priority', direction }, 'schema:Book')).rejects.toMatchObject({ state: 'priority-unavailable' });
  }
  expect(fetch).not.toHaveBeenCalled();
});
