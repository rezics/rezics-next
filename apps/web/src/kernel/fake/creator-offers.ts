import type { CreatorOffer, CreatorOffersData } from '../../checkout/creator-offers';
import type { CommerceMoneySchema, ConfiguredSaleCurrencyRule, StripeMoneyUnit } from '../../checkout/money-schema';
import type { FakeRoute } from '../fake-modules';

/** Explicit adopted unit/configuration input for price-field examples, never account or selling authority. */
export const recordedStripeUnit: StripeMoneyUnit = Object.freeze({
  system: 'stripe-api',
  exponent: 2,
  factsVersion: 'stripe-money-v1',
});
export const configuredUsdRule: ConfiguredSaleCurrencyRule = Object.freeze({
  currency: 'usd',
  unit: recordedStripeUnit,
  minAmountMinor: 50,
  maxAmountMinor: 99999999,
  chargeMultiple: 1,
});
export const configuredPriceExample: CommerceMoneySchema = Object.freeze({
  factsVersion: 'stripe-money-v1',
  taxBehavior: 'exclusive',
  configuredSaleCurrencies: Object.freeze([configuredUsdRule, { ...configuredUsdRule, currency: 'eur' as const }]),
});

const id = (n: number) => `019a2100-0000-7000-8000-2200${String(n).padStart(8, '0')}`;
export const creatorOfferFixture: CreatorOffer = {
  id: id(3),
  targetSubjectId: id(30),
  title: 'A field guide to quiet places',
  currency: 'usd',
  unitAmountMinor: 1200,
  moneyUnit: recordedStripeUnit,
  taxBehavior: 'exclusive',
  taxCode: 'txcd_10302000',
  royaltyBasisPoints: 9000,
  state: 'active',
  revision: 2,
  contentEdition: {
    benefit: {
      kind: 'content-edition',
      resourceType: 'content.edition',
      resource: { route: 0x2200, id: id(40) },
      version: { revisionId: id(41), sha256: 'a'.repeat(64) },
      action: 'edition:read',
    },
    creatorAccountId: id(20),
    targetSubjectId: id(30),
    source: { licence: 'CC-BY-4.0' },
    saleTermsReference: 'edition-publication-v1',
    delivery: 'fixed-content-edition',
    acquisition: 'one-time-account-bound',
    quantity: 1,
  },
};
export const delistedCreatorOfferFixture: CreatorOffer = {
  ...creatorOfferFixture,
  id: id(2),
  title: 'Earlier edition — archived offer',
  currency: 'jpy',
  unitAmountMinor: 800,
  moneyUnit: { system: 'stripe-api', exponent: 0, factsVersion: 'stripe-money-v1' },
  taxBehavior: null,
  contentEdition: null,
  state: 'delisted',
  revision: 3,
};
export type CreatorOffersStory =
  | 'history'
  | 'second-page'
  | 'empty'
  | 'denied'
  | 'unavailable'
  | 'error'
  | 'stale'
  | 'preparing'
  | 'long-title';

let selectedStory: CreatorOffersStory | undefined;
/** Illustrative transport state for the existing page harness; never a production caller. */
export function setCreatorOffersStory(state?: CreatorOffersStory): void {
  selectedStory = state;
}

export function creatorOffersStoryPage(state: CreatorOffersStory): CreatorOffersData {
  if (['denied', 'unavailable', 'error', 'stale', 'preparing'].includes(state)) {
    if (
      state === 'denied' ||
      state === 'unavailable' ||
      state === 'error' ||
      state === 'stale' ||
      state === 'preparing'
    )
      return { kind: state };
  }
  return {
    kind: 'ready',
    offers:
      state === 'empty'
        ? []
        : state === 'second-page'
          ? [delistedCreatorOfferFixture]
          : [
              {
                ...creatorOfferFixture,
                ...(state === 'long-title'
                  ? { title: 'A very long captured title / '.repeat(18) + '無空白の長い題名'.repeat(20) }
                  : {}),
              },
              {
                ...delistedCreatorOfferFixture,
                ...(state === 'history' ? { title: creatorOfferFixture.title } : {}),
              },
              {
                ...creatorOfferFixture,
                id: id(1),
                currency: 'eur',
                unitAmountMinor: 675,
                title: 'Notes from the coast',
              },
            ],
    next: state === 'empty' || state === 'second-page' ? null : 'story-signed-cursor-placeholder',
  };
}
// Story transport has no deployment sale configuration. Keep it unavailable rather than invent qualification.
export const routes: FakeRoute[] = [
  {
    method: 'GET',
    path: '/v1/commerceMoney',
    story: () => ({ status: 503, code: 'dependency_unavailable' }),
    fixture: () => ({ status: 503, code: 'dependency_unavailable' }),
  },
  {
    method: 'GET',
    path: '/v1/offers',
    story: ({ request }) => {
      const page = creatorOffersStoryPage(
        new URL(request.url).searchParams.has('cursor') ? 'second-page' : (selectedStory ?? 'history'),
      );
      return page.kind === 'ready' ? { status: 200, offers: page.offers, next: page.next } : undefined;
    },
  },
];
