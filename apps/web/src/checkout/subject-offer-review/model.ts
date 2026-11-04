import { capturedBenefit } from '../benefit';
import type { SubjectOffer } from '../subject-offers';

/** The observation is an offer identity and its supplied revision, never a title or Edition. */
export function sameSubjectOffer(a: SubjectOffer, b: SubjectOffer): boolean {
  return a.id === b.id && a.revision === b.revision;
}

export function subjectOfferKey(offer: SubjectOffer): string {
  return JSON.stringify([offer.id, offer.revision]);
}

/** Public and owned presentation share captured terms, but no selection or command state. */
export function readableSubjectOffer(offer: SubjectOffer) {
  const benefit = capturedBenefit(offer.contentEdition, offer.targetSubjectId);
  return { ...offer, contentEdition: benefit.kind === 'mapped' ? benefit.terms : null };
}

export type CaptureLabel = { edition: number; version: number };

/** Numbers distinguish captures on this bounded page. They are not native titles or stable identifiers. */
export function capturedPageLabels(offers: readonly SubjectOffer[]): ReadonlyMap<string, CaptureLabel> {
  const editions = new Map<string, { number: number; versions: Map<string, number> }>();
  const labels = new Map<string, CaptureLabel>();
  for (const offer of offers) {
    const benefit = capturedBenefit(offer.contentEdition, offer.targetSubjectId);
    if (benefit.kind !== 'mapped') continue;
    const { resource, version } = benefit.terms.benefit;
    const editionKey = JSON.stringify([resource.route, resource.id]);
    let edition = editions.get(editionKey);
    if (!edition) {
      edition = { number: editions.size + 1, versions: new Map() };
      editions.set(editionKey, edition);
    }
    const versionKey = JSON.stringify([version.revisionId, version.sha256]);
    let versionNumber = edition.versions.get(versionKey);
    if (versionNumber === undefined) {
      versionNumber = edition.versions.size + 1;
      edition.versions.set(versionKey, versionNumber);
    }
    labels.set(subjectOfferKey(offer), { edition: edition.number, version: versionNumber });
  }
  return labels;
}

export type SuppliedDifference = 'same' | 'different' | 'unknown';
export type OfferDifferences = {
  identity: SuppliedDifference;
  title: SuppliedDifference;
  target: SuppliedDifference;
  edition: SuppliedDifference;
  version: SuppliedDifference;
  digest: SuppliedDifference;
  licence: SuppliedDifference;
  acquisition: SuppliedDifference;
  quantity: SuppliedDifference;
  price: SuppliedDifference;
  tax: SuppliedDifference;
};
const difference = (same: boolean): SuppliedDifference => (same ? 'same' : 'different');

/** Equality of supplied facts only: no ranking, currency aggregation, tax calculation or catalogue resolution. */
export function suppliedOfferDifferences(first: SubjectOffer, second: SubjectOffer): OfferDifferences {
  const a = capturedBenefit(first.contentEdition, first.targetSubjectId);
  const b = capturedBenefit(second.contentEdition, second.targetSubjectId);
  const both = a.kind === 'mapped' && b.kind === 'mapped';
  const sameEdition =
    both &&
    a.terms.benefit.resource.route === b.terms.benefit.resource.route &&
    a.terms.benefit.resource.id === b.terms.benefit.resource.id;
  const knownMoney = first.moneyUnit !== null && second.moneyUnit !== null;
  return {
    identity: difference(sameSubjectOffer(first, second)),
    title: difference(first.title === second.title),
    target: difference(first.targetSubjectId === second.targetSubjectId),
    edition: both ? difference(sameEdition) : 'unknown',
    version: both
      ? difference(sameEdition && a.terms.benefit.version.revisionId === b.terms.benefit.version.revisionId)
      : 'unknown',
    digest: both ? difference(a.terms.benefit.version.sha256 === b.terms.benefit.version.sha256) : 'unknown',
    licence: both ? difference(a.terms.source.licence === b.terms.source.licence) : 'unknown',
    acquisition: both ? difference(a.terms.acquisition === b.terms.acquisition) : 'unknown',
    quantity: both ? difference(a.terms.quantity === b.terms.quantity) : 'unknown',
    price: knownMoney
      ? difference(
          first.currency === second.currency &&
            first.unitAmountMinor === second.unitAmountMinor &&
            first.moneyUnit?.system === second.moneyUnit?.system &&
            first.moneyUnit?.exponent === second.moneyUnit?.exponent &&
            first.moneyUnit?.factsVersion === second.moneyUnit?.factsVersion,
        )
      : 'unknown',
    tax:
      first.taxBehavior === null || second.taxBehavior === null
        ? 'unknown'
        : difference(first.taxBehavior === second.taxBehavior),
  };
}
