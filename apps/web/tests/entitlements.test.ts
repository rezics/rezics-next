import { expect, mock, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import type { BuyerEntitlement, BuyerEntitlementPage } from '../src/checkout/entitlements';
import { EntitlementsPage } from '../src/checkout/entitlements-page';
import { EntitlementPage } from '../src/checkout/entitlement-page';
import { OrdersPage } from '../src/checkout/orders-page';
import { activeEntitlement, revokedEntitlement } from '../src/kernel/fake/entitlements';
import { isSignedInPath } from '../src/session/guard';
import { setLocale } from '../src/paraglide/runtime.js';

mock.module('cloudflare:workers', () => ({ env: {} }));
const { loadBuyerEntitlements, loadBuyerEntitlement, entitlementSearch } = await import('../src/checkout/entitlements');
setLocale('en', { reload: false });
const request = () =>
  new Request('https://site.test/en/entitlements?accountId=someone-else', {
    headers: { authorization: 'Bearer exact-current-buyer' },
  });
const renderDetail = (page: BuyerEntitlementPage) =>
  renderToString(createElement(EntitlementPage, { page, locale: 'en' }));

function transport(answer: () => Response | Promise<Response>) {
  const calls: Request[] = [];
  const client = createKernelClient('https://kernel.test', {
    fetch: (async (input, init) => {
      calls.push(new Request(input, init));
      return answer();
    }) as typeof fetch,
  });
  return { client, calls };
}

test('Buyers can find current purchased-access records without mistaking history or Library for a benefit', () => {
  const list = renderToString(
    createElement(EntitlementsPage, {
      page: {
        kind: 'ready',
        data: {
          entitlements: [activeEntitlement, { ...revokedEntitlement, id: '01a17a7a-4856-7052-a40c-074c3803e6cf' }],
          next: 'signed+/cursor=',
        },
      },
      locale: 'en',
    }),
  );
  expect(list).toContain('Active record');
  expect(list).toContain('Revoked');
  expect(list).toContain(`/en/entitlements/${activeEntitlement.id}`);
  expect(list).toContain('cursor=signed%2B%2Fcursor%3D');
  const revoked = renderDetail({ kind: 'ready', data: revokedEntitlement });
  expect(revoked).toContain('Revoked');
  expect(revoked.toLowerCase()).toContain(`datetime="${revokedEntitlement.revokedAt}"`.toLowerCase());
  expect(revoked.replace(/<!--.*?-->/g, '')).toContain('(refund)');
  expect(revoked).toContain(`/en/orders/${activeEntitlement.orderId}`);
  expect(revoked).toContain('Benefit delivery is unavailable');
  expect(revoked).not.toMatch(/href="[^"]*(?:library|download)|>Use<|>Download</);
  const orders = renderToString(createElement(OrdersPage, { page: { orders: [], next: null }, locale: 'en' }));
  expect(orders).toContain('href="/en/entitlements"');
});

test('one bounded owner-self read preserves the signed cursor and embedded summaries without row fetches', async () => {
  const { client, calls } = transport(() =>
    Response.json({ entitlements: [activeEntitlement], next: 'opaque.signed' }),
  );
  const page = await loadBuyerEntitlements(client, request(), {}, { cursor: 'signed+/cursor=' });
  expect(page).toEqual({ kind: 'ready', data: { entitlements: [activeEntitlement], next: 'opaque.signed' } });
  expect(calls).toHaveLength(1);
  const call = calls[0]!;
  expect(call.method).toBe('GET');
  expect(call.headers.get('authorization')).toBe('Bearer exact-current-buyer');
  expect(new URL(call.url).pathname).toBe('/v1/entitlements');
  expect([...new URL(call.url).searchParams]).toEqual([
    ['limit', '20'],
    ['cursor', 'signed+/cursor='],
  ]);
  expect(() => entitlementSearch({ cursor: 'x'.repeat(4097) })).toThrow();
  expect(() => entitlementSearch({ cursor: ['one', 'two'] })).toThrow();
});

