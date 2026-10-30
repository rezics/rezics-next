import { expect, mock, spyOn, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createKernelClient } from '@rezics/client';
import { subjectOfferFixture, subjectOffersStoryPage } from '../src/kernel/fake/subject-offers';
import { mappedEntitlement } from '../src/kernel/fake/entitlements';
import paid from '../src/kernel/recorded/order-paid.json';
import { locales, setLocale } from '../src/paraglide/runtime.js';
import { m } from '../src/paraglide/messages.js';
import type { SubjectOffersApi, SubjectOffersInput } from '../src/checkout/subject-offers';

let request = new Request('https://site.test/en');
const headers = new Headers();
mock.module('cloudflare:workers', () => ({ env: { KERNEL_ORIGIN: 'https://kernel.test' } }));
mock.module('@tanstack/react-start/server', () => ({
  getRequest: () => request,
  setResponseHeader: (name: string, value: string) => headers.set(name, value),
  setResponseStatus: () => {},
}));
const { loadSubjectOffers, nativeSubjectOffersApi, parseSubjectOffersPage, subjectOffersInput } =
  await import('../src/checkout/subject-offers');
const { SubjectOffersView, SubjectOwnedBenefitsRegion, subjectOffersQuery } =
  await import('../src/checkout/subject-offers-region');
const { SubjectPurchaseSlot } = await import('../src/features/pages/subject-slots');
const { FeatureSlotsProvider } = await import('../src/shell/feature-slots');
const { subjectPurchaseRegions } = await import('../src/checkout/subject-purchase');
const { loadOffer } = await import('../src/checkout/offer.server');
const { OfferPage } = await import('../src/checkout/offer-page');
const { startCheckout } = await import('../src/checkout/start');
const { loadOrderPage } = await import('../src/checkout/order.server');
const { OrderPage } = await import('../src/checkout/order-page');
const { loadBuyerEntitlements, loadBuyerEntitlement } = await import('../src/checkout/entitlements');
const { EntitlementsPage } = await import('../src/checkout/entitlements-page');
const { EntitlementPage } = await import('../src/checkout/entitlement-page');
const { createNativeEditionApi } = await import('../src/content-editions/edition-api');
const { loadContentEdition } = await import('../src/content-editions/edition-model');

const actor = 'Bearer current-buyer';
const subjectId = subjectOfferFixture.targetSubjectId;
const context = { subjectId, subjectType: 'schema:Book', locale: 'en' };
const input: SubjectOffersInput = { subjectId, locale: 'en', credentialMode: 'session' };
const page = { offers: [subjectOfferFixture], next: 'native-signed-next', projectionState: 'ready' as const };
const currentRequest = (authorization: string | null = actor) =>
  new Request('https://site.test/en', { headers: authorization ? { authorization } : {} });

test('canonical purchase stories preserve signed-in long content separately from signed-out and actual adapter states', async () => {
  const story = await readFile(new URL('../src/stories/subject-purchase.stories.tsx', import.meta.url), 'utf8');
  expect([...story.matchAll(/export const (\w+): Story/g)].map((match) => match[1])).toEqual([
    'SignedOut',
    'SignedIn',
    'Pending',
    'Empty',
    'Preparing',
    'PartialPreparing',
    'DeniedSignedIn',
    'Unavailable',
    'CursorError',
    'LongTitle',
    'MappedPriceUnknown',
    'UnknownMapping',
    'ActualAdapterUnavailable',
    'SignedInLongTitle',
  ]);
  expect(story).toContain('<PurchaseStory state="long-title" signedIn />');
  expect(story).toContain("await userEvent.click(view.getByRole('button', { name: m.subject_purchase_next() }))");
  expect(story).toContain("findByRole('link', { name: m.subject_purchase_records() })");
  expect(story).not.toMatch(/viewport|maxWidth|width\??:/);
});

