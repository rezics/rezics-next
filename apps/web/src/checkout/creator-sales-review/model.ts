import type { CreatorSale } from '../creator-sales';

/** Comparison is a reading aid over at most three exact identities from one admitted page. */
export const CREATOR_SALE_COMPARISON_LIMIT = 3;
export const CREATOR_SALE_SEARCH_LIMIT = 1024;
export const settlementStates = ['paid', 'pending', 'failed', 'unknown'] as const;
export type SettlementView = CreatorSale['settlement'] | 'all';
export type ReviewCriteria = {
  text: string;
  work: string;
  offer: string;
  settlement: SettlementView;
};
export const initialReviewCriteria: ReviewCriteria = {
  text: '',
  work: '',
  offer: '',
  settlement: 'all',
};
export type OfferObservation = {
  id: string;
  titles: readonly string[];
  count: number;
};
export type CurrencyObservation = {
  currency: string;
  count: number;
  unknownUnits: number;
  units: readonly { system: string; exponent: number; factsVersion: string; count: number }[];
};
export type ReceivedPageReview = {
  sales: readonly CreatorSale[];
  offers: readonly OfferObservation[];
  works: readonly { id: string; count: number }[];
  settlements: Readonly<Record<CreatorSale['settlement'], number>>;
  currencies: readonly CurrencyObservation[];
};

/** Facets describe supplied observations, never a native query or an account-wide inventory. */
export function prepareReceivedPageReview(sales: readonly CreatorSale[]): ReceivedPageReview {
  const offers = new Map<string, { titles: Set<string>; count: number }>();
  const works = new Map<string, number>();
  const settlements = { paid: 0, pending: 0, failed: 0, unknown: 0 };
  const currencies = new Map<
    string,
    { count: number; unknownUnits: number; units: Map<string, CurrencyObservation['units'][number]> }
  >();
  for (const sale of sales) {
    const offer = offers.get(sale.offerId) ?? { titles: new Set<string>(), count: 0 };
    offer.titles.add(sale.title);
    offer.count++;
    offers.set(sale.offerId, offer);
    works.set(sale.targetSubjectId, (works.get(sale.targetSubjectId) ?? 0) + 1);
    settlements[sale.settlement]++;
    const code = sale.currency.toUpperCase();
    const currency = currencies.get(code) ?? { count: 0, unknownUnits: 0, units: new Map() };
    currency.count++;
    const unit = sale.moneyUnit;
    if (!unit) currency.unknownUnits++;
    else {
      const key = JSON.stringify([unit.system, unit.exponent, unit.factsVersion]);
      const observed = currency.units.get(key);
      currency.units.set(key, { ...unit, count: (observed?.count ?? 0) + 1 });
    }
    currencies.set(code, currency);
  }
  return {
    sales,
    offers: [...offers].map(([id, value]) => ({ id, titles: [...value.titles], count: value.count })),
    works: [...works].map(([id, count]) => ({ id, count })),
    settlements,
    currencies: [...currencies].map(([currency, value]) => ({
      currency,
      count: value.count,
      unknownUnits: value.unknownUnits,
      units: [...value.units.values()],
    })),
  };
}

/** Filtering preserves the native array's relative ordering, including equal titles and offers. */
export function reviewReceivedSales(review: ReceivedPageReview, criteria: ReviewCriteria): readonly CreatorSale[] {
  const text = criteria.text.slice(0, CREATOR_SALE_SEARCH_LIMIT).trim().toLocaleLowerCase('en');
  if (!text && !criteria.work && !criteria.offer && criteria.settlement === 'all') return review.sales;
  return review.sales.filter(
    (sale) =>
      (!criteria.work || sale.targetSubjectId === criteria.work) &&
      (!criteria.offer || sale.offerId === criteria.offer) &&
      (criteria.settlement === 'all' || sale.settlement === criteria.settlement) &&
      (!text ||
        [sale.title, sale.offerId, sale.targetSubjectId].some((value) => value.toLocaleLowerCase('en').includes(text))),
  );
}

export function reviewIsFiltered(criteria: ReviewCriteria): boolean {
  return !!(criteria.text.trim() || criteria.work || criteria.offer || criteria.settlement !== 'all');
}

/** Metadata compatibility is a fact, not arithmetic, a net amount or a reconciliation result. */
export type RecordedUnitRelationship = 'unknown' | 'different-currencies' | 'different-units' | 'same-unit';
export function recordedUnitRelationship(sales: readonly CreatorSale[]): RecordedUnitRelationship {
  if (sales.length < 2 || sales.some((sale) => !sale.moneyUnit)) return 'unknown';
  const first = sales[0]!;
  if (sales.some((sale) => sale.currency.toUpperCase() !== first.currency.toUpperCase())) return 'different-currencies';
  if (
    sales.some(
      (sale) =>
        sale.moneyUnit?.system !== first.moneyUnit?.system ||
        sale.moneyUnit?.exponent !== first.moneyUnit?.exponent ||
        sale.moneyUnit?.factsVersion !== first.moneyUnit?.factsVersion,
    )
  )
    return 'different-units';
  return 'same-unit';
}
