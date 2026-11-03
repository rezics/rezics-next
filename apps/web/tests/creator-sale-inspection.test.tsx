import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { CreatorSaleInspection } from '../src/checkout/creator-sale-inspection';
import { CreatorSalesPage } from '../src/checkout/creator-sales-page';
import { creatorSaleFixture } from '../src/kernel/fake/creator-sales';
import { prepareCreatorSaleReading } from '../src/checkout/creator-sale-reading';
import { setLocale } from '../src/paraglide/runtime.js';

setLocale('en', { reload: false });
const render = (sale = creatorSaleFixture) =>
  renderToStaticMarkup(<CreatorSaleInspection sale={sale} locale="en" close={() => {}} isCurrent={() => true} />);

test('one observation exposes exact recorded terms, full references and all settlement meanings', () => {
  const html = render({ ...creatorSaleFixture, title: 'Long / 作品 '.repeat(100) });
  for (const value of [
    '$12.99',
    'USD',
    '1299',
    creatorSaleFixture.createdAt,
    creatorSaleFixture.orderId,
    creatorSaleFixture.offerId,
    creatorSaleFixture.targetSubjectId,
    'Long / 作品 '.repeat(100),
    'not a payout',
    'own periods and lines',
    'buyer’s order',
  ])
    expect(html).toContain(value);
  expect(html).toContain(`dateTime="${creatorSaleFixture.createdAt}"`);
  expect(html).not.toContain('/orders/');
  expect(render({ ...creatorSaleFixture, moneyUnit: null, taxBehavior: null })).toContain('without guessing');
  expect(render({ ...creatorSaleFixture, moneyUnit: null })).not.toContain('$12.99');
  for (const [settlement, meaning] of [
    ['paid', 'does not establish available funds'],
    ['pending', 'not confirmed earnings'],
    ['failed', 'does not establish a successful payment'],
    ['unknown', 'not treat this sale as confirmed payment'],
  ] as const)
    expect(render({ ...creatorSaleFixture, settlement })).toContain(meaning);
  expect(
    render({
      ...creatorSaleFixture,
      currency: 'jpy',
      unitAmountMinor: 800,
      moneyUnit: { system: 'stripe-api', exponent: 0, factsVersion: 'stripe-money-v1' },
    }),
  ).toContain('¥800');
});

test('at 1/10/20 rows preparation visits each identity once and selection does not rescan or copy pages', () => {
  for (const n of [1, 10, 20]) {
    let identities = 0;
    const sales = Array.from({ length: n }, (_, i) => ({
      ...creatorSaleFixture,
      get orderId() {
        identities++;
        return `sale-${i}`;
      },
    }));
    const page = { kind: 'ready', projectionState: 'ready', sales, next: 'opaque+/=' } as const;
    const index = prepareCreatorSaleReading(page);
    expect(identities).toBe(n);
    expect(index.size).toBe(n);
    for (let i = 0; i < n * 3; i++) expect(index.get(`sale-${i % n}`)).toBe(sales[i % n]);
    expect(identities).toBe(n);
    expect(prepareCreatorSaleReading({ kind: 'denied' }).size).toBe(0);
  }
});

test('native continuation, preparation and stale recovery preserve cursor and empty-page meaning', () => {
  const renderPage = (page: Parameters<typeof CreatorSalesPage>[0]['page'], cursor?: string) =>
    renderToStaticMarkup(<CreatorSalesPage page={page} locale="en" {...(cursor ? { cursor } : {})} />);
  const empty = { kind: 'ready', sales: [], next: 'opaque+/=', projectionState: 'ready' } as const;
  expect(renderPage(empty)).toContain('No sales on this page');
  expect(renderPage({ ...empty, next: null })).toContain('No sales recorded yet');
  expect(renderPage(empty, 'current+/=')).toContain('cursor=opaque%2B%2F%3D');
  expect(renderPage({ ...empty, projectionState: 'preparing' })).not.toContain('No sales');
  expect(renderPage({ kind: 'stale' }, 'current+/=')).toContain('href="/en/creator/sales"');
});
