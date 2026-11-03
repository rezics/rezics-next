import type { CreatorSale, CreatorSalesData } from '../../checkout/creator-sales';

// Constructed presentation inputs, not native recordings or evidence of sales/authority.
const id = (n: number) => `019a2100-0000-7000-8000-3300${String(n).padStart(8, '0')}`;
export const creatorSaleFixture: CreatorSale = {
  orderId: id(1),
  offerId: id(10),
  targetSubjectId: id(20),
  title: 'A field guide to quiet places — original edition',
  currency: 'usd',
  unitAmountMinor: 1299,
  moneyUnit: { system: 'stripe-api', exponent: 2, factsVersion: 'stripe-money-v1' },
  taxBehavior: 'exclusive',
  settlement: 'paid',
  createdAt: '2026-10-20T09:30:00Z',
};
// These two hypothetical creators share the routing prefix. No account ID belongs in the sales request.
export const creatorSalesPersonas = {
  creator: { accountId: id(100), sales: [creatorSaleFixture] },
  otherCreator: {
    accountId: id(101),
    sales: [{ ...creatorSaleFixture, orderId: id(2), offerId: id(11), title: 'Another creator’s captured sale' }],
  },
};

export type CreatorSalesStory =
  | 'history'
  | 'second-page'
  | 'empty'
  | 'later-empty'
  | 'denied'
  | 'unavailable'
  | 'error'
  | 'stale'
  | 'loading'
  | 'preparing'
  | 'incomplete'
  | 'unknown-unit'
  | 'long-title'
  | 'other-creator';

export function creatorSalesStoryPage(state: CreatorSalesStory): CreatorSalesData {
  if (state === 'denied' || state === 'unavailable' || state === 'error' || state === 'stale' || state === 'loading')
    return { kind: state };
  const preparing = state === 'preparing' || state === 'incomplete';
  return {
    kind: 'ready',
    projectionState: preparing ? 'preparing' : 'ready',
    sales:
      state === 'empty' || state === 'later-empty' || state === 'preparing'
        ? []
        : state === 'other-creator'
          ? creatorSalesPersonas.otherCreator.sales
          : state === 'unknown-unit'
            ? [{ ...creatorSaleFixture, moneyUnit: null, taxBehavior: null }]
            : state === 'second-page'
              ? [
                  {
                    ...creatorSaleFixture,
                    orderId: id(5),
                    currency: 'jpy',
                    unitAmountMinor: 800,
                    moneyUnit: { system: 'stripe-api', exponent: 0, factsVersion: 'stripe-money-v1' },
                  },
                ]
              : [
                  {
                    ...creatorSaleFixture,
                    ...(state === 'long-title' ? { title: 'Captured title / 以前の版 / '.repeat(24) } : {}),
                  },
                  {
                    ...creatorSaleFixture,
                    orderId: id(3),
                    currency: 'eur',
                    unitAmountMinor: 675,
                    settlement: 'pending',
                  },
                  {
                    ...creatorSaleFixture,
                    orderId: id(4),
                    title: 'Captured title of a delisted or unavailable offer',
                    settlement: 'failed',
                  },
                  {
                    ...creatorSaleFixture,
                    orderId: id(6),
                    title: 'Historical sale with incomplete payment evidence',
                    settlement: 'unknown',
                    moneyUnit: null,
                    taxBehavior: null,
                  },
                ],
    next: ['history', 'long-title', 'incomplete', 'later-empty'].includes(state) ? 'story-signed+next/=' : null,
  };
}