test('Subject benefit entry into the actual offer/checkout/owned benefit journey', async () => {
  setLocale('en', { reload: false });
  const discovery: Parameters<SubjectOffersApi['read']>[0][] = [];
  const api: SubjectOffersApi = {
    async read(call) {
      discovery.push(call);
      return { status: 200, data: page };
    },
  };
  const discovered = await loadSubjectOffers(api, currentRequest(), {}, input);
  expect(discovery).toEqual([{ subjectId, locale: 'en', query: { limit: 10 }, authorization: actor }]);
  const entry = renderToString(createElement(SubjectOffersView, { page: discovered, locale: 'en' }));
  expect(entry).toContain(`href="/en/offers/${subjectOfferFixture.id}"`);
  expect(entry).toContain('$12.99');
  expect(entry).toContain(m.commerce_before_tax());
  expect(entry).not.toContain('/editions/');
  expect(entry).not.toContain('data-idempotency-key');
  await loadSubjectOffers(api, currentRequest(), {}, { ...input, cursor: page.next });
  expect(discovery).toHaveLength(2);
  expect(discovery[1]?.query).toEqual({ limit: 10, cursor: page.next });

  const calls: Request[] = [];
  const fetcher = spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const call = new Request(url, init);
    calls.push(call);
    const path = new URL(call.url).pathname;
    if (path === '/v1/accounts') return Response.json({ accounts: [] });
    expect(call.headers.get('authorization')).toBe(actor);
    if (path === `/v1/offers/${subjectOfferFixture.id}`)
      return Response.json({
        offer: { ...subjectOfferFixture, revision: 7, state: 'active', subject: paid.order.subject },
      });
    if (path === '/v1/orders' && call.method === 'POST')
      return Response.json({ order: { ...paid.order, checkoutUrl: 'https://checkout.stripe.com/c/pay/example' } });
    if (path === `/v1/orders/${paid.order.id}`)
      return Response.json({ order: { ...paid.order, contentEdition: subjectOfferFixture.contentEdition } });
    if (path === '/v1/entitlements') return Response.json({ entitlements: [mappedEntitlement], next: null });
    if (path === `/v1/entitlements/${mappedEntitlement.id}`) return Response.json({ entitlement: mappedEntitlement });
    if (path.startsWith('/v1/contentEditions/')) return Response.json({ code: 'forbidden' }, { status: 403 });
    throw new Error(`Unexpected journey request: ${path}`);
  });
  try {
    request = currentRequest();
    const offer = await loadOffer(subjectOfferFixture.id, 'en');
    expect(offer.revision).toBe(7);
    expect(offer.benefit?.kind).toBe('mapped');
    expect(renderToString(createElement(OfferPage, { offer }))).toContain(m.benefit_fixed_version());
    expect(headers.get('cache-control')).toBe('private, no-store');
    expect(calls[0]?.cache).toBe('no-store');
    expect(calls.every((call) => call.method === 'GET')).toBe(true);
    // Only this explicit existing Checkout command creates a charge intent, using the reviewed revision.
    const checkout = await startCheckout(
      new Request('https://site.test/checkout', {
        method: 'POST',
        headers: { authorization: actor, 'content-type': 'application/json' },
        body: JSON.stringify({
          offerId: offer.id,
          expectedOfferRevision: offer.revision,
          idempotencyKey: offer.idempotencyKey,
        }),
      }),
      {},
    );
    expect(await checkout.json()).toEqual({ checkoutUrl: 'https://checkout.stripe.com/c/pay/example' });
    const creation = calls.find((call) => call.method === 'POST')!;
    expect(await creation.json()).toEqual({ offerId: offer.id, expectedOfferRevision: 7 });
    expect(creation.headers.get('idempotency-key')).toBe(offer.idempotencyKey);
    request = currentRequest();
    const order = await loadOrderPage(paid.order.id, 'en');
    expect(renderToString(createElement(OrderPage, { order }))).toContain(`/en/entitlements/${mappedEntitlement.id}`);
    const client = createKernelClient('https://kernel.test');
    calls.length = 0;
    const owned = await loadBuyerEntitlements(client, currentRequest(), {}, {});
    expect(calls.map((call) => new URL(call.url).pathname)).toEqual(['/v1/entitlements']);
    expect(renderToString(createElement(EntitlementsPage, { page: owned, locale: 'en' }))).toContain(
      `/en/entitlements/${mappedEntitlement.id}`,
    );
    const detail = await loadBuyerEntitlement(client, currentRequest(), {}, mappedEntitlement.id);
    const editionId = subjectOfferFixture.contentEdition!.benefit.resource.id;
    expect(renderToString(createElement(EntitlementPage, { page: detail, locale: 'en' }))).toContain(
      `/en/editions/${editionId}`,
    );
    expect((await loadContentEdition(createNativeEditionApi(client), editionId, actor)).state).toBe('refused');
    expect(calls.filter((call) => call.method === 'POST')).toHaveLength(0);
  } finally {
    fetcher.mockRestore();
  }
});

