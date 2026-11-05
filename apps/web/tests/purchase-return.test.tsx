import { expect, test } from 'bun:test';
import { dirname } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { OrdersPage } from '../src/checkout/orders-page';
import { EntitlementsPage } from '../src/checkout/entitlements-page';
import { EntitlementPage } from '../src/checkout/entitlement-page';
import { purchaseHistoryHref, purchaseHistorySearch } from '../src/checkout/purchase-return';
import { mappedEntitlement } from '../src/kernel/fake/entitlements';
import { order } from './factories/buyer-history';
import { m } from '../src/paraglide/messages.js';
import { setLocale } from '../src/paraglide/runtime.js';

const purchaseOrder = { ...order('A'), id: mappedEntitlement.orderId, entitlementId: mappedEntitlement.id };
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
        page={{ orders: [purchaseOrder], next: 'next orders/+=' }}
      />,
    );
    const receipt = orderLinks.find((link) => link.pathname === `/en/orders/${purchaseOrder.id}`)!;
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

test('paired buyer paths stage exact retry targets, branch after Previous and bound retained coordinates', async () => {
  const { BuyerHistoryWindows } = await import('../src/checkout/buyer-history-windows');
  const visit = new BuyerHistoryWindows();
  visit.admitEntry('orders', null);
  visit.admitEntry('entitlements', history.entitlementsCursor);
  const move = (movement: 'next' | 'previous' | 'first', cursor: string | null = null) => {
    const ticket = visit.stage('orders', movement, cursor)!;
    expect(visit.admit(ticket)).toBe(true);
  };
  move('next', history.ordersCursor);
  move('next', 'terminal');
  expect(visit.window('orders').previous).toBe(history.ordersCursor);
  const failed = visit.stage('orders', 'previous')!;
  expect(visit.window('orders').current).toBe('terminal');
  expect(visit.window('orders').pending).toBe(failed);
  expect(visit.stage('orders', 'next', 'unrelated')).toBeUndefined();
  expect(visit.admit(failed)).toBe(true);
  move('next', 'branch');
  expect(visit.window('orders').previous).toBe(history.ordersCursor);
  for (let n = 0; n < 20; n++) move('next', `raw/+?=購入${n}`);
  expect(visit.window('orders').predecessorCount).toBe(8);
  for (let n = 0; n < 8; n++) move('previous');
  expect(visit.window('orders').previous).toBeUndefined();
  expect(visit.stage('orders', 'previous')).toBeUndefined();
  move('first');
  expect(visit.window('orders').current).toBeNull();
  expect(visit.window('entitlements').current).toBe(history.entitlementsCursor);
});

test('direct later entry and cancellation infer nothing; replacement permanently retires both paths and tickets', async () => {
  const { BuyerHistoryWindows } = await import('../src/checkout/buyer-history-windows');
  const visit = new BuyerHistoryWindows();
  visit.admitEntry('orders', history.ordersCursor);
  visit.admitEntry('entitlements', null);
  expect(visit.window('orders').previous).toBeUndefined();
  const canceled = visit.stage('orders', 'first')!;
  visit.cancel(canceled);
  expect(visit.admit(canceled)).toBe(false);
  expect(visit.window('orders').current).toBe(history.ordersCursor);
  const late = visit.stage('orders', 'next', 'late')!;
  const sibling = visit.stage('entitlements', 'next', 'sibling')!;
  visit.retire();
  expect(visit.admit(late)).toBe(false);
  expect(visit.admit(sibling)).toBe(false);
  expect(visit.admitEntry('orders', null)).toBe(false);
  expect(visit.window('orders').pending).toBeUndefined();
  expect(visit.window('entitlements').current).toBeUndefined();
  // Even an equal replacement and A/B/A use fresh instances; they never revive the old visit.
  for (let n = 0; n < 3; n++) {
    const replacement = new BuyerHistoryWindows();
    replacement.admitEntry('orders', history.ordersCursor);
    expect(replacement.window('orders').previous).toBeUndefined();
    replacement.retire();
    expect(visit.admit(late)).toBe(false);
  }
});
