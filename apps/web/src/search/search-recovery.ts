import { diagnoseText, readTextDiagnostic, type TextDiagnostic } from '../../../../packages/search-text/src/index.ts';
import type { KernelClient } from '@rezics/client';
import { isPlatformClosedError } from '../kernel/platform-closed';
import { parseDiscoveryPage, parseLegacySearchPage, type DiscoveryState, type LegacySearchPage } from './discovery';
import { facetProblem, type FacetState } from './refinement/request';
import type { SearchPageData } from './search';
import type { SearchLoaderDeps } from './search-params';
import { searchRetryAt } from './search-recovery-retry';

export { searchRetryAt } from './search-recovery-retry';

type Request = NonNullable<Parameters<KernelClient['subjects']['$search']['post']>[0]>;
export type SearchWireResponse = {
  status: number;
  data?: unknown;
  error?: unknown;
  response?: { headers: Headers };
};
export type SearchRecoveryState =
  | { status: 'ready' }
  | { status: 'sparse' | 'exhausted'; asOf?: string }
  | {
      status:
        | 'loading'
        | 'invalid'
        | 'invalid-cursor'
        | 'session'
        | 'closed'
        | 'denied'
        | 'restart'
        | 'index-not-ready'
        | 'source-not-ready'
        | 'unavailable';
      problem?: NonNullable<ReturnType<typeof facetProblem>>;
      retryAt?: number;
      textError?: { query: string; diagnostic: TextDiagnostic };
    };
export type SearchOutcome = {
  recovery: SearchRecoveryState;
  discovery?: DiscoveryState;
  result?: LegacySearchPage;
};

/** Keep HTTP admission, credentials, current authority and dependency failures distinct. */
export function searchRecoveryFromResponse(
  response: SearchWireResponse,
  now = Date.now(),
  cursor?: string,
): SearchRecoveryState {
  const problem = facetProblem(response.error ?? response.data);
  const code = problem?.code;
  const status: Exclude<SearchRecoveryState['status'], 'ready'> =
    response.status === 401
      ? 'session'
      : response.status === 403
        ? code === 'platform_closed'
          ? 'closed'
          : 'denied'
        : response.status === 409
          ? 'restart'
          : response.status === 422
            ? 'invalid'
            : response.status === 400
              ? problem?.errors?.some(({ pointer }) => pointer === '/cursor' || pointer.startsWith('/cursor/')) ||
                (cursor !== undefined && !problem?.errors?.length)
                ? 'invalid-cursor'
                : 'invalid'
              : response.status === 503 && code === 'index_not_ready'
                ? 'index-not-ready'
                : response.status === 503 && code === 'semantic_not_ready'
                  ? 'source-not-ready'
                  : 'unavailable';
  const retryAt = searchRetryAt(response.response?.headers.get('retry-after') ?? null, now);
  return { status, ...(problem ? { problem } : {}), ...(retryAt !== undefined ? { retryAt } : {}) };
}

/** Exactly one existing SDK request per read. A restart always needs an explicit reader action. */
export async function readSearchOutcome(
  request: Request,
  send: (request: Request) => Promise<SearchWireResponse>,
  signal?: AbortSignal,
): Promise<SearchOutcome> {
  const submittedText = request.text;
  try {
    signal?.throwIfAborted();
    const response = await send(request);
    signal?.throwIfAborted();
    if (response.error || response.status !== 200) {
      const recovery = searchRecoveryFromResponse(response, Date.now(), request.cursor);
      const raw = response.error ?? response.data;
      const body = raw && typeof raw === 'object' && 'value' in raw ? raw.value : raw;
      const diagnostic = readTextDiagnostic(
        body && typeof body === 'object' && 'textDiagnostic' in body ? body.textDiagnostic : undefined,
      );
      if (
        recovery.status === 'invalid' &&
        recovery.problem?.code === 'unsupported_query' &&
        recovery.problem.errors?.some(({ pointer }) => pointer === '/text') &&
        typeof submittedText === 'string' &&
        diagnostic &&
        JSON.stringify(diagnoseText(submittedText)) === JSON.stringify(diagnostic)
      ) {
        recovery.textError = { query: submittedText, diagnostic };
      }
      return { recovery };
    }
    if (request.representation === 'discovery-v1') {
      const page = parseDiscoveryPage(response.data);
      if (page && request.cursor && page.hits.length === 0 && page.next === null)
        return { recovery: { status: 'exhausted', asOf: page.as_of } };
      if (page && page.hits.length === 0 && page.next !== null)
        return { recovery: { status: 'sparse', asOf: page.as_of } };
      if (page && usefulPage(page.hits.length, page.next, request.cursor))
        return { recovery: { status: 'ready' }, discovery: { status: 'ready', page } };
    } else {
      const result = parseLegacySearchPage(response.data);
      if (result && request.cursor && result.subjects.length === 0 && result.next === null)
        return { recovery: { status: 'exhausted', asOf: result.as_of } };
      if (result && result.subjects.length === 0 && result.next !== null)
        return { recovery: { status: 'sparse', asOf: result.as_of } };
      if (result && usefulPage(result.subjects.length, result.next, request.cursor))
        return { recovery: { status: 'ready' }, result };
    }
    return { recovery: { status: 'unavailable' } };
  } catch (error) {
    if (signal?.aborted) throw error;
    if (error instanceof Error && error.name === 'AbortError') throw error;
    return {
      recovery: isPlatformClosedError(error)
        ? searchRecoveryFromResponse({ status: error.status, error: error.problem })
        : { status: 'unavailable' },
    };
  }
}

/** A failed BFF transport retains the URL draft even when no metadata response reached the browser. */
export function searchUnavailablePage(
  state: SearchLoaderDeps,
  metadata?: SearchPageData['conditionMetadata'],
): SearchPageData {
  return {
    queryState: state,
    ...(metadata ? { conditionMetadata: metadata } : {}),
    ...(state.condition ? { condition: state.condition } : {}),
    ...(state.ranges ? { ranges: state.ranges } : {}),
    ...(state.type ? { type: state.type } : {}),
    recovery: { status: 'unavailable' },
    hitTypes: {},
    yearProperties: [],
    typeChoices: [],
    groups: [],
    selectedFacets: state.facets,
    selectedFacetLabels: {},
    facetsAvailable: false,
    facetRetry: false,
    facetIndexNotReady: false,
    staleCursorRestarted: false,
    sort: state.sort ?? 'relevance',
  };
}

function usefulPage(length: number, next: string | null, cursor: string | undefined): boolean {
  return next === null || (length > 0 && next.length > 0 && next.length <= 4864 && next !== cursor);
}

/** A current facet authority/restart refusal invalidates the whole displayed query; outages stay scoped. */
export function facetSearchInvalidation(state: FacetState | undefined): SearchRecoveryState | undefined {
  if (!state || state.status === 'ready' || ![401, 403, 409].includes(state.httpStatus ?? 0)) return;
  return searchRecoveryFromResponse({ status: state.httpStatus!, error: state.problem ?? { code: state.code } });
}

/** Never keep protected rows, kind labels or facet pages behind a recovery message or a pending read. */
export function searchPageForRecovery(data: SearchPageData, recovery = data.recovery): SearchPageData {
  if (!recovery || recovery.status === 'ready') return data;
  const { result: _result, discovery: _discovery, refinement: _refinement, problem: _problem, ...retained } = data;
  return {
    ...retained,
    recovery,
    ...('problem' in recovery && recovery.problem ? { problem: recovery.problem } : {}),
    hitTypes: {},
    typeChoices: [],
    groups: [],
    selectedFacetLabels: {},
    facetRetry: false,
  };
}
