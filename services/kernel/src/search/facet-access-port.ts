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
export const FACET_ACCESS_HTTP_CLOSED = Object.freeze({
  search_restart_required: 'changed',
  stale_cursor: 'changed',
  not_found: 'unavailable',
  semantic_not_ready: 'unready',
  index_not_ready: 'unready',
  dependency_unavailable: 'unready',
} as const satisfies Readonly<Record<string, FacetAccessClosedStatus>>);

export type FacetAccessHttpClosedCode = keyof typeof FACET_ACCESS_HTTP_CLOSED;

export type FacetAccessReadyResult<T> = Readonly<{ status: 'ready'; value: T }>;
export type FacetAccessClosedResult = Readonly<{ status: FacetAccessClosedStatus }>;
export type FacetAccessCurrentReaderResult<T> = FacetAccessReadyResult<T> | FacetAccessClosedResult;

/**
 * Observe current Access/authorization work for one scoped facet execution.
 * `runCurrentReader` either returns the native value or a closed status; any other
 * failure still throws so Search does not swallow unknown defects.
 */
export type FacetAccessObservationPort = Readonly<{
  runCurrentReader<T>(work: () => Promise<T>): Promise<FacetAccessCurrentReaderResult<T>>;
}>;

const HTTP_CLOSED_CODES: ReadonlySet<string> = new Set(Object.keys(FACET_ACCESS_HTTP_CLOSED));

export function isFacetAccessHttpClosedCode(code: string): code is FacetAccessHttpClosedCode {
  return HTTP_CLOSED_CODES.has(code);
}

export function facetAccessHttpClosedStatus(code: string): FacetAccessClosedStatus | undefined {
  return isFacetAccessHttpClosedCode(code) ? FACET_ACCESS_HTTP_CLOSED[code] : undefined;
}

/** Observe() never publishes `changed`; a restart-class failure becomes unready for that call. */
export function foldFacetAccessObserveStatus(status: FacetAccessClosedStatus): 'unready' | 'unavailable' {
  return status === 'changed' ? 'unready' : status;
}

/**
 * Tests and isolated fixtures that do not install composition keep throwing. Live Search
 * always receives the composition adapter so Access and mapped HTTP failures close the page.
 */
export const passthroughFacetAccessObservation: FacetAccessObservationPort = Object.freeze({
  async runCurrentReader(work) {
    return { status: 'ready' as const, value: await work() };
  },
});

export function resolveFacetAccessObservation(
  access: FacetAccessObservationPort | undefined,
): FacetAccessObservationPort {
  return access ?? passthroughFacetAccessObservation;
}

/** Classify a named Access unavailable failure without importing Access types. */
export function facetAccessUnavailableStatus(name: string): FacetAccessClosedStatus | undefined {
  return name === 'AccessUnavailableError' ? 'unready' : undefined;
}

export type FacetAccessFailureClassification = Readonly<{
  name?: string;
  code?: string;
}>;

/**
 * Pure Search vocabulary for the composition adapter. Access unavailable is unready;
 * listed HTTP codes keep their existing closed pages; everything else is unclassified.
 */
export function classifyFacetAccessFailure(
  failure: FacetAccessFailureClassification,
): FacetAccessClosedStatus | undefined {
  if (failure.name !== undefined) {
    const unavailable = facetAccessUnavailableStatus(failure.name);
    if (unavailable) return unavailable;
  }
  return failure.code === undefined ? undefined : facetAccessHttpClosedStatus(failure.code);
}
