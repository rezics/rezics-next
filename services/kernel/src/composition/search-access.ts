/**
 * Composition adapter for Search's Access observation port.
 *
 * Search scoped facet execution never imports Access unavailable or HTTP problem types.
 * This root maps those foreign failures onto the native closed statuses Search already
 * publishes: unready, changed, and unavailable.
 */
import { AccessUnavailableError } from '../access/unavailable.ts';
import { ProblemError } from '../http/problem-error.ts';
import {
  classifyFacetAccessFailure,
  facetAccessHttpClosedStatus,
  type FacetAccessClosedStatus,
  type FacetAccessCurrentReaderResult,
  type FacetAccessObservationPort,
} from '../search/facet-access-port.ts';

export function classifySearchAccessFacetFailure(error: unknown): FacetAccessClosedStatus | undefined {
  if (error instanceof AccessUnavailableError)
    return classifyFacetAccessFailure({ name: error.name });
  if (error instanceof ProblemError) return facetAccessHttpClosedStatus(error.code);
  if (error instanceof Error) return classifyFacetAccessFailure({ name: error.name });
  return undefined;
}

export function createSearchAccessFacetObservation(): FacetAccessObservationPort {
  return {
    async runCurrentReader<T>(work: () => Promise<T>): Promise<FacetAccessCurrentReaderResult<T>> {
      try {
        return { status: 'ready', value: await work() };
      } catch (error) {
        const status = classifySearchAccessFacetFailure(error);
        if (!status) throw error;
        return { status };
      }
    },
  };
}

let composed: FacetAccessObservationPort | undefined;

/** Ordinary createKernel/server/worker composition binds Search's Access observation adapter. */
export function composeSearchAccess(): FacetAccessObservationPort {
  composed ??= createSearchAccessFacetObservation();
  return composed;
}

export function composedSearchAccess(): FacetAccessObservationPort {
  return composed ?? composeSearchAccess();
}
