import { type FilterDocument, type FilterRelease } from '@rezics/filter';
import type { FacetDiscoveryRequest } from './facet-discovery-contract.ts';
import { type IndexedSubject, type SubjectSource } from './source.ts';
export type FacetRequest = FacetDiscoveryRequest;
export type Facet = {
    property: string;
    size: number;
    cursor?: string;
};
export type FacetValue = {
    value: string;
    count: number;
    labels: Record<string, string>;
};
/** A string facet whose definition declares `value.pattern`. Its values are codes, not subjects. */
export declare function codeFacet(release: FilterRelease, property: string): boolean;
/** Type definitions are public; their labels need no subject disclosure. */
export declare function typeFacetLabels(release: FilterRelease, type: string): Record<string, string> | undefined;
export declare function validateFacets(request: FacetRequest): Facet[];
/** Probe admission with the same immediate type anchors, without spending the query's leaf/depth budget. */
export declare function admitFacets(facets: readonly Facet[], filter: FilterDocument | undefined, release: FilterRelease): void;
/** Read each value anchor once, grouping across all facets before applying disclosure. */
export declare function discloseFacetValues(source: SubjectSource, values: readonly string[]): Promise<Map<string, IndexedSubject>>;
