import { expect, mock, test } from 'bun:test';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { readFile } from 'node:fs/promises';
import { creatorOfferFixture, delistedCreatorOfferFixture } from '../src/kernel/fake/creator-offers';
import type { CreatorOffersCaller } from '../src/checkout/creator-offers';

mock.module('cloudflare:workers', () => ({ env: {} }));
mock.module('@tanstack/react-start/server', () => ({
  getRequest: () => new Request('https://site.test'),
  setResponseHeader: () => {},
}));
const { loadCreatorOffers, creatorOffersSearch, unavailableCreatorOffersCaller } =
  await import('../src/checkout/creator-offers');
const { CreatorOffersPage, creatorOffersHref } = await import('../src/checkout/creator-offers-page');
const { isSignedInPath } = await import('../src/session/guard');
const { getLocale, setLocale } = await import('../src/paraglide/runtime.js');
const request = () =>
  new Request('https://site.test/en/creator/offers', { headers: { authorization: 'Bearer current-creator' } });

test('creator offer stories retain every fixture once and inherit shared viewport selection', async () => {
  const story = await readFile(new URL('../src/stories/creator-offers.stories.tsx', import.meta.url), 'utf8');
  expect([...story.matchAll(/export const (\w+): Story/g)].map((match) => match[1])).toEqual([
    'History',
    'SecondPage',
    'Empty',
    'Denied',
    'Unavailable',
    'Error',
    'Stale',
    'Preparing',
    'LongTitle',
  ]);
  expect(story).toContain("render('long-title')");
  expect(story).toContain("view.queryByRole('link', { name: delistedCreatorOfferFixture.title })");
  expect(story).not.toMatch(/viewport|maxWidth|width\??:/);
});

test('private bounded caller forwards only current credential and signed cursor without owner selection or fanout', async () => {
  const calls: Parameters<CreatorOffersCaller['get']>[0][] = [];
  const caller: CreatorOffersCaller = {
    async get(input) {
      calls.push(input);
      return { status: 200, data: { offers: [creatorOfferFixture, delistedCreatorOfferFixture], next: 'signed-next' } };
    },
  };
  expect(await loadCreatorOffers(caller, request(), {}, { cursor: 'signed-current' })).toEqual({
    kind: 'ready',
    offers: [creatorOfferFixture, delistedCreatorOfferFixture],
    next: 'signed-next',
  });
  expect(calls).toEqual([
    { query: { limit: 20, cursor: 'signed-current' }, headers: { authorization: 'Bearer current-creator' } },
  ]);
  expect(await loadCreatorOffers(caller, new Request('https://site.test/en/creator/offers'), {}, {})).toEqual({
    kind: 'denied',
  });
  expect(calls).toHaveLength(1);
  expect(creatorOffersSearch({ cursor: 'signed', creatorAccountId: 'foreign' })).toEqual({ cursor: 'signed' });
});