test('detail uses the exact current viewer; native denial and an unrelated record never disclose access', async () => {
  let response = Response.json({ entitlement: revokedEntitlement });
  const { client, calls } = transport(() => response.clone());
  expect(await loadBuyerEntitlement(client, request(), {}, activeEntitlement.id)).toEqual({
    kind: 'ready',
    data: revokedEntitlement,
  });
  expect(calls[0]!.headers.get('authorization')).toBe('Bearer exact-current-buyer');
  expect(new URL(calls[0]!.url).pathname).toBe(`/v1/entitlements/${activeEntitlement.id}`);
  expect(new URL(calls[0]!.url).search).toBe('');
  response = Response.json({ code: 'not_found' }, { status: 404 });
  expect(await loadBuyerEntitlement(client, request(), {}, activeEntitlement.id)).toEqual({ kind: 'denied' });
  expect(renderDetail({ kind: 'denied' })).not.toContain(activeEntitlement.id);
  response = Response.json({ entitlement: { ...activeEntitlement, id: '01a17a7a-4856-7052-a40c-074c3803e6cf' } });
  expect(await loadBuyerEntitlement(client, request(), {}, activeEntitlement.id)).toEqual({ kind: 'unavailable' });
  const before = calls.length;
  expect(await loadBuyerEntitlements(client, new Request('https://site.test/en/entitlements'), {}, {})).toEqual({
    kind: 'denied',
  });
  expect(calls).toHaveLength(before);
  for (const path of ['/en/entitlements', `/zh-Hant/entitlements/${activeEntitlement.id}`])
    expect(isSignedInPath(path)).toBe(true);
});

test('only a successful empty page is empty; preparation, stale cursor, denial and dependency failure remain distinct', async () => {
  let response = Response.json({ entitlements: [], next: null });
  const { client } = transport(() => response.clone());
  expect(await loadBuyerEntitlements(client, request(), {}, {})).toEqual({
    kind: 'ready',
    data: { entitlements: [], next: null },
  });
  const continuation = renderToString(
    createElement(EntitlementsPage, {
      page: { kind: 'ready', data: { entitlements: [], next: null } },
      locale: 'en',
      continuation: true,
    }),
  );
  expect(continuation).toContain('No records on this page');
  expect(continuation).not.toContain('No purchased access records');
  for (const [status, kind] of [
    [202, 'preparing'],
    [400, 'cursor-error'],
    [409, 'cursor-error'],
    [403, 'denied'],
    [503, 'unavailable'],
  ] as const) {
    response = Response.json({ code: 'test-response' }, { status });
    expect(await loadBuyerEntitlements(client, request(), {}, {})).toEqual({ kind });
    const html = renderToString(createElement(EntitlementsPage, { page: { kind }, locale: 'en' }));
    expect(html).not.toContain('No purchased access records');
  }
  for (const body of [{}, { entitlements: Array(21).fill(activeEntitlement), next: null }]) {
    response = Response.json(body);
    expect(await loadBuyerEntitlements(client, request(), {}, {})).toEqual({ kind: 'unavailable' });
  }
  const offline = transport(() => {
    throw new Error('offline');
  });
  expect(await loadBuyerEntitlements(offline.client, request(), {}, {})).toEqual({ kind: 'unavailable' });
});

test('legacy unknown delivery and undisclosed subjects never become a file licence or a guessed subject link', () => {
  const legacy: BuyerEntitlement = { ...activeEntitlement, summary: null };
  const html = renderDetail({ kind: 'ready', data: legacy });
  expect(html).toContain('Subject unavailable');
  expect(html).toContain('mapped to a specific benefit');
  expect(html).not.toContain(`/subjects/${legacy.targetSubjectId}`);
  expect(html).not.toMatch(/href="[^"]*(?:library|download)|>Use<|>Download</);
  const disclosed = renderDetail({ kind: 'ready', data: activeEntitlement });
  expect(disclosed).toContain(`/en/subjects/${legacy.targetSubjectId}`);
  expect(disclosed).toContain('Viewing the subject does not grant access to its files.');
});
