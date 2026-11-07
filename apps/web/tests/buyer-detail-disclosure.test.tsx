import { afterAll, expect, mock, test } from 'bun:test';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as start from '../.storybook/react-start';
import type { OrderPageData } from '../src/checkout/order';
import { fixedEditionTerms, mappedEntitlement } from '../src/kernel/fake/entitlements';
import { receiptStoryMoney } from '../src/kernel/fake/checkout';
import paid from '../src/kernel/recorded/order-paid.json';

mock.module('cloudflare:workers', () => ({ env: {} }));
mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
const originalSession = { ...(await import('../src/session/query')) };
const originalExposure = { ...(await import('../src/kernel/exposure')) };
mock.module('../src/session/query', () => ({
  ...originalSession,
  useSession: () => ({ state: 'unknown', subject: null, csrfToken: null }),
}));
mock.module('../src/kernel/exposure', () => ({
  ...originalExposure,
  useOperation: () => false,
  Exposure: ({ children }: { children: ReactNode }) => children,
}));
afterAll(() => {
  mock.module('../src/session/query', () => originalSession);
  mock.module('../src/kernel/exposure', () => originalExposure);
  mock.restore();
});

const { OrderPage, applyOrderStatus } = await import('../src/checkout/order-page');
const { EntitlementPage } = await import('../src/checkout/entitlement-page');
const { m } = await import('../src/paraglide/messages.js');
const { getLocale, overwriteGetLocale } = await import('../src/paraglide/runtime.js');
const { Window } = await import('happy-dom');

function receipt(overrides: Partial<OrderPageData> = {}): OrderPageData {
  return {
    ...paid.order,
    settlement: 'paid',
    entitlement: { kind: 'current', active: true },
    canUseBenefit: true,
    money: receiptStoryMoney,
    benefit: { kind: 'mapped', terms: fixedEditionTerms },
    subject: {
      subject: { id: paid.order.targetSubjectId, title: 'A captured reader’s edition', types: [] },
      cover: null,
      href: null,
    },
    ...overrides,
  };
}

async function surface() {
  const previousLocale = getLocale;
  overwriteGetLocale(() => 'en');
  const window = new Window({ url: 'https://site.test/en/orders' });
  const host = window.document.createElement('main');
  window.document.body.append(host);
  return {
    host,
    show(node: ReactNode) {
      host.innerHTML = renderToStaticMarkup(node);
      const ordinary = host.cloneNode(true);
      ordinary.querySelectorAll('details').forEach((details) => details.remove());
      return ordinary;
    },
    async close() {
      overwriteGetLocale(previousLocale);
      await window.happyDOM.close();
    },
  };
}

// Authored UNRUN. These exercise served detail presentation and exact captured facts, not browser/native proof.
// Current-viewer, admission, original mutation operands and late-result cases remain in
// receipt-polling-current-order.test.tsx, order-reconcile.test.ts and entitlements-current-viewer.test.tsx unchanged.
test('Buyer receipt meaning and usable benefit precede closed technical references without changing recorded money', async () => {
  const h = await surface();
  const order = receipt();
  const captured = JSON.stringify(order);
  try {
    const ordinary = h.show(<OrderPage order={order} />);
    expect(ordinary.querySelector('h1')?.textContent).toBe(m.order_paid());
    for (const fact of [
      m.order_receipt(),
      'A captured reader’s edition',
      m.order_ordered_at(),
      m.order_currency(),
      'USD',
      m.order_recorded_price_exclusive(),
      '$12.00',
      m.order_paid_total(),
      '$12.96',
      m.order_recorded_tax(),
      '$0.96',
      m.order_current_access(),
      m.order_entitlement_active(),
      m.benefit_fixed_version(),
      fixedEditionTerms.source.licence,
      m.benefit_open_reader(),
    ])
      expect(ordinary.textContent).toContain(fact);
    expect(ordinary.querySelector(`a[href="/en/entitlements/${order.entitlementId}"]`)?.textContent).toBe(
      m.entitlements_detail_heading(),
    );
    expect(ordinary.textContent).not.toContain(order.id);
    expect(ordinary.textContent).not.toContain(receiptStoryMoney.taxCode!);
    expect(ordinary.textContent).not.toContain(m.order_tax_code());
    const details = h.host.querySelector('details')!;
    expect(details.hasAttribute('open')).toBe(false);
    expect(details.querySelector('summary')?.textContent).toBe(m.order_technical_details());
    expect([...details.querySelectorAll('dt')].map((label) => label.textContent)).toEqual([
      m.order_reference(),
      m.order_tax_code(),
    ]);
    expect([...details.querySelectorAll('dd')].map((fact) => fact.textContent)).toEqual([
      order.id,
      receiptStoryMoney.taxCode!,
    ]);
    expect(h.host.innerHTML.indexOf(m.benefit_open_reader())).toBeLessThan(h.host.innerHTML.indexOf('<details'));
    expect(h.host.innerHTML.indexOf(m.order_open_library())).toBeLessThan(h.host.innerHTML.indexOf('<details'));
    expect(JSON.stringify(order)).toBe(captured);
  } finally {
    await h.close();
  }
});

