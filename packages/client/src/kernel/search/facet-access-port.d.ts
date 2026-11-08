/**
 * Search-owned Access observation port for scoped facets.
 *
 * Current-reader work stays in Search. Access unavailability and the HTTP problem
 * identities that Search already maps to closed facet pages never enter this module;
 * composition supplies the adapter that classifies those foreign failures.
 */
/** Closed native outcomes retained scoped facet pages already publish. */
export type FacetAccessClosedStatus = 'changed' | 'unready' | 'unavailable';
/**
 * Search-owned HTTP problem codes that scoped Collection/Realm current-reader work already
 * folds into a closed page. Composition matches these codes on the public ProblemError
 * identity; Search never imports that type here.
 */
export declare const FACET_ACCESS_HTTP_CLOSED: Readonly<{
    readonly search_restart_required: 'changed';
    readonly stale_cursor: 'changed';
    readonly not_found: 'unavailable';
    readonly semantic_not_ready: 'unready';
    readonly index_not_ready: 'unready';
    readonly dependency_unavailable: 'unready';
}>;
export type FacetAccessHttpClosedCode = keyof typeof FACET_ACCESS_HTTP_CLOSED;
export type FacetAccessReadyResult<T> = Readonly<{
    status: 'ready';
    value: T;
}>;
export type FacetAccessClosedResult = Readonly<{
    status: FacetAccessClosedStatus;
}>;
export type FacetAccessCurrentReaderResult<T> = FacetAccessReadyResult<T> | FacetAccessClosedResult;
/**
 * Observe current Access/authorization work for one scoped facet execution.
 * `runCurrentReader` either returns the native value or a closed status; any other
 * failure still throws so Search does not swallow unknown defects.
 */
export type FacetAccessObservationPort = Readonly<{
    runCurrentReader<T>(work: () => Promise<T>): Promise<FacetAccessCurrentReaderResult<T>>;
}>;
export declare function isFacetAccessHttpClosedCode(code: string): code is FacetAccessHttpClosedCode;
export declare function facetAccessHttpClosedStatus(code: string): FacetAccessClosedStatus | undefined;
/** Observe() never publishes `changed`; a restart-class failure becomes unready for that call. */
export declare function foldFacetAccessObserveStatus(status: FacetAccessClosedStatus): 'unready' | 'unavailable';
/**
 * Tests and isolated fixtures that do not install composition keep throwing. Live Search
 * always receives the composition adapter so Access and mapped HTTP failures close the page.
 */
export declare const passthroughFacetAccessObservation: FacetAccessObservationPort;
export declare function resolveFacetAccessObservation(access: FacetAccessObservationPort | undefined): FacetAccessObservationPort;
/** Classify a named Access unavailable failure without importing Access types. */
export declare function facetAccessUnavailableStatus(name: string): FacetAccessClosedStatus | undefined;
export type FacetAccessFailureClassification = Readonly<{
    name?: string;
    code?: string;
}>;
/**
 * Pure Search vocabulary for the composition adapter. Access unavailable is unready;
 * listed HTTP codes keep their existing closed pages; everything else is unclassified.
 */
export declare function classifyFacetAccessFailure(failure: FacetAccessFailureClassification): FacetAccessClosedStatus | undefined;
