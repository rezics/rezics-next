import type { FilterDocument } from '@rezics/filter';
import type { PublicFilterCost, PublicFilterProjectionMeaning } from '../semantic/public-filter-source-contract.ts';
import type {
  PublicFilterConsumerCapture,
  PublicFilterConsumerContext,
  PublicFilterConsumerOperations,
  PublicFilterConsumerUnavailable,
  PublicFilterQueriedObservation,
} from './public-filter-consumer-contract.ts';
import type { FacetDiscoveryValue } from './facet-discovery-contract.ts';
import type { ScopedFacetAdmission } from './scoped-facet-source.ts';
import type { TextNode } from './text.ts';
import type { CreditQualifierOperand } from './credit-search-query.ts';

/** Native facet plan after ordinary facet admission. A scoped request is supplied internally by its owner
 * through `createScopedFacetApplication`; its source identity, meaning, population observation and current
 * authorization are retained and rechecked. The facet wire remains unchanged.
 */
export type FacetNativePlan = Readonly<{
  filterDocument: FilterDocument | undefined;
  kinds?: readonly string[];
  text: TextNode | undefined;
  textField?: 'credited_creator';
  creditQualifiers?: readonly CreditQualifierOperand[];
  property: string;
  valueKind: 'item' | 'code' | 'type';
  meaning: PublicFilterProjectionMeaning;
  /** Internal admission from the Realm/Collection owner; never parsed as a facet DTO field. */
  scope?: ScopedFacetAdmission;
}>;

export type FacetNativeRead = Readonly<{
  plan: FacetNativePlan;
  queried: PublicFilterQueriedObservation;
  textObservation?: PublicFilterQueriedObservation;
  size: number;
  after: string | null;
}>;

export type FacetNativeReadyFacet = Readonly<{
  property: string;
  values: readonly FacetDiscoveryValue[];
  /** Last consumed key, never the undisclosed eligible lookahead. */
  after: string | null;
  /** Native eligible lookahead, not a capped storage page or a bucket estimate. */
  hasMore: boolean;
}>;

export type FacetNativePageFinalization = Readonly<{
  status: 'current' | 'changed';
  cost: PublicFilterCost;
}>;

export type FacetNativePageResult =
  | Readonly<{
      status: 'ready';
      facets: readonly FacetNativeReadyFacet[];
      asOf: string;
      cost: PublicFilterCost;
      /** One use, bound to these exact sibling reads; called after Search projects values and cursors. */
      finalize(): Promise<FacetNativePageFinalization>;
    }>
  | Readonly<{ status: 'preparing'; cost: PublicFilterCost }>
  | PublicFilterConsumerUnavailable;

export interface FacetNativeOperations {
  captureFacet(
    request: Readonly<{ plan: FacetNativePlan }>,
    context: PublicFilterConsumerContext,
  ): Promise<PublicFilterConsumerCapture & { textObservation?: PublicFilterQueriedObservation }>;
  /** One atomic common page, including shared native START/FINAL, current targets and all siblings. */
  pageFacets(
    request: Readonly<{ reads: readonly FacetNativeRead[] }>,
    context: PublicFilterConsumerContext,
  ): Promise<FacetNativePageResult>;
  repairStep: PublicFilterConsumerOperations['repairStep'];
}

/** Trusted composition, not HTTP input. The native owner supplies the registered Source definition,
 * pinned complete meaning and, for scoped reads, the admitted native population.
 */
export type FacetDiscoveryProvider = Readonly<{
  source: string;
  meaning: PublicFilterProjectionMeaning;
  generation: number;
  operations: FacetNativeOperations;
}>;
