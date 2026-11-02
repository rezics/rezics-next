import { expect, test } from 'bun:test';
import { dirname } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { OrdersPage } from '../src/checkout/orders-page';
import { EntitlementsPage } from '../src/checkout/entitlements-page';
import { EntitlementPage } from '../src/checkout/entitlement-page';
import { purchaseHistoryHref, purchaseHistorySearch } from '../src/checkout/purchase-return';
import { mappedEntitlement } from '../src/kernel/fake/entitlements';
import paid from '../src/kernel/recorded/order-paid.json';
import { m } from '../src/paraglide/messages.js';
import { setLocale } from '../src/paraglide/runtime.js';

const history = { ordersCursor: 'orders/+?= &%#購入', entitlementsCursor: 'benefits/+?= &%#所有' };
const url = (href: string) => new URL(href, 'https://site.test');

test('return positions remain independent, opaque and bounded, including a restart of only one list', () => {
  for (const destination of ['orders', 'entitlements'] as const) {
    const own = destination === 'orders' ? 'ordersCursor' : 'entitlementsCursor';
    const other = destination === 'orders' ? 'entitlementsCursor' : 'ordersCursor';
    const link = url(purchaseHistoryHref('fr', destination, history));
    expect(link.searchParams.get('cursor')).toBe(history[own]);
    expect(link.searchParams.get(other)).toBe(history[other]);
    const restart = url(purchaseHistoryHref('fr', destination, { ...history, [own]: undefined }));
    expect(restart.searchParams.has('cursor')).toBe(false);
    expect(restart.searchParams.get(other)).toBe(history[other]);
  }
  expect(purchaseHistorySearch({ ordersCursor: ['foreign'], entitlementsCursor: 'x'.repeat(4097) })).toEqual({});
  expect(purchaseHistorySearch({ ordersCursor: '', entitlementsCursor: history.entitlementsCursor })).toEqual({
    entitlementsCursor: history.entitlementsCursor,
  });
});

test('rendered lists, receipt destinations and benefit return links retain both list positions', async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window();
  setLocale('en', { reload: false });
  const links = (element: React.ReactNode) => {
    window.document.body.innerHTML = renderToStaticMarkup(element);
    return [...window.document.querySelectorAll('a')].map((a) => url(a.getAttribute('href')!));
  };
  try {
    const orderLinks = links(
      <OrdersPage
        locale="en"
        history={history}
        continuation
        page={{ orders: [{ ...paid.order, contentEdition: null }], next: 'next orders/+=' }}
      />,
    );
    const receipt = orderLinks.find((link) => link.pathname === `/en/orders/${paid.order.id}`)!;
    expect(purchaseHistorySearch(Object.fromEntries(receipt.searchParams))).toEqual(history);
    expect(orderLinks.find((link) => link.pathname === '/en/entitlements')!.searchParams.get('cursor')).toBe(
      history.entitlementsCursor,
    );
    const benefitLinks = links(
      <EntitlementsPage
        locale="en"
        history={history}
        continuation
        page={{ kind: 'ready', data: { entitlements: [mappedEntitlement], next: 'next benefits/+=' } }}
      />,
    );
    const benefit = benefitLinks.find((link) => link.pathname === `/en/entitlements/${mappedEntitlement.id}`)!;
    expect(purchaseHistorySearch(Object.fromEntries(benefit.searchParams))).toEqual(history);
    const next = benefitLinks.find((link) => link.searchParams.get('cursor') === 'next benefits/+=')!;
    expect(next.searchParams.get('ordersCursor')).toBe(history.ordersCursor);
    const detail = links(
      <EntitlementPage locale="en" history={history} page={{ kind: 'ready', data: mappedEntitlement }} />,
    );
    expect(detail.find((link) => link.pathname === '/en/entitlements')!.searchParams.get('cursor')).toBe(
      history.entitlementsCursor,
    );
    expect(
      purchaseHistorySearch(
        Object.fromEntries(detail.find((link) => link.pathname === receipt.pathname)!.searchParams),
      ),
    ).toEqual(history);
    const revoked = links(
      <EntitlementPage
        locale="en"
        history={history}
        page={{ kind: 'ready', data: { ...mappedEntitlement, active: false, revokeReason: 'refund' } }}
      />,
    );
    expect(revoked.some((link) => link.pathname.startsWith('/en/editions/'))).toBe(false);
    links(
      <EntitlementsPage
        locale="en"
        history={history}
        continuation
        page={{ kind: 'ready', data: { entitlements: [], next: null } }}
      />,
    );
    expect(window.document.body.textContent).toContain(m.entitlements_page_empty());
    links(<EntitlementsPage locale="en" page={{ kind: 'ready', data: { entitlements: [], next: null } }} />);
    expect(window.document.body.textContent).toContain(m.entitlements_empty());
    const failed = links(
      <EntitlementsPage locale="en" history={history} continuation page={{ kind: 'unavailable' }} />,
    );
    expect(failed.find((link) => link.pathname === '/en/orders')!.searchParams.get('cursor')).toBe(
      history.ordersCursor,
    );
    expect(window.document.body.textContent).toContain(m.entitlements_retry());
    expect(window.document.body.textContent).not.toContain(m.entitlements_empty());
  } finally {
    await window.happyDOM.close();
  }
});
