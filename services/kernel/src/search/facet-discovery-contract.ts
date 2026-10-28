/** Adopted wire only; docs/search-facets.md owns semantics. Not the current service types or runtime validation. */
export type FacetDiscoveryRequestedFacet = {
  property: string;
  /** Integer 1..20; omitted means 10. */
  size?: number;
  /** Opaque confidential Search cursor for this property and effective query. */
  cursor?: string;
};

export type FacetDiscoveryRequest = {
  text?: string;
  filter?: unknown;
  languages?: string[];
  /** One to eight entries with distinct properties. */
  facets: FacetDiscoveryRequestedFacet[];
};

export type FacetDiscoveryValue = {
  value: string;
  labels: Record<string, string>;
};

export type FacetDiscoveryFacet = {
  property: string;
  values: FacetDiscoveryValue[];
  /** Required: null only for proved final exhaustion of the identified observation. */
  next: string | null;
};

export type FacetDiscovery200Response = {
  facets: FacetDiscoveryFacet[];
  /** Existing date-time freshness metadata; never a privacy or exhaustion certificate. */
  as_of: string;
};
