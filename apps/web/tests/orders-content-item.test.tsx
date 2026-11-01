import { expect, test } from 'bun:test';
import { dirname } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { OrdersPage } from '../src/checkout/orders-page';
import type { BuyerOrder, BuyerOrderPage } from '../src/checkout/orders';
import paid from '../src/kernel/recorded/order-paid.json';
import { m } from '../src/paraglide/messages.js';
import { getLocale, setLocale } from '../src/paraglide/runtime.js';

// UNRUN: composed assertions over the actual shared UI; native/browser/visual acceptance remains deferred.
test('Orders use shared items with captured historical money and distinct settlement and entitlement meanings', async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/fr/orders' });
  const previousLocale = getLocale();
  const locale = 'fr';
  const zero: BuyerOrder = {
    ...paid.order,
    title: 'Captured zero-price edition <with notes> & commentary',
    settlement: 'paid',
    entitlementId: null,
    offerRevision: 7,
    currency: 'usd',
    unitAmountMinor: 0,
    moneyUnit: { system: 'stripe-api', exponent: 2, factsVersion: 'stripe-money-v1' },
    taxBehavior: 'exclusive',
    taxCode: 'txcd_10302000',
    amountTaxMinor: 0,
    contentEdition: null,
  };
  const unknown: BuyerOrder = {
    ...zero,
    id: '0192f3a0-6c1e-7b2a-9d4e-000000000002',
    title: 'Captured historical terms',
    entitlementId: paid.order.entitlementId,
    currency: 'jpy',
    unitAmountMinor: 123456,
    moneyUnit: null,
    taxBehavior: null,
    amountTaxMinor: null,
    createdAt: '2026-10-27T23:58:00.000Z',
  };
  const cursor = 'opaque/+?=next&recorded=%25 #注文';
  const page: BuyerOrderPage = { orders: [zero, unknown], next: cursor };

  try {
    setLocale(locale, { reload: false });
    window.document.body.innerHTML = renderToStaticMarkup(<OrdersPage page={page} locale={locale} />);
    const rows = [...window.document.querySelectorAll('ul > li[data-order-row]')];
    expect(rows).toHaveLength(2);

    for (const [index, order] of page.orders.entries()) {
      const row = rows[index]!;
      const heading = row.querySelector('h2')!;
      const links = [...row.querySelectorAll('a')];
      expect(row.getAttribute('data-slot')).toBe('list-row');
      expect([
        row.getAttribute('data-order-id'),
        row.getAttribute('data-settlement'),
        row.getAttribute('data-entitlement'),
      ]).toEqual([order.id, order.settlement, order.entitlementId ?? '']);
      expect(heading.textContent).toBe(order.title);
      expect(heading.getAttribute('data-content-item-slot')).toBe('title');
      expect(heading.hidden || heading.classList.contains('sr-only') || heading.hasAttribute('aria-hidden')).toBe(
        false,
      );
      expect(heading.id).not.toBe('');
      expect(links).toHaveLength(1);
      expect(links[0]!.getAttribute('aria-labelledby')).toBe(heading.id);
      expect(links[0]!.getAttribute('href')).toBe(`/${locale}/orders/${order.id}`);
      expect(row.querySelector('li, a a, a button, img')).toBeNull();

      const definitions = [...row.querySelectorAll('[data-content-item-slot="metadata"] dt')].map((term) => [
        term.textContent,
        term.nextElementSibling?.textContent,
      ]);
      expect(definitions).toEqual([
        [m.orders_status_label(), m.orders_status_paid()],
        [m.orders_entitlement_label(), index === 0 ? m.orders_entitlement_none() : m.orders_entitlement_recorded()],
        [
          m.order_ordered_at(),
          new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(new Date(order.createdAt)),
        ],
      ]);
      expect(row.querySelector('time')?.getAttribute('datetime')).toBe(order.createdAt);
    }

    const zeroPrice = rows[0]!.querySelector('[data-content-item-slot="trailing"] p')!;
    expect(zeroPrice.firstChild?.textContent).toBe(
      new Intl.NumberFormat(locale, { style: 'currency', currency: 'USD' }).format(0),
    );
    expect(zeroPrice.querySelector('span')?.textContent).toBe(`USD · ${m.commerce_before_tax()}`);
    const unknownPrice = rows[1]!.querySelector('[data-content-item-slot="trailing"] p')!;
    expect(unknownPrice.firstChild?.textContent).toBe(m.statements_amount_unavailable());
    expect(unknownPrice.querySelector('span')?.textContent).toBe(`JPY · ${m.commerce_tax_unknown()}`);

    const continuation = window.document.querySelector(`nav[aria-label="${m.orders_pagination()}"] a`)!;
    expect(continuation.textContent).toBe(m.orders_next());
    expect(continuation.getAttribute('href')).toBe(`/${locale}/orders?cursor=${encodeURIComponent(cursor)}`);
    expect(new URL(continuation.getAttribute('href')!, window.location.href).searchParams.get('cursor')).toBe(cursor);
  } finally {
    setLocale(previousLocale, { reload: false });
    await window.happyDOM.close();
  }
});
