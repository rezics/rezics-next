import { type FilterDocument, type FilterRelease } from '@rezics/filter';
import type { WorkAllowance, WorkReceipt } from '../library/contract/work-dimensions.ts';
import type { OpenSearch } from './opensearch.ts';
export type CataloguePublicationObservation = Readonly<{
    releaseDigest: string;
    generation: number;
    uuid: string;
    index: string;
}>;
export type CataloguePublicationPage = Readonly<{
    subjects: readonly string[];
    exhausted: boolean;
    observation: CataloguePublicationObservation;
    work: WorkReceipt;
    engineRequests: number;
}>;
export type CataloguePublicationRead = Readonly<{
    client: OpenSearch;
    prefix: string;
    filter: FilterDocument;
    release: FilterRelease;
    releaseDigest: string;
    after: string | null;
    limit: number;
    deadline: number;
    work: WorkAllowance;
    expected?: CataloguePublicationObservation;
}>;
export type CataloguePublicationObserve = Readonly<{
    client: OpenSearch;
    prefix: string;
    releaseDigest: string;
    deadline: number;
    work: WorkAllowance;
    expected?: CataloguePublicationObservation;
}>;
export type CataloguePublicationLookup = CataloguePublicationRead & Readonly<{
    selected: readonly string[];
}>;
export type CataloguePublicationLookupPage = Readonly<{
    present: readonly string[];
    missing: readonly string[];
    observation: CataloguePublicationObservation;
    work: WorkReceipt;
    engineRequests: number;
}>;
/** Current public generation, physical identity and accepted release. Changed evidence restarts. */
export declare function observeCataloguePublication(input: CataloguePublicationObserve): Promise<Pick<CataloguePublicationPage, 'observation' | 'work' | 'engineRequests'>>;
/** Search public producer: selected catalogue A for Library staging. Library facts never enter this population. */
export declare function readCataloguePublicationPage(input: CataloguePublicationRead): Promise<CataloguePublicationPage>;
/**
 * Lookup the explicitly selected public A through its pinned native observation. The stored selected
 * identities are the render set; a later working B or a live index append is not this selection.
 */
export declare function lookupCataloguePublication(input: CataloguePublicationLookup): Promise<CataloguePublicationLookupPage>;
/** Selected A reread: the pinned observation is required so a working draft cannot stand in for it. */
export declare function readSelectedCataloguePublicationPage(input: CataloguePublicationRead & {
    expected: CataloguePublicationObservation;
}): Promise<CataloguePublicationPage>;