test('native refusals, preparation, failed discovery and historical unknowns never become no offers or ownership', async () => {
  expect(await loadSubjectOffers(nativeSubjectOffersApi, currentRequest(), {}, input)).toEqual({ kind: 'unavailable' });
  for (const status of [401, 403, 404, 202, 400, 409, 503]) {
    const seen: (string | null)[] = [];
    const result = await loadSubjectOffers(
      {
        async read(call) {
          seen.push(call.authorization);
          return { status, data: null, code: 'native_denial' };
        },
      },
      currentRequest(),
      {},
      input,
    );
    expect(result).toEqual(
      [401, 403, 404].includes(status)
        ? { kind: 'denied', status, code: 'native_denial' }
        : { kind: status === 202 ? 'preparing' : status === 400 || status === 409 ? 'cursor-error' : 'unavailable' },
    );
    expect(seen).toEqual([actor]);
    expect(renderToString(createElement(SubjectOffersView, { page: result, locale: 'en' }))).not.toContain(
      m.subject_purchase_empty(),
    );
  }
  let reads = 0;
  const api: SubjectOffersApi = {
    async read() {
      reads++;
      return { status: 200, data: page };
    },
  };
  expect((await loadSubjectOffers(api, currentRequest(null), {}, input)).kind).toBe('denied');
  expect(reads).toBe(0);
  const cookieRequest = new Request('https://site.test', {
    headers: { cookie: `__Host-rezics_session=${'a'.repeat(43)}` },
  });
  expect((await loadSubjectOffers(api, cookieRequest, {}, { ...input, credentialMode: 'anonymous' })).kind).toBe(
    'unavailable',
  );
  expect(reads).toBe(0);
  for (const invalid of [
    { ...page, count: 1 },
    { ...page, opaqueEntitlementFact: 'secret' },
    { ...page, offers: Array(11).fill(subjectOfferFixture) },
    { ...page, offers: [{ ...subjectOfferFixture, targetSubjectId: paid.order.offerId }] },
    {
      ...page,
      offers: [{ ...subjectOfferFixture, contentEdition: { ...subjectOfferFixture.contentEdition, body: 'secret' } }],
    },
    { ...page, next: 'x'.repeat(4097) },
  ])
    expect(parseSubjectOffersPage(invalid, subjectId)).toBeNull();
  expect(parseSubjectOffersPage({ offers: [], next: null, projectionState: 'ready' }, subjectId)?.offers).toEqual([]);
  expect(parseSubjectOffersPage({ ...page, projectionState: 'preparing' }, subjectId)?.offers).toHaveLength(1);
  const deniedFetch = spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    expect(new Request(url, init).headers.get('authorization')).toBe(actor);
    return Response.json(
      { type: 'https://rezics.com/problems/scope_required', title: 'Scope Required', code: 'scope_required' },
      { status: 401 },
    );
  });
  try {
    request = currentRequest();
    await expect(loadOffer(subjectOfferFixture.id, 'en')).rejects.toMatchObject({
      problem: { status: 401, code: 'scope_required' },
    });
    expect(deniedFetch).toHaveBeenCalledTimes(1);
  } finally {
    deniedFetch.mockRestore();
  }
});