test('Pending, unknown, failed and unavailable receipts keep uncertainty visible without advertising paid benefit use', async () => {
  const h = await surface();
  try {
    for (const settlement of ['pending', 'unknown', 'failed'] as const) {
      const order = receipt({ settlement, entitlement: { kind: 'unavailable' } });
      const ordinary = h.show(<OrderPage order={order} />);
      expect(ordinary.querySelector('h1')?.textContent).toBe(
        settlement === 'failed' ? m.order_failed() : m.order_pending(),
      );
      expect(ordinary.textContent).toContain(m.order_entitlement_unavailable());
      expect(ordinary.textContent).toContain(settlement === 'failed' ? m.order_failed_detail() : m.order_confirming());
      expect(ordinary.textContent).toContain('$12.00');
      expect(ordinary.textContent).not.toContain(m.order_paid_total());
      expect(ordinary.textContent).not.toContain(m.benefit_open_reader());
      expect(h.host.querySelector('details')?.textContent).toContain(order.id);
      expect(h.host.querySelector('details')?.textContent).toContain(receiptStoryMoney.taxCode!);
    }
    const unknownReceipt = receipt({ entitlement: { kind: 'unavailable' }, canUseBenefit: false });
    delete unknownReceipt.money;
    const ordinary = h.show(<OrderPage order={unknownReceipt} />);
    for (const fact of [
      m.order_paid(),
      m.order_currency_unavailable(),
      m.statements_amount_unavailable(),
      m.order_paid_total_unavailable(),
      m.order_tax_unavailable(),
      m.order_entitlement_unavailable(),
    ])
      expect(ordinary.textContent).toContain(fact);
    expect(ordinary.textContent).not.toContain(m.benefit_open_reader());
    expect(h.host.querySelector('details')?.textContent).not.toContain(m.order_tax_code());
  } finally {
    await h.close();
  }
});

test('A settlement refresh preserves captured financial facts and requires fresh access before use', async () => {
  const h = await surface();
  const pending = receipt({ settlement: 'pending' });
  try {
    const settled = applyOrderStatus(pending, 'paid', pending.offerId);
    expect(pending.settlement).toBe('pending');
    expect(settled.money).toBe(pending.money);
    expect(settled.benefit).toBe(pending.benefit);
    expect(settled.entitlement).toEqual({ kind: 'refresh' });
    expect(settled.canUseBenefit).toBe(false);
    const ordinary = h.show(<OrderPage order={settled} />);
    expect(ordinary.textContent).toContain(m.order_paid());
    expect(ordinary.textContent).toContain('$12.96');
    expect(ordinary.textContent).toContain(m.order_entitlement_refresh());
    expect(ordinary.textContent).toContain(m.order_refresh());
    expect(ordinary.textContent).not.toContain(m.benefit_open_reader());
    expect(h.host.querySelector('details')?.textContent).toContain(pending.id);
    expect(h.host.querySelector('details')?.textContent).toContain(receiptStoryMoney.taxCode!);
  } finally {
    await h.close();
  }
});

