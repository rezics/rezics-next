import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient } from '@tanstack/react-query';
import { historicalReaderSource } from '../src/threads/historical-reader-provenance';
import { HostedInventoryVisit } from '../src/studio/hosted-inventory';
import { HostedBookInventory } from '../src/studio/workspace';
import type { HostedOwnerInventory } from '../src/studio/hosted-contract';
import { setLocale } from '../src/paraglide/runtime.js';

const accountId = '00000000-0000-8000-8000-000100000001';
async function view(
  crossHome: 'partial' | 'complete' | 'unavailable',
  nextCursor: string | null = null,
  items: HostedOwnerInventory['items'] = [],
) {
  const client = new QueryClient();
  client.setQueryData(['session'], { state: 'signed-in', subject: accountId, csrfToken: 'test' });
  const page: HostedOwnerInventory = {
    scope:
      crossHome === 'unavailable'
        ? { kind: 'same-home', route: 1, crossHome }
        : { kind: 'all-homes', route: 1, crossHome },
    viewer: { accountId, authnEpoch: 1 },
    items,
    nextCursor,
  };
  const visit = new HostedInventoryVisit(
    { listOwn: async () => ({ ok: true, value: page }) },
    historicalReaderSource(client),
    accountId,
  );
  await visit.load();
  setLocale('en', { reload: false });
  const html = () => renderToStaticMarkup(createElement(HostedBookInventory, { visit, locale: 'en' }));
  return {
    html,
    finish: () => {
      visit.dispose();
      client.clear();
    },
  };
}

test('coverage and sparse empty pages are distinct from a complete empty inventory', async () => {
  for (const [coverage, expected] of [
    ['partial', 'Some homes are still being indexed.'],
    ['unavailable', 'Cross-home coverage is unavailable.'],
    ['complete', 'You have no hosted books.'],
  ] as const) {
    const screen = await view(coverage);
    const html = screen.html();
    expect(html).toContain(expected);
    if (coverage !== 'complete') {
      expect(html).toContain('No books are available on this page.');
      expect(html).not.toContain('You have no hosted books.');
      expect(html).toContain('Reopen your books');
    }
    screen.finish();
  }
  const sparse = await view('complete', 'opaque-sparse');
  expect(sparse.html()).toContain('More books');
  expect(sparse.html()).toContain('No books are available on this page.');
  expect(sparse.html()).not.toContain('You have no hosted books.');
  sparse.finish();
});

test('native titles and absent-title labels open the same exact Book with unchanged metadata', async () => {
  const catalogueId = '00000000-0000-8000-8000-000200000001';
  for (const title of [undefined, '', 'Native Book ' + 'x'.repeat(500)]) {
    const screen = await view('complete', null, [
      {
        catalogueId,
        threadId: '00000000-0000-8000-8000-000200000004',
        createdAt: '2026-11-12T12:34:56.123456Z',
        postRevisionId: '00000000-0000-8000-8000-000200000005',
        postVisibility: 'draft',
        headRevisionId: '00000000-0000-8000-8000-000200000002',
        publicationId: null,
        ...(title === undefined ? {} : { title }),
      },
    ]);
    const html = screen.html();
    expect(html).toContain(`>${title ?? `Book · ${catalogueId}`}</a>`);
    expect(html).toContain(`href="/studio?catalogueId=${catalogueId}&amp;ownerAccount=${accountId}&amp;ownerEpoch=1"`);
    expect(html).toContain('Private draft');
    expect(html).toContain('<time dateTime="2026-11-12T12:34:56.123456Z">11/12/2026</time>');
    screen.finish();
  }
});
