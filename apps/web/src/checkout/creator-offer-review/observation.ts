import type { CreatorOffer } from '../creator-offers';
import { recordedMoneyUnit, recordedTaxBehavior } from '../money-schema';

/** These are differences in the supplied owned page, never a request for other terms. */
export type OfferDifference =
  | 'revision'
  | 'title'
  | 'state'
  | 'price'
  | 'tax'
  | 'mapping'
  | 'edition'
  | 'version'
  | 'licence'
  | 'reference'
  | 'acquisition'
  | 'delivery'
  | 'quantity'
  | 'subject'
  | 'creator';

export function offerDifferences(observed: CreatorOffer, current: CreatorOffer): OfferDifference[] {
  const changed: OfferDifference[] = [];
  if (observed.revision !== current.revision) changed.push('revision');
  if (observed.title !== current.title) changed.push('title');
  if (observed.state !== current.state) changed.push('state');
  const aUnit = recordedMoneyUnit(observed);
  const bUnit = recordedMoneyUnit(current);
  if (
    observed.currency !== current.currency ||
    observed.unitAmountMinor !== current.unitAmountMinor ||
    aUnit?.system !== bUnit?.system ||
    aUnit?.exponent !== bUnit?.exponent ||
    aUnit?.factsVersion !== bUnit?.factsVersion
  )
    changed.push('price');
  if (recordedTaxBehavior(observed) !== recordedTaxBehavior(current)) changed.push('tax');
  if (observed.targetSubjectId !== current.targetSubjectId) changed.push('subject');
  const a = observed.contentEdition;
  const b = current.contentEdition;
  if ((a === null) !== (b === null)) changed.push('mapping');
  if (a && b) {
    if (a.benefit.resource.route !== b.benefit.resource.route || a.benefit.resource.id !== b.benefit.resource.id)
      changed.push('edition');
    if (
      a.benefit.version.revisionId !== b.benefit.version.revisionId ||
      a.benefit.version.sha256 !== b.benefit.version.sha256
    )
      changed.push('version');
    if (a.source.licence !== b.source.licence) changed.push('licence');
    if (a.saleTermsReference !== b.saleTermsReference) changed.push('reference');
    if (a.acquisition !== b.acquisition) changed.push('acquisition');
    if (a.delivery !== b.delivery) changed.push('delivery');
    if (a.quantity !== b.quantity) changed.push('quantity');
    if (a.targetSubjectId !== b.targetSubjectId && !changed.includes('subject')) changed.push('subject');
    if (a.creatorAccountId !== b.creatorAccountId) changed.push('creator');
  }
  return changed;
}

/** Offer identity precedes all Edition and title comparisons. */
export function sameOfferObservation(a: CreatorOffer, b: CreatorOffer): boolean {
  return a.id === b.id && offerDifferences(a, b).length === 0;
}

export type OfferReviewStatus =
  | { kind: 'same'; current: CreatorOffer }
  | { kind: 'changed'; current: CreatorOffer; differences: OfferDifference[] }
  | { kind: 'missing' };

export function offerReviewStatus(observed: CreatorOffer, offers: readonly CreatorOffer[]): OfferReviewStatus {
  const current = offers.find((offer) => offer.id === observed.id);
  if (!current) return { kind: 'missing' };
  const differences = offerDifferences(observed, current);
  return differences.length === 0 ? { kind: 'same', current } : { kind: 'changed', current, differences };
}