test('Active access shows the benefit, grant time and named receipt destination before its exact optional reference', async () => {
  const h = await surface();
  try {
    const ordinary = h.show(<EntitlementPage page={{ kind: 'ready', data: mappedEntitlement }} locale="en" />);
    expect(ordinary.textContent).toContain(m.entitlements_active());
    expect(ordinary.textContent).toContain(m.benefit_fixed_version());
    expect(ordinary.textContent).toContain(m.benefit_open_reader());
    expect(ordinary.querySelector('time')?.getAttribute('datetime')).toBe(mappedEntitlement.grantedAt);
    expect(ordinary.querySelector(`a[href="/en/orders/${mappedEntitlement.orderId}"]`)?.textContent).toBe(
      m.order_receipt(),
    );
    expect(ordinary.textContent).not.toContain(mappedEntitlement.orderId);
    const details = h.host.querySelector('details')!;
    expect(details.hasAttribute('open')).toBe(false);
    expect(details.querySelector('summary')?.textContent).toBe(m.entitlements_technical_details());
    expect(details.querySelector('a')?.textContent).toBe(mappedEntitlement.orderId);
    expect(details.querySelector('a')?.getAttribute('href')).toBe(`/en/orders/${mappedEntitlement.orderId}`);
    expect(details.textContent).not.toContain(m.entitlements_revoke_code());
    expect(h.host.innerHTML.indexOf(m.entitlements_granted())).toBeLessThan(h.host.innerHTML.indexOf('<details'));
  } finally {
    await h.close();
  }
});

test('Refund and dispute consequences are translated ahead of optional exact native reason facts in every locale', async () => {
  const h = await surface();
  try {
    for (const locale of ['en', 'zh-Hant', 'zh-Hans', 'ja', 'ko', 'de', 'fr', 'es'] as const) {
      overwriteGetLocale(() => locale);
      for (const reason of ['refund', 'dispute'] as const) {
        const record = {
          ...mappedEntitlement,
          active: false,
          revokedAt: '2026-10-29T08:31:42.000Z',
          revokeReason: reason,
        };
        const ordinary = h.show(<EntitlementPage page={{ kind: 'ready', data: record }} locale={locale} />);
        expect(ordinary.textContent).toContain(m.entitlements_revoked());
        expect(ordinary.textContent).toContain(
          reason === 'refund' ? m.entitlements_refund() : m.entitlements_dispute(),
        );
        expect(ordinary.textContent).toContain(
          reason === 'refund' ? m.entitlements_refund_consequence() : m.entitlements_dispute_consequence(),
        );
        expect([...ordinary.querySelectorAll('time')].map((time) => time.getAttribute('datetime'))).toEqual([
          record.grantedAt,
          record.revokedAt,
        ]);
        expect(ordinary.textContent).not.toContain(`(${reason})`);
        expect(ordinary.textContent).not.toContain(record.orderId);
        expect(ordinary.textContent).not.toContain(m.benefit_open_reader());
        expect(ordinary.querySelector(`a[href="/${locale}/orders/${record.orderId}"]`)?.textContent).toBe(
          m.order_receipt(),
        );
        const details = h.host.querySelector('details')!;
        expect(details.hasAttribute('open')).toBe(false);
        expect(details.querySelector('summary')?.textContent).toBe(m.entitlements_technical_details());
        expect([...details.querySelectorAll('dt')].map((label) => label.textContent)).toEqual([
          m.order_reference(),
          m.entitlements_revoke_code(),
        ]);
        expect([...details.querySelectorAll('dd')].map((fact) => fact.textContent)).toEqual([
          record.orderId,
          `(${reason})`,
        ]);
      }
    }
  } finally {
    await h.close();
  }
});

test('Unavailable, preparing and historical unknown access never acquire fabricated benefit use or receipt facts', async () => {
  const h = await surface();
  try {
    for (const kind of ['unavailable', 'preparing'] as const) {
      const ordinary = h.show(<EntitlementPage page={{ kind }} locale="en" />);
      expect(ordinary.textContent).toContain(
        kind === 'preparing' ? m.entitlements_preparing() : m.entitlements_unavailable(),
      );
      expect(ordinary.querySelector('button')?.textContent).toBe(m.entitlements_retry());
      expect(ordinary.textContent).not.toContain(m.benefit_open_reader());
      expect(h.host.querySelector('details, a[href*="/orders/"]')).toBeNull();
    }
    const ordinary = h.show(
      <EntitlementPage page={{ kind: 'ready', data: { ...mappedEntitlement, contentEdition: null } }} locale="en" />,
    );
    expect(ordinary.textContent).toContain(m.benefit_details_unknown());
    expect(ordinary.textContent).toContain(m.entitlements_active());
    expect(ordinary.textContent).not.toContain(m.benefit_open_reader());
    expect(ordinary.querySelector(`a[href="/en/orders/${mappedEntitlement.orderId}"]`)?.textContent).toBe(
      m.order_receipt(),
    );
  } finally {
    await h.close();
  }
});