test('unavailable binding, failed authority, stale cursor and source errors remain distinct from authorized empty', async () => {
  expect(await loadCreatorOffers(unavailableCreatorOffersCaller, request(), {}, {})).toEqual({ kind: 'unavailable' });
  for (const [status, kind] of [
    [401, 'denied'],
    [403, 'denied'],
    [404, 'denied'],
    [409, 'stale'],
    [400, 'error'],
    [503, 'unavailable'],
  ] as const) {
    expect(
      await loadCreatorOffers(
        {
          async get() {
            return { status, data: null };
          },
        },
        request(),
        {},
        {},
      ),
    ).toEqual({ kind });
  }
  expect(
    await loadCreatorOffers(
      {
        async get() {
          return { status: 200, data: { offers: [], next: null } };
        },
      },
      request(),
      {},
      {},
    ),
  ).toEqual({ kind: 'ready', offers: [], next: null });
  expect(
    await loadCreatorOffers(
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
    await loadCreatorOffers(
      {
        async get() {
          return { status: 200, data: { offers: [{ ...creatorOfferFixture, revision: 0 }], next: null } };
        },
      },
      request(),
      {},
      {},
    ),
  ).toEqual({ kind: 'unavailable' });
  expect(creatorOffersSearch({ cursor: 123 }).addressIssue).toBeDefined();
  expect(creatorOffersSearch({ cursor: 'x'.repeat(4097) }).addressIssue).toBeDefined();
});

test('only sanitized seller fields cross the BFF and unknown historic mapping stays null', async () => {
  const extra = {
    ...creatorOfferFixture,
    creatorAccountId: 'internal-account',
    transactionId: 'internal-transaction',
    contentEdition: {
      ...creatorOfferFixture.contentEdition!,
      source: { licence: 'CC-BY-4.0', threadId: 'native-thread', postId: 'native-post' },
      revisionBody: 'private-content',
    },
  };
  const page = await loadCreatorOffers(
    {
      async get() {
        return { status: 200, data: { offers: [extra, delistedCreatorOfferFixture], next: null } };
      },
    },
    request(),
    {},
    {},
  );
  expect(page.kind).toBe('ready');
  for (const secret of ['internal-account', 'internal-transaction', 'native-thread', 'native-post', 'private-content'])
    expect(JSON.stringify(page)).not.toContain(secret);
  if (page.kind === 'ready') expect(page.offers[1]!.contentEdition).toBeNull();
});

test('seller rows localize separate currencies and retain unknown delisted history without Checkout links', () => {
  const html = renderToString(
    createElement(CreatorOffersPage, {
      locale: 'en',
      cursor: 'signed-current',
      page: {
        kind: 'ready',
        offers: [
          creatorOfferFixture,
          delistedCreatorOfferFixture,
          { ...creatorOfferFixture, id: 'euro', currency: 'eur', unitAmountMinor: 675 },
        ],
        next: 'signed+next/=',
      },
    }),
  );
  for (const price of ['$12.00', '€6.75', '¥800']) expect(html).toContain(price);
  expect(html).not.toContain('1200');
  expect(html).toContain(`href="/en/offers/${creatorOfferFixture.id}"`);
  expect(html).not.toContain(`href="/en/offers/${delistedCreatorOfferFixture.id}"`);
  expect(html).toContain('Unknown benefit mapping');
  expect(html).toContain('Delisted');
  expect(html).not.toContain('Checkout');
  expect(html).toContain('data-slot="list-row"');
  expect(html).toContain('cursor=signed%2Bnext%2F%3D');
  expect(creatorOffersHref('de', 'a+b/=')).toBe('/de/creator/offers?cursor=a%2Bb%2F%3D');
  const unavailable = renderToString(createElement(CreatorOffersPage, { locale: 'en', page: { kind: 'unavailable' } }));
  expect(unavailable).toContain('unavailable');
  expect(unavailable).not.toContain('You have no offers yet');
  expect(unavailable).toContain('role="alert"');
  const closedPublicPage = renderToString(
    createElement(CreatorOffersPage, {
      locale: 'en',
      offerPageAvailable: false,
      page: { kind: 'ready', offers: [creatorOfferFixture], next: null },
    }),
  );
  expect(closedPublicPage).not.toContain(`href="/en/offers/${creatorOfferFixture.id}"`);
});

test('Creator offer history exposes genuine localized keyboard-accessible next and restart navigation links preserving the native signed cursor', () => {
  const originalLocale = getLocale();
  const signedCursor = 'native.signed+next/=%2F';
  function expectNativeLink(html: string, label: string, href: string) {
    const links = [...html.matchAll(/<a\b([^>]*)>([^<]*)<\/a>/g)].filter((match) => match[2] === label);
    expect(links).toHaveLength(1);
    expect(links[0]![1]).toContain(`href="${href}"`);
    // An anchor with href keeps native Tab/Enter behavior without button semantics or focus overrides.
    expect(links[0]![1]).not.toMatch(/\b(?:role|tabindex|aria-disabled)=/i);
  }
  try {
    for (const { locale, next, restart, pagination } of [
      { locale: 'en', next: 'Next page', restart: 'First page', pagination: 'Offer pages' },
      { locale: 'zh-Hans', next: '下一页', restart: '第一页', pagination: '报价分页' },
    ] as const) {
      setLocale(locale, { reload: false });
      const first = renderToString(
        createElement(CreatorOffersPage, {
          locale,
          page: { kind: 'ready', offers: [creatorOfferFixture, delistedCreatorOfferFixture], next: signedCursor },
        }),
      );
      const firstNavigation = first.match(/<nav\b[^>]*>[\s\S]*?<\/nav>/)![0];
      expect(firstNavigation).toContain(`aria-label="${pagination}"`);
      expectNativeLink(firstNavigation, next, `/${locale}/creator/offers?cursor=native.signed%2Bnext%2F%3D%252F`);
      expect(firstNavigation).not.toContain(restart);

      const last = renderToString(
        createElement(CreatorOffersPage, {
          locale,
          cursor: signedCursor,
          page: { kind: 'ready', offers: [delistedCreatorOfferFixture], next: null },
        }),
      );
      const lastNavigation = last.match(/<nav\b[^>]*>[\s\S]*?<\/nav>/)![0];
      expectNativeLink(lastNavigation, restart, `/${locale}/creator/offers`);
      expect(lastNavigation).not.toContain(next);

      for (const kind of ['stale', 'error'] as const) {
        const failed = renderToString(
          createElement(CreatorOffersPage, { locale, cursor: signedCursor, page: { kind } }),
        );
        expectNativeLink(failed, restart, `/${locale}/creator/offers`);
      }
    }
  } finally {
    setLocale(originalLocale, { reload: false });
  }
});

test('served route is guarded and no-store in eight locales with additive offer.list shell navigation', async () => {
  for (const locale of ['en', 'zh-Hant', 'zh-Hans', 'ja', 'ko', 'de', 'fr', 'es']) {
    expect(isSignedInPath(`/${locale}/creator/offers`)).toBe(true);
    const messages = JSON.parse(await readFile(new URL(`../messages/${locale}.json`, import.meta.url), 'utf8'));
    for (const key of ['heading', 'unknown', 'unavailable', 'next', 'delisted'])
      expect(messages[`creator_offers_${key}`]).toBeString();
  }
  const route = await readFile(new URL('../src/routes/creator/offers/index.tsx', import.meta.url), 'utf8');
  const bff = await readFile(new URL('../src/checkout/creator-offers.ts', import.meta.url), 'utf8');
  const root = await readFile(new URL('../src/routes/__root.tsx', import.meta.url), 'utf8');
  expect(route).toContain('beforeLoad: requireSignedIn');
  expect(route).not.toContain('publicCache: true');
  expect(bff).toContain("setResponseHeader('cache-control', 'private, no-store')");
  expect(root).toContain("id: 'commerce.creator-offers'");
  expect(root).toContain("operation: 'offer.list'");
  expect(root).toContain('navigation={commerceNavigation}');
});
