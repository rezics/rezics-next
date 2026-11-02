import { describe, expect, mock, test } from 'bun:test';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { readFile } from 'node:fs/promises';
import type { CreatorSalesCaller, CreatorSalesData } from '../src/checkout/creator-sales';
import { creatorSaleFixture, creatorSalesPersonas, creatorSalesStoryPage } from '../src/kernel/fake/creator-sales';
import { websiteRegistrationScopes, websiteRequestedScopes } from '../src/session/website-scopes';

mock.module('cloudflare:workers', () => ({ env: {} }));
mock.module('@tanstack/react-start/server', () => ({
  getRequest: () => new Request('https://site.test'),
  setResponseHeader: () => {},
}));
const {
  creatorSalesAddressLoad,
  loadCreatorSales,
  creatorSalesSearch,
  parseCreatorSalesPage,
  unavailableCreatorSalesCaller,
} = await import('../src/checkout/creator-sales');
const { CreatorSalesPage, creatorSalesHref } = await import('../src/checkout/creator-sales-page');
const { isSignedInPath } = await import('../src/session/guard');
const { operationIsAdmitted } = await import('../src/kernel/exposure');
const { setLocale } = await import('../src/paraglide/runtime.js');
const request = (credential = 'creator') =>
  new Request('https://site.test/en/creator/sales', {
    headers: { authorization: `Bearer ${credential}` },
  });
const page = (sales: unknown[] = [creatorSaleFixture]) => ({ sales, next: null, projectionState: 'ready' });
const render = (data: CreatorSalesData, cursor?: string) =>
  renderToString(
    createElement(CreatorSalesPage, {
      page: data,
      locale: 'en',
      cursor,
    }),
  );

