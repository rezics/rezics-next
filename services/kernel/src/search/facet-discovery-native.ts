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
import type { TextNode } from './text.ts';

/** Additive facet boundary from the continuation-runtime plan. Subject capture/query remain unchanged.
 * Native implementations own finite input, projection, support routing, physical custody and START/FINAL.
 * These declarations are not a delivered native producer or a permission/completeness certificate.
 */
export type FacetNativePlan = Readonly<{
  filterDocument: FilterDocument | undefined;
  text: TextNode | undefined;
  property: string;
  valueKind: 'item' | 'code' | 'type';
  meaning: PublicFilterProjectionMeaning;
}>;

export type FacetNativeRead = Readonly<{
  plan: FacetNativePlan;
  queried: PublicFilterQueriedObservation;
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

export type FacetNativePageResult =
  | Readonly<{
      status: 'ready';
      facets: readonly FacetNativeReadyFacet[];
      asOf: string;
      cost: PublicFilterCost;
    }>
  | Readonly<{ status: 'preparing'; cost: PublicFilterCost }>
  | PublicFilterConsumerUnavailable;

export interface FacetNativeOperations {
  captureFacet(
    request: Readonly<{ plan: FacetNativePlan }>,
    context: PublicFilterConsumerContext,
  ): Promise<PublicFilterConsumerCapture>;
  /** One atomic common page, including shared native START/FINAL, current targets and all siblings. */
  pageFacets(
    request: Readonly<{ reads: readonly FacetNativeRead[] }>,
    context: PublicFilterConsumerContext,
  ): Promise<FacetNativePageResult>;
  repairStep: PublicFilterConsumerOperations['repairStep'];
}

/** Trusted composition, not HTTP input. The native owner supplies the registered Source definition and
 * pinned complete meaning; the service cannot synthesize either from preview documents or a type anchor.
 */
export type FacetDiscoveryProvider = Readonly<{
  source: string;
  meaning: PublicFilterProjectionMeaning;
  generation: number;
  operations: FacetNativeOperations;
}>;
