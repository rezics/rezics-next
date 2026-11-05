import { pickText } from '@rezics/composition';
import { parseSuggestionPage } from './header-search/suggestion-page';
import {
  conditionConceptReferenceFor,
  conditionConceptRetryAdvice,
  parseConditionConceptReference,
  type ConditionConceptChoice,
  type ConditionConceptLookup,
  type ConditionConceptReference,
} from './condition-concept-model';

export { conditionConceptReferenceFor, parseConditionConceptReference };
export type { ConditionConceptChoice, ConditionConceptLookup, ConditionConceptReference };

export type ConditionConceptSuggestions = Readonly<
  | { status: 'ready'; choices: readonly ConditionConceptChoice[] }
  | {
      status: 'preparing' | 'restart' | 'unsupported' | 'unavailable' | 'refused';
      choices: readonly [];
      retryAfter?: string | undefined;
    }
>;

function retryableResult(status: 'preparing' | 'unavailable', response: Response): ConditionConceptSuggestions {
  const retryAfter = conditionConceptRetryAdvice(response.headers.get('retry-after'));
  return { status, choices: [], ...(retryAfter ? { retryAfter } : {}) };
}

async function responseCode(response: Response): Promise<unknown> {
  try {
    const body: unknown = await response.clone().json();
    return body && typeof body === 'object' && !Array.isArray(body)
      ? (body as Record<string, unknown>).code
      : undefined;
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof TypeError) return;
    throw error;
  }
}

async function suggestionFailure(response: Response): Promise<ConditionConceptSuggestions> {
  const status = response.status;
  if (status === 409) return { status: 'restart', choices: [] };
  if (status === 403 || status === 401) return { status: 'refused', choices: [] };
  if (status === 404 || status === 422) return { status: 'unsupported', choices: [] };
  if (status === 503 && (await responseCode(response)) === 'index_not_ready')
    return retryableResult('preparing', response);
  return retryableResult('unavailable', response);
}

export async function searchConditionConcepts(
  query: string,
  locale: string,
  signal: AbortSignal,
  lookup: ConditionConceptLookup,
): Promise<ConditionConceptSuggestions> {
  if (!lookup.enabled || !lookup.filter || !lookup.releaseDigest || query.trim().length < 2)
    return { status: 'unavailable', choices: [] };
  const params = new URLSearchParams({ q: query, locale, filter: lookup.filter, digest: lookup.releaseDigest });
  let response: Response;
  try {
    response = await fetch(`/api/search/suggestions?${params}`, {
      signal,
      credentials: 'same-origin',
      cache: 'no-store',
    });
  } catch (error) {
    if (signal.aborted || error instanceof TypeError) return { status: 'unavailable', choices: [] };
    throw error;
  }
  if (signal.aborted) return { status: 'unavailable', choices: [] };
  // Response.ok includes 202. The BFF preserves this native preparation status.
  if (response.status === 202) return retryableResult('preparing', response);
  if (!response.ok) return suggestionFailure(response);
  try {
    const result = parseSuggestionPage(await response.json());
    if (signal.aborted) return { status: 'unavailable', choices: [] };
    return {
      status: 'ready',
      choices: result.subjects.map((subject) => ({
        id: subject.id,
        label: subject.summary?.label?.value || pickText(subject.labels, locale).text || subject.id,
      })),
    };
  } catch (error) {
    if (signal.aborted || error instanceof SyntaxError || error instanceof TypeError)
      return { status: 'unavailable', choices: [] };
    throw error;
  }
}

export async function readConditionConceptReference(
  id: string,
  locale: string,
  lookup: ConditionConceptLookup,
  signal: AbortSignal,
): Promise<ConditionConceptReference> {
  if (!lookup.enabled || !lookup.releaseDigest) return { status: 'unavailable', id };
  const params = new URLSearchParams({ concept: id, digest: lookup.releaseDigest, locale });
  let response: Response;
  try {
    response = await fetch(`/api/search/suggestions?${params}`, {
      signal,
      credentials: 'same-origin',
      cache: 'no-store',
    });
  } catch (error) {
    if (signal.aborted || error instanceof TypeError) return { status: 'unavailable', id };
    throw error;
  }
  if (signal.aborted) return { status: 'unavailable', id };
  const retryAfter = conditionConceptRetryAdvice(response.headers.get('retry-after'));
  // Response.ok includes 202. Keep the native preparation advice visible to the reader.
  if (response.status === 202) return { status: 'preparing', id, ...(retryAfter ? { retryAfter } : {}) };
  if (!response.ok) {
    if (response.status === 403 || response.status === 401) return { status: 'refused', id };
    if (response.status === 404 || response.status === 422) return { status: 'unsupported', id };
    if (response.status === 409) return { status: 'restart', id };
    if (response.status === 503 && (await responseCode(response)) === 'index_not_ready')
      return { status: 'preparing', id, ...(retryAfter ? { retryAfter } : {}) };
    return { status: 'unavailable', id, ...(retryAfter ? { retryAfter } : {}) };
  }
  if (signal.aborted) return { status: 'unavailable', id };
  try {
    const reference = parseConditionConceptReference(await response.json(), id);
    if (reference.status !== 'preparing' && reference.status !== 'unavailable') return reference;
    const advice = retryAfter ?? reference.retryAfter;
    return { ...reference, ...(advice ? { retryAfter: advice } : {}) };
  } catch (error) {
    if (signal.aborted || error instanceof SyntaxError || error instanceof TypeError)
      return { status: 'unavailable', id };
    throw error;
  }
}

export function conceptChoiceLabel(choice: ConditionConceptChoice | undefined, fallback: string): string {
  return choice?.label || fallback;
}