describe("Creator's real private sales history page and statement navigation", () => {
  test('canonical sales stories retain actor, unknown, preparing and actual unavailable route coverage', async () => {
    const story = await readFile(new URL('../src/stories/creator-sales.stories.tsx', import.meta.url), 'utf8');
    expect([...story.matchAll(/export const (\w+): Story/g)].map((match) => match[1])).toEqual([
      'History',
      'SecondPage',
      'Empty',
      'Denied',
      'Unavailable',
      'Error',
      'Stale',
      'Loading',
      'Preparing',
      'Incomplete',
      'UnknownUnit',
      'LongTitle',
      'OtherCreatorSameRoute',
      'OtherCreatorDenied',
      'ActualRoute',
    ]);
    expect(story).toContain('canvasElement.querySelector(\'a[href*="/orders/"]\')');
    expect(story).toContain('findByText(m.creator_sales_unavailable())');
    expect(story).not.toMatch(/viewport|maxWidth|width\??:/);
  });

  test('one bounded current-credential read, signed cursor and same-route creator isolation without account selection', async () => {
    const calls: Parameters<CreatorSalesCaller['get']>[0][] = [];
    const caller: CreatorSalesCaller = {
      async get(input) {
        calls.push(input);
        // Explicit upstream responses, not a substitute for native authorization.
        if (input.headers.authorization === 'Bearer creator')
          return { status: 200, data: page(creatorSalesPersonas.creator.sales) };
        if (input.headers.authorization === 'Bearer other')
          return { status: 200, data: page(creatorSalesPersonas.otherCreator.sales) };
        return { status: 404, data: null };
      },
    };
    const search = creatorSalesSearch({ cursor: 'signed+current/=', creatorAccountId: 'foreign', limit: 100 });
    expect(search).toEqual({ cursor: 'signed+current/=' });
    const own = await loadCreatorSales(caller, request(), {}, search);
    const other = await loadCreatorSales(caller, request('other'), {}, search);
    expect(own).toEqual({ kind: 'ready', ...page(creatorSalesPersonas.creator.sales) });
    expect(other).toEqual({ kind: 'ready', ...page(creatorSalesPersonas.otherCreator.sales) });
    expect(JSON.stringify(other)).not.toContain(creatorSaleFixture.title);
    expect(calls).toEqual(
      ['creator', 'other'].map((credential) => ({
        query: { limit: 20, cursor: 'signed+current/=' },
        headers: { authorization: `Bearer ${credential}` },
      })),
    );
    expect(await loadCreatorSales(caller, request('refused'), {}, search)).toEqual({ kind: 'denied' });
    expect(await loadCreatorSales(caller, new Request('https://site.test/en/creator/sales'), {}, {})).toEqual({
      kind: 'denied',
    });
    expect(calls).toHaveLength(3);
    expect(JSON.stringify(own)).not.toContain('Bearer');
  });

  test('missing native binding, refusal, invalid/stale cursors and failures never become successful empty history', async () => {
    expect(await loadCreatorSales(unavailableCreatorSalesCaller, request(), {}, {})).toEqual({ kind: 'unavailable' });
    for (const [status, kind] of [
      [401, 'denied'],
      [403, 'denied'],
      [404, 'denied'],
      [400, 'error'],
      [409, 'stale'],
      [503, 'unavailable'],
    ] as const) {
      expect(
        await loadCreatorSales(
          {
            async get() {
              return { status, data: page([]) };
            },
          },
          request(),
          {},
          {},
        ),
      ).toEqual({ kind });
    }
    expect(
      await loadCreatorSales(
        {
          async get() {
            throw new Error('source offline');
          },
        },
        request(),
        {},
        {},
      ),
    ).toEqual({ kind: 'unavailable' });
    expect(
      await loadCreatorSales(
        {
          async get() {
            return { status: 202, data: page([]) };
          },
        },
        request(),
        {},
        {},
      ),
    ).toEqual({ kind: 'unavailable' });
    expect(
      await loadCreatorSales(
        {
          async get() {
            return { status: 202, data: { ...page([]), projectionState: 'preparing' } };
          },
        },
        request(),
        {},
        {},
      ),
    ).toEqual({ kind: 'ready', ...page([]), projectionState: 'preparing' });
    const nonString = creatorSalesSearch({ cursor: 3 });
    const longValue = 'x'.repeat(4097);
    const overlong = creatorSalesSearch({ cursor: longValue });
    const reads: unknown[] = [];
    expect(nonString).toEqual({ kind: 'invalid-address' });
    expect(overlong).toEqual({ kind: 'invalid-address', cursor: longValue });
    expect(creatorSalesAddressLoad(nonString, (query) => (reads.push(query), query))).toBeNull();
    expect(creatorSalesAddressLoad(overlong, (query) => (reads.push(query), query))).toBeNull();
    expect(creatorSalesAddressLoad(creatorSalesSearch({ cursor: 'signed+current/=' }), (query) => query)).toEqual({
      cursor: 'signed+current/=',
    });
    expect(reads).toEqual([]);
  });

  test('only the minimal accounting DTO crosses the BFF; malformed pages fail closed and historic units stay unknown', () => {
    const extra = {
      ...creatorSaleFixture,
      buyerEmail: 'secret@example.test',
      library: ['private'],
      creatorAccountId: 'internal',
    };
    const sanitized = parseCreatorSalesPage({ ...page([extra]), count: 100, buyer: 'internal' });
    expect(sanitized).toEqual(page());
    for (const privateValue of ['secret@example.test', 'private', 'internal', 'count'])
      expect(JSON.stringify(sanitized)).not.toContain(privateValue);
    for (const invalid of [
      { ...page(), projectionState: undefined },
      { ...page(), next: '' },
      page([creatorSaleFixture, creatorSaleFixture]),
      page([{ ...creatorSaleFixture, unitAmountMinor: Number.MAX_SAFE_INTEGER + 1 }]),
      page([{ ...creatorSaleFixture, settlement: 'refunded' }]),
      page([{ ...creatorSaleFixture, createdAt: 'invalid' }]),
      page(
        Array.from({ length: 21 }, (_, n) => ({
          ...creatorSaleFixture,
          orderId: `019a2100-0000-7000-8000-${String(n).padStart(12, '0')}`,
        })),
      ),
    ])
      expect(parseCreatorSalesPage(invalid)).toBeNull();
    const historic = parseCreatorSalesPage(
      page([{ ...creatorSaleFixture, moneyUnit: undefined, taxBehavior: undefined }]),
    );
    expect(historic?.sales[0]?.moneyUnit).toBeNull();
    expect(historic?.sales[0]?.taxBehavior).toBeNull();
  });

  test('sales link to existing statements/offers without buyer-order or guessed offer links and keep exact currencies separate', () => {
    setLocale('en', { reload: false });
    const html = render(creatorSalesStoryPage('history'), 'signed-current');
    for (const text of [
      '$12.99',
      '€6.75',
      'Purchase payment recorded',
      'Payment pending',
      'Payment failed',
      'Payment status unknown',
      'does not mean royalties were paid to you',
      'Captured title of a delisted or unavailable offer',
    ])
      expect(html).toContain(text);
    expect(html).toContain('href="/en/creator/statements"');
    expect(html).toContain('href="/en/creator/offers"');
    expect(html).toContain('cursor=story-signed%2Bnext%2F%3D');
    for (const absent of ['/en/orders/', `/en/offers/${creatorSaleFixture.offerId}`, 'Total', 'Withdraw', 'buyerEmail'])
      expect(html).not.toContain(absent);
    expect(html).toContain('data-slot="list-row"');
    expect(render(creatorSalesStoryPage('second-page'))).toContain('¥800');
    const unknown = render(creatorSalesStoryPage('unknown-unit'));
    expect(unknown).toContain('Amount unavailable');
    expect(unknown).not.toContain('$12.99');
    expect(creatorSalesHref('de', 'a+b/=')).toBe('/de/creator/sales?cursor=a%2Bb%2F%3D');
  });

  test('preparing and loading never assert zero or completeness; empty pages and retries preserve their meaning', () => {
    setLocale('en', { reload: false });
    for (const state of ['preparing', 'incomplete', 'loading', 'unavailable', 'denied'] as const) {
      const html = render(creatorSalesStoryPage(state));
      expect(html).not.toContain('No sales recorded yet');
      expect(html).not.toContain('No sales on this page');
    }
    expect(render(creatorSalesStoryPage('preparing'))).toContain('still being prepared');
    expect(render(creatorSalesStoryPage('incomplete'))).toContain(creatorSaleFixture.title);
    expect(render(creatorSalesStoryPage('empty'))).toContain('No sales recorded yet');
    expect(render(creatorSalesStoryPage('empty'), 'current')).toContain('No sales on this page');
    expect(render(creatorSalesStoryPage('unavailable'), 'current')).toContain(
      'href="/en/creator/sales?cursor=current"',
    );
    expect(render(creatorSalesStoryPage('stale'), 'current')).not.toContain(
      'href="/en/creator/sales?cursor=current">Back',
    );
  });

  test('served route, immutable navigation, eight locales and explicit registration/request preserve current consent', async () => {
    const keys = [
      'heading',
      'intro',
      'navigation',
      'paid',
      'pending',
      'failed',
      'unknown',
      'reference',
      'denied',
      'stale',
      'error',
      'loading',
      'unavailable',
      'preparing',
      'restart',
      'page_empty',
      'empty',
      'empty_hint',
      'pagination',
      'next',
    ];
    for (const locale of ['en', 'zh-Hant', 'zh-Hans', 'ja', 'ko', 'de', 'fr', 'es']) {
      expect(isSignedInPath(`/${locale}/creator/sales`)).toBe(true);
      const messages = JSON.parse(await readFile(new URL(`../messages/${locale}.json`, import.meta.url), 'utf8'));
      for (const key of keys) expect(messages[`creator_sales_${key}`]).toBeString();
    }
    const route = await readFile(new URL('../src/routes/creator/sales/index.tsx', import.meta.url), 'utf8');
    const bff = await readFile(new URL('../src/checkout/creator-sales.ts', import.meta.url), 'utf8');
    const root = await readFile(new URL('../src/routes/__root.tsx', import.meta.url), 'utf8');
    expect(route).toContain('beforeLoad: requireSignedIn');
    expect(route).toContain('gcTime: 0');
    expect(route).not.toContain('publicCache: true');
    expect(bff).toContain("setResponseHeader('cache-control', 'private, no-store')");
    for (const id of ['commerce.creator-offers', 'commerce.creator-sales', 'commerce.creator-statements'])
      expect(root).toContain(`id: '${id}'`);
    expect(root).toContain("operation: 'commerce_sale.list'");
    expect(root).toContain('navigation={commerceNavigation}');
    expect(operationIsAdmitted('commerce_sale.list', ['selling'])).toBe(false);
    expect(operationIsAdmitted('commerce_sale.list', ['commerce_sale.list'])).toBe(true);
    const registration = websiteRegistrationScopes(['offer:list', 'commerce_sale:list']);
    expect(registration.filter((scope) => scope === 'commerce_sale:list')).toHaveLength(1);
    expect(websiteRegistrationScopes(['offer:list'])).not.toContain('commerce_sale:list');
    expect(websiteRequestedScopes(registration.join(' '))).toContain('commerce_sale:list');
    expect(websiteRequestedScopes('openid offline_access offer:list')).not.toContain('commerce_sale:list');
    const stack = await readFile(new URL('./native/stack.ts', import.meta.url), 'utf8');
    expect(stack).toContain('websiteRegistrationScopes(actionScopes)');
    expect(stack).toContain("WEBSITE_SCOPES: scopes.join(' ')");
    const signin = await readFile(new URL('../src/session/routes.ts', import.meta.url), 'utf8');
    expect(signin).toContain('scope: websiteRequestedScopes(env.WEBSITE_SCOPES)');
  });
});