test('session-bound discovery cancels late responses and never shares a previous actor or session cache entry', async () => {
  const client = new QueryClient();
  let finish!: (value: { kind: 'unavailable' }) => void;
  const first = subjectOffersQuery(
    input,
    { subject: 'buyer-a', sessionKey: 'session-a' },
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const old = client.fetchQuery(first).catch(() => undefined);
  await Promise.resolve();
  await client.cancelQueries({ queryKey: first.queryKey, exact: true });
  client.removeQueries({ queryKey: first.queryKey, exact: true });
  finish({ kind: 'unavailable' });
  await old;
  expect(client.getQueryData(first.queryKey)).toBeUndefined();
  for (const viewer of [
    { subject: 'buyer-b', sessionKey: 'session-b' },
    { subject: 'buyer-a', sessionKey: 'new-session' },
  ]) {
    const next = subjectOffersQuery(input, viewer);
    expect(next.queryKey).not.toEqual(first.queryKey);
    expect(client.getQueryData(next.queryKey)).toBeUndefined();
  }
  const anonymous = subjectOffersQuery({ ...input, credentialMode: 'anonymous' }, { subject: null, sessionKey: null });
  expect(anonymous.queryKey).not.toEqual(first.queryKey);
  expect(first.retry).toBe(false);
  expect(first.refetchOnWindowFocus).toBe(false);
  expect(first.refetchOnReconnect).toBe(false);
  expect(first.gcTime).toBe(0);
  expect(() => subjectOffersInput({ ...input, cursor: 'x'.repeat(4097) })).toThrow();
  client.clear();
});

test('all locales retain compact honest discovery, exact review links and a private access-record link with no SSR ownership', () => {
  for (const locale of locales) {
    setLocale(locale, { reload: false });
    for (const state of [
      'ready',
      'pending',
      'empty',
      'preparing',
      'partial-preparing',
      'denied',
      'unavailable',
      'long-title',
      'mapped-price-unknown',
      'unknown-mapping',
    ] as const) {
      const html = renderToString(createElement(SubjectOffersView, { page: subjectOffersStoryPage(state), locale }));
      expect(html).toContain(m.subject_purchase_heading());
      expect(html).not.toContain('minor');
      expect(html).not.toContain('sha256');
      expect(html).not.toContain('opaqueEntitlement');
      expect(html).not.toContain(subjectOfferFixture.contentEdition!.benefit.version.revisionId);
      expect(html).not.toContain(subjectOfferFixture.contentEdition!.benefit.version.sha256);
      if (state === 'mapped-price-unknown') {
        expect(html).toContain(m.subject_purchase_price_unknown());
        expect(html).not.toContain(m.commerce_before_tax());
        expect(html).toContain(m.benefit_fixed_version());
      }
      if (state === 'unknown-mapping') expect(html).not.toContain(m.benefit_acquisition());
    }
    expect(renderToString(createElement(SubjectOwnedBenefitsRegion, { ...context, locale }))).toContain(
      `href="/${locale}/entitlements"`,
    );
    const client = new QueryClient();
    client.setQueryData(['session'], { state: 'signed-in', subject: 'buyer-a', csrfToken: 'session-a' });
    const ssr = renderToString(
      createElement(
        QueryClientProvider,
        { client },
        createElement(FeatureSlotsProvider, {
          subjectPurchase: subjectPurchaseRegions,
          children: createElement(SubjectPurchaseSlot, { context: { ...context, locale } }),
        }),
      ),
    );
    expect(ssr).toContain(m.subject_purchase_pending());
    expect(ssr).not.toContain('/entitlements');
    expect(ssr).not.toContain('buyer-a');
    expect(ssr).not.toContain('session-a');
    expect(client.getQueryCache().findAll({ queryKey: ['subject-offers'] })).toHaveLength(0);
    client.clear();
  }
  setLocale('en', { reload: false });
});
