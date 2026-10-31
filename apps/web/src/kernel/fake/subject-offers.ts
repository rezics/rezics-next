import type { SubjectOffer, SubjectOffersData } from '../../checkout/subject-offers';
import type { FakeRoute } from '../fake-modules';
import offer from '../recorded/offer.json';
import { fixedEditionTerms } from './entitlements';
import { recordedStripeUnit } from './creator-offers';

/** Constructed closed-wire presentation examples, not native recordings or live discovery evidence. */
export const subjectOfferFixture: SubjectOffer = {
  id: offer.offer.id,
  targetSubjectId: offer.offer.targetSubjectId,
  title: offer.offer.title,
  currency: offer.offer.currency,
  unitAmountMinor: offer.offer.unitAmountMinor,
  moneyUnit: recordedStripeUnit,
  taxBehavior: 'exclusive',
  revision: 3,
  contentEdition: fixedEditionTerms,
};
export type SubjectPurchaseStoryState =
  | 'ready'
  | 'next-page'
  | 'pending'
  | 'empty'
  | 'preparing'
  | 'partial-preparing'
  | 'denied'
  | 'unavailable'
  | 'cursor-error'
  | 'long-title'
  | 'mapped-price-unknown'
  | 'unknown-mapping';
export function subjectOffersStoryPage(state: SubjectPurchaseStoryState): SubjectOffersData | { kind: 'pending' } {
  if (state === 'pending' || state === 'preparing' || state === 'unavailable' || state === 'cursor-error')
    return { kind: state };
  if (state === 'denied') return { kind: 'denied', status: 403, code: 'insufficient_scope' };
  return {
    kind: 'ready',
    offers:
      state === 'empty'
        ? []
        : [
            {
              ...subjectOfferFixture,
              ...(state === 'long-title'
                ? { title: 'An annotated edition with translations and illustrations / '.repeat(12) }
                : {}),
              ...(state === 'mapped-price-unknown' ? { moneyUnit: null, taxBehavior: null } : {}),
              ...(state === 'unknown-mapping' ? { contentEdition: null } : {}),
            },
          ],
    next: state === 'ready' || state === 'partial-preparing' ? 'constructed-signed-continuation' : null,
    projectionState: state === 'partial-preparing' ? 'preparing' : 'ready',
  };
}

// Explicit negative transport example: native discovery is delivered, but no current native page is recorded here.
export const routes: FakeRoute[] = [
  {
    method: 'GET',
    path: /^\/v1\/subjects\/[^/]+\/offers$/,
    story: () => ({ status: 503, code: 'dependency_unavailable' }),
    fixture: () => ({ status: 503, code: 'dependency_unavailable' }),
  },
];
