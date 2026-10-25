import { type FilterDocument, type FilterRelease } from '@rezics/filter';
import { type IndexedSubject, type SubjectSource } from './source.ts';
export type FacetRequest = {
    text?: string;
    filter?: unknown;
    facets: {
        property: string;
        size?: number;
    }[];
};
export type Facet = {
    property: string;
    size: number;
};
export type FacetValue = {
    value: string;
    count: number;
    labels: Record<string, string>;
};
export declare function validateFacets(request: FacetRequest): Facet[];
/** Probe admission with the same immediate type anchors, without spending the query's leaf/depth budget. */
export declare function admitFacets(facets: readonly Facet[], filter: FilterDocument | undefined, release: FilterRelease): void;
/** Read each value anchor once, grouping across all facets before applying disclosure. */
export declare function discloseFacetValues(source: SubjectSource, values: readonly string[]): Promise<Map<string, IndexedSubject>>;
