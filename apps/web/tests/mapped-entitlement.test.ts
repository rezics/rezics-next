import { expect, mock, spyOn, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { fromPlainText } from '@rezics/document';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { capturedBenefit, benefitReaderHref } from '../src/checkout/benefit';
import { EntitlementPage } from '../src/checkout/entitlement-page';
import { EntitlementsPage } from '../src/checkout/entitlements-page';
import { OfferPage } from '../src/checkout/offer-page';
import { OrderPage, applyOrderStatus } from '../src/checkout/order-page';
import { createNativeEditionApi } from '../src/content-editions/edition-api';
import { editionDocumentDigest, loadContentEdition } from '../src/content-editions/edition-model';
import { ContentEditionPage } from '../src/content-editions/edition-view';
import { fixedEditionTerms, mappedEntitlement, activeEntitlement } from '../src/kernel/fake/entitlements';
import paid from '../src/kernel/recorded/order-paid.json';
import { locales, setLocale } from '../src/paraglide/runtime.js';
import { m } from '../src/paraglide/messages.js';

let request: Request;
const headers = new Headers();
mock.module('cloudflare:workers', () => ({ env: { KERNEL_ORIGIN: 'https://kernel.test' } }));
mock.module('@tanstack/react-start/server', () => ({
  getRequest: () => request,
  setResponseHeader: (name: string, value: string) => headers.set(name, value),
}));
const { loadOffer } = await import('../src/checkout/offer.server');
const { loadOrderPage } = await import('../src/checkout/order.server');
const { loadBuyerEntitlement, loadBuyerEntitlements } = await import('../src/checkout/entitlements');

const buyer = 'Bearer current-buyer';
const editionId = fixedEditionTerms.benefit.resource.id;
const detail = (data: typeof mappedEntitlement, locale = 'en') =>
  renderToString(createElement(EntitlementPage, { page: { kind: 'ready', data }, locale }));
const paths = (calls: Request[]) => calls.map((call) => new URL(call.url).pathname);
const newRequest = (path: string, authorization: string | null = buyer) =>
  new Request(`https://site.test/en${path}`, { headers: authorization ? { authorization } : {} });

test('A buyer reviews the actual captured fixed edition and reaches its real guarded reader while legacy unknown or revoked purchases never claim a usable target', async () => {
  setLocale('en', { reload: false });
  const body = fromPlainText('The captured edition body is delivered only by Content.');
  const terms = {
    ...fixedEditionTerms,
    benefit: {
      ...fixedEditionTerms.benefit,
      version: { ...fixedEditionTerms.benefit.version, sha256: await editionDocumentDigest(body) },
    },
  };
  const entitlement = { ...mappedEntitlement, contentEdition: terms };
  const calls: Request[] = [];
  const fetcher = spyOn(globalThis, 'fetch');
  let readerStatus = 200;
  let purchaseTerms: unknown = terms;
  fetcher.mockImplementation(async (input, init) => {
    const call = new Request(input, init);
    calls.push(call);
    const path = new URL(call.url).pathname;
    if (path === `/v1/offers/${paid.order.offerId}`)
      return Response.json({
        offer: {
          id: paid.order.offerId,
          targetSubjectId: terms.targetSubjectId,
          subject: paid.order.subject,
          title: paid.order.title,
          revision: 7,
          currency: 'usd',
          unitAmountMinor: 1299,
          moneyUnit: { system: 'stripe-api', exponent: 2, factsVersion: 'stripe-money-v1' },
          state: 'active',
          contentEdition: purchaseTerms,
        },
      });
    if (path === '/v1/accounts')
      return Response.json({
        accounts: [{ id: terms.creatorAccountId, displayName: 'Mira Okabe', handle: 'mira', state: 'active' }],
      });
    if (call.headers.get('authorization') !== buyer) return Response.json({ code: 'not_found' }, { status: 404 });
    if (path === `/v1/orders/${paid.order.id}`)
      return Response.json({ order: { ...paid.order, contentEdition: terms } });
    if (path === '/v1/entitlements') return Response.json({ entitlements: [entitlement], next: null });
    if (path === `/v1/entitlements/${entitlement.id}`) return Response.json({ entitlement });
    if (path === `/v1/contentEditions/${editionId}` || path === `/v1/contentEditions/${editionId}/revision`) {
      if (readerStatus !== 200) return Response.json({ code: 'reader_refused' }, { status: readerStatus });
      const metadata = {
        editionId,
        editionRevision: '1',
        state: 'published',
        creatorAccountId: terms.creatorAccountId,
        targetSubjectId: terms.targetSubjectId,
        revisionId: terms.benefit.version.revisionId,
        sha256: terms.benefit.version.sha256,
        licence: terms.source.licence,
      };
      return Response.json(
        path.endsWith('/revision')
          ? {
              editionId,
              revisionId: metadata.revisionId,
              sha256: metadata.sha256,
              licence: metadata.licence,
              body,
            }
          : metadata,
      );
    }
    throw new Error(`Unexpected interface request: ${path}`);
  });
  const client = createKernelClient('https://kernel.test');
  try {
    request = newRequest(`/offers/${paid.order.offerId}`, null);
    const offer = await loadOffer(paid.order.offerId, 'en');
    expect(offer.benefit).toEqual({ kind: 'mapped', terms });
    expect(offer.revision).toBe(7);
    expect(offer.creatorName).toBe('Mira Okabe');
    const review = renderToString(createElement(OfferPage, { offer }));
    expect(review).toContain('$12.99');
    expect(review).toContain(m.benefit_fixed_version());
    expect(review).toContain(terms.source.licence);
    expect(review).not.toContain('before tax');
    expect(review).not.toContain(`/editions/${editionId}`);
    expect(calls.every((call) => !call.headers.has('authorization'))).toBe(true);
    expect(headers.get('cache-control')).toBe('private, no-store');

    purchaseTerms = null;
    request = newRequest(`/offers/${paid.order.offerId}`, null);
    const unknownOffer = await loadOffer(paid.order.offerId, 'en');
    expect(unknownOffer.benefit).toEqual({ kind: 'unknown' });
    expect(renderToString(createElement(OfferPage, { offer: unknownOffer }))).toContain('disabled=""');

    request = newRequest(`/orders/${paid.order.id}`);
    const order = await loadOrderPage(paid.order.id, 'en');
    expect(order.benefit).toEqual({ kind: 'mapped', terms });
    const receipt = renderToString(createElement(OrderPage, { order }));
    expect(receipt).toContain(m.order_paid());
    expect(receipt).toContain(`/en/entitlements/${entitlement.id}`);
    expect(receipt).not.toContain(`/editions/${editionId}`);
    expect(applyOrderStatus(order, 'unknown', order.offerId).entitlement).toEqual({ kind: 'refresh' });

    calls.length = 0;
    const list = await loadBuyerEntitlements(client, request, {}, {});
    expect(list.kind).toBe('ready');
    expect(paths(calls)).toEqual(['/v1/entitlements']);
    const listHtml = renderToString(createElement(EntitlementsPage, { page: list, locale: 'en' }));
    expect(listHtml).toContain(`/en/entitlements/${entitlement.id}`);
    expect(listHtml).not.toContain('/editions/');

    calls.length = 0;
    request = newRequest(`/entitlements/${entitlement.id}`);
    const owned = await loadBuyerEntitlement(client, request, {}, entitlement.id);
    expect(owned).toEqual({ kind: 'ready', data: entitlement, creatorName: 'Mira Okabe' });
    expect(paths(calls)).toEqual([`/v1/entitlements/${entitlement.id}`, '/v1/accounts']);
    const ownedHtml = renderToString(createElement(EntitlementPage, { page: owned, locale: 'en' }));
    expect(ownedHtml).toContain(`href="/en/editions/${editionId}"`);
    expect(ownedHtml).toContain(m.benefit_reader_notice());
    expect(ownedHtml).toContain('Mira Okabe');
    expect(ownedHtml).not.toContain(terms.benefit.version.revisionId);
    expect(ownedHtml).not.toContain(terms.benefit.version.sha256);
    expect(ownedHtml).not.toContain(terms.creatorAccountId);
    expect(ownedHtml).not.toContain(terms.saleTermsReference);
    expect(ownedHtml).not.toContain('The captured edition body');

    const link = new URL(benefitReaderHref(capturedBenefit(terms, terms.targetSubjectId), true, 'en')!, request.url);
    calls.length = 0;
    const page = await loadContentEdition(createNativeEditionApi(client), link.pathname.split('/').at(-1)!, buyer);
    expect(page.state).toBe('published');
    if (page.state === 'published') {
      expect(page.metadata.revisionId).toBe(terms.benefit.version.revisionId);
      expect(page.metadata.sha256).toBe(terms.benefit.version.sha256);
    }
    expect(paths(calls)).toEqual([`/v1/contentEditions/${editionId}`, `/v1/contentEditions/${editionId}/revision`]);
    expect(calls.every((call) => call.headers.get('authorization') === buyer)).toBe(true);

    for (const status of [403, 404, 503]) {
      readerStatus = status;
      const refused = await loadContentEdition(createNativeEditionApi(client), editionId, buyer);
      expect(refused.state).toBe(status === 403 ? 'refused' : 'unavailable');
      const html = renderToString(createElement(ContentEditionPage, { editionId, page: refused }));
      expect(html).not.toContain('The captured edition body');
      expect(html).not.toContain('data-slot="document-body"');
      expect(renderToString(createElement(OrderPage, { order }))).toContain(m.order_paid());
    }
    calls.length = 0;
    expect(
      await loadBuyerEntitlement(
        client,
        newRequest(`/entitlements/${entitlement.id}`, 'Bearer other-buyer'),
        {},
        entitlement.id,
      ),
    ).toEqual({ kind: 'denied' });
    expect(paths(calls)).toEqual([`/v1/entitlements/${entitlement.id}`]);
    const otherReader = await loadContentEdition(createNativeEditionApi(client), editionId, 'Bearer other-buyer');
    expect(otherReader.state).toBe('unavailable');
    expect(renderToString(createElement(ContentEditionPage, { editionId, page: otherReader }))).not.toContain(
      'The captured edition body',
    );
    calls.length = 0;
    expect(
      await loadBuyerEntitlement(client, newRequest(`/entitlements/${entitlement.id}`, null), {}, entitlement.id),
    ).toEqual({
      kind: 'denied',
    });
    expect((await loadContentEdition(createNativeEditionApi(client), editionId, null)).state).toBe('refused');
    expect(calls).toHaveLength(0);
  } finally {
    fetcher.mockRestore();
  }
});

test('revoked, refund, dispute, null and absent historical mappings never offer a reader, across all eight locales', async () => {
  const { contentEdition: ignored, ...absent } = activeEntitlement;
  const legacyClient = createKernelClient('https://kernel.test', {
    fetch: (async () => Response.json({ entitlement: absent })) as typeof fetch,
  });
  for (const locale of locales) {
    setLocale(locale, { reload: false });
    expect(detail(mappedEntitlement, locale)).toContain(`href="/${locale}/editions/${editionId}"`);
    for (const record of [
      { ...mappedEntitlement, active: false, revokedAt: '2026-10-30T12:00:00Z', revokeReason: 'refund' as const },
      { ...mappedEntitlement, active: false, revokedAt: '2026-10-30T12:00:00Z', revokeReason: 'dispute' as const },
      activeEntitlement,
    ]) {
      const html = detail(record, locale);
      expect(html).not.toContain('/editions/');
      expect(html).not.toContain('/download');
      expect(html).not.toContain('data-slot="document-body"');
    }
    expect(detail(activeEntitlement, locale)).toContain(m.entitlements_delivery_unknown());
    const historical = await loadBuyerEntitlement(legacyClient, newRequest('/entitlements'), {}, absent.id);
    expect(historical.kind).toBe('ready');
    const html = renderToString(createElement(EntitlementPage, { page: historical, locale }));
    expect(html).toContain(m.entitlements_delivery_unknown());
    expect(html).not.toContain('/editions/');
  }
  setLocale('en', { reload: false });
  expect(
    benefitReaderHref(capturedBenefit(fixedEditionTerms, fixedEditionTerms.targetSubjectId), true, 'invalid'),
  ).toBeNull();
});

test('only the exact closed sanitized mapping is presentable; source IDs, bodies and substitute identities fail closed', async () => {
  expect(capturedBenefit(null, fixedEditionTerms.targetSubjectId)).toEqual({ kind: 'unknown' });
  expect(capturedBenefit(undefined, fixedEditionTerms.targetSubjectId)).toEqual({ kind: 'unknown' });
  const mapped = capturedBenefit(fixedEditionTerms, fixedEditionTerms.targetSubjectId);
  if (mapped.kind !== 'mapped') throw new Error('Expected the exact fixture capture');
  expect(mapped.terms).toBe(fixedEditionTerms);
  for (const value of [
    { ...fixedEditionTerms, source: { ...fixedEditionTerms.source, threadId: 'private-source-thread' } },
    { ...fixedEditionTerms, source: { ...fixedEditionTerms.source, postId: 'private-source-post' } },
    { ...fixedEditionTerms, body: 'private-source-body' },
    { ...fixedEditionTerms, quantity: 2 },
    { ...fixedEditionTerms, acquisition: 'transferable' },
    { ...fixedEditionTerms, targetSubjectId: paid.order.offerId },
    { ...fixedEditionTerms, benefit: { ...fixedEditionTerms.benefit, resource: { route: -1, id: editionId } } },
    { ...fixedEditionTerms, benefit: { ...fixedEditionTerms.benefit, action: 'subject:read' } },
    { ...fixedEditionTerms, benefit: { ...fixedEditionTerms.benefit, version: null } },
  ]) {
    expect(capturedBenefit(value, fixedEditionTerms.targetSubjectId)).toEqual({ kind: 'unavailable' });
    const calls: Request[] = [];
    const transport = createKernelClient('https://kernel.test', {
      fetch: (async (input, init) => {
        calls.push(new Request(input, init));
        return Response.json({ entitlement: { ...mappedEntitlement, contentEdition: value } });
      }) as typeof fetch,
    });
    expect(await loadBuyerEntitlement(transport, newRequest('/entitlements'), {}, mappedEntitlement.id)).toEqual({
      kind: 'unavailable',
    });
    expect(calls).toHaveLength(1);
  }
});
