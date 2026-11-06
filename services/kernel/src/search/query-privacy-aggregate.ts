import type { FacetDiscoveryValue } from './facet-discovery-contract.ts';
import { proveKindCount, type KindCountProof } from './kind-count-proof.ts';
import {
  observationIsDisclosable,
  queryPrivacyCurrentness,
  sampledHitsCannotCertifyTotal,
  type QueryPrivacyDecision,
  type QueryPrivacyHeads,
} from './query-privacy.ts';

/**
 * Independent whole-query proofs for public totals and facet values. Hit samples, live facet
 * buckets and engine exhaustion never become exact counts. A relevant privacy change retires
 * every sibling value until a fresh START/FINAL of that aggregate execution is current.
 *
 * Cost
 * - Touches: the already observed privacy heads for the aggregate execution, plus caller
 *   exhaustion and value lists. No extra engine or Source census.
 * - Bound: one pass over at most eight facets and twenty values each. Independent of corpus size.
 * - Growth check: `test/search/query-privacy-aggregate.test.ts` covers withheld siblings, lower
 *   bounds from current values, refused sample totals and exact proof only with currentness.
 */

export type QueryPrivacyFacetValue = Readonly<{
  value: string;
  labels: Record<string, string>;
}>;

export type QueryPrivacyFacet =
  | Readonly<{
      property: string;
      relation: 'exact';
      values: readonly QueryPrivacyFacetValue[];
    }>
  | Readonly<{
      property: string;
      relation: 'lower_bound';
      values: readonly QueryPrivacyFacetValue[];
    }>
  | Readonly<{ property: string; withheld: true }>;

export type QueryPrivacyAggregatePage =
  | Readonly<{ status: 'ready'; facets: readonly QueryPrivacyFacet[]; exact: boolean }>
  | Readonly<{ status: 'preparing' }>;

export type QueryPrivacyTotal =
  | Readonly<{ withheld: true }>
  | Readonly<{ value: number; exact: false }>
  | Readonly<{ value: number; exact: true }>;

export function queryPrivacyTotal(input: {
  currentness: QueryPrivacyDecision;
  witnesses: number;
  exhausted: boolean;
  aggregateProof: boolean;
  continuation?: boolean;
}): QueryPrivacyTotal {
  if (input.currentness.status !== 'current') return { withheld: true };
  if (input.continuation || !Number.isSafeInteger(input.witnesses) || input.witnesses < 0) return { withheld: true };
  const proof: KindCountProof = {
    continuation: false,
    exhausted: input.exhausted,
    aggregateProof: input.aggregateProof,
    witnesses: new Map([['total', input.witnesses]]),
  };
  if (sampledHitsCannotCertifyTotal(proof) || !input.aggregateProof || !input.exhausted) {
    const evidence = proveKindCount('total', { ...proof, aggregateProof: false });
    return 'value' in evidence ? { value: evidence.value, exact: false } : { withheld: true };
  }
  const evidence = proveKindCount('total', proof);
  return 'value' in evidence ? { value: evidence.value, exact: evidence.exact === true } : { withheld: true };
}

export function queryPrivacyFacets(input: {
  currentness: QueryPrivacyDecision;
  facets: readonly Readonly<{
    property: string;
    values: readonly QueryPrivacyFacetValue[];
    exhausted: boolean;
  }>[];
  aggregateProof: boolean;
}): QueryPrivacyAggregatePage {
  if (input.currentness.status !== 'current') return { status: 'preparing' };
  const exact = input.aggregateProof && input.facets.every((facet) => facet.exhausted);
  return {
    status: 'ready',
    exact,
    facets: input.facets.map((facet) =>
      exact
        ? { property: facet.property, relation: 'exact' as const, values: facet.values }
        : { property: facet.property, relation: 'lower_bound' as const, values: facet.values },
    ),
  };
}

/** One final query-level decision for every sibling. An unclean observation withholds the page. */
export function queryPrivacyFacetSiblings(input: {
  heads: QueryPrivacyHeads;
  facets: readonly Readonly<{
    property: string;
    values: readonly FacetDiscoveryValue[];
    exhausted: boolean;
  }>[];
  aggregateProof: boolean;
}): QueryPrivacyAggregatePage {
  const currentness = queryPrivacyCurrentness(input.heads);
  if (!observationIsDisclosable(input.heads)) return { status: 'preparing' };
  return queryPrivacyFacets({
    currentness,
    aggregateProof: input.aggregateProof,
    facets: input.facets.map((facet) => ({
      property: facet.property,
      values: facet.values.map(({ value, labels }) => ({ value, labels })),
      exhausted: facet.exhausted,
    })),
  });
}

export function liveFacetCountsAreWitnesses(_complete: boolean): boolean {
  return true;
}

export function queryPrivacyWithholdUnsafeTotals(total: QueryPrivacyTotal): boolean {
  return 'withheld' in total || total.exact === false;
}
