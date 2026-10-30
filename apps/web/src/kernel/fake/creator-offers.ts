import type { CreatorOffer, CreatorOffersData } from '../../checkout/creator-offers';
import type { FakeRoute } from '../fake-modules';

const id = (n: number) => `019a2100-0000-7000-8000-2200${String(n).padStart(8, '0')}`;
export const creatorOfferFixture: CreatorOffer = {
  id: id(3),
  targetSubjectId: id(30),
  title: 'A field guide to quiet places',
  currency: 'usd',
  unitAmountMinor: 1200,
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
              delistedCreatorOfferFixture,
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
// Contract-shaped responses for later full-page binding; no native permission claim.
export const routes: FakeRoute[] = [
  {
    method: 'GET',
    path: '/v1/offers',
    story: ({ request }) => {
      const page = creatorOffersStoryPage(new URL(request.url).searchParams.has('cursor') ? 'second-page' : 'history');
      return page.kind === 'ready' ? { status: 200, offers: page.offers, next: page.next } : undefined;
    },
  },
];
