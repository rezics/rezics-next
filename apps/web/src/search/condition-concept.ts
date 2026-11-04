import { pickText } from '@rezics/composition';
import { parseSuggestionPage } from './header-search/suggestion-page';
import {
  conditionConceptReferenceFor,
  parseConditionConceptReference,
  type ConditionConceptChoice,
  type ConditionConceptLookup,
  type ConditionConceptReference,
} from './condition-concept-model';

export { conditionConceptReferenceFor, parseConditionConceptReference };
export type { ConditionConceptChoice, ConditionConceptLookup, ConditionConceptReference };

export type ConditionConceptSuggestions = Readonly<
  | { status: 'ready'; choices: readonly ConditionConceptChoice[] }
  | { status: 'preparing' | 'restart' | 'unsupported' | 'unavailable' | 'refused'; choices: readonly [] }
>;

export async function searchConditionConcepts(
  query: string,
  locale: string,
  signal: AbortSignal,
  lookup: ConditionConceptLookup,
): Promise<ConditionConceptSuggestions> {
  if (!lookup.enabled || !lookup.filter || !lookup.releaseDigest || query.trim().length < 2)
    return { status: 'unavailable', choices: [] };
  const params = new URLSearchParams({ q: query, locale, filter: lookup.filter, digest: lookup.releaseDigest });
  try {
    const response = await fetch(`/api/search/suggestions?${params}`, {
      signal,
      credentials: 'same-origin',
      cache: 'no-store',
    });
    if (signal.aborted) return { status: 'unavailable', choices: [] };
    if (!response.ok) {
      if (response.status === 202) return { status: 'preparing', choices: [] };
      if (response.status === 409) return { status: 'restart', choices: [] };
      if (response.status === 403 || response.status === 401) return { status: 'refused', choices: [] };
      if (response.status === 404 || response.status === 422) return { status: 'unsupported', choices: [] };
      return { status: 'unavailable', choices: [] };
    }
    const result = parseSuggestionPage(await response.json());
    if (signal.aborted) return { status: 'unavailable', choices: [] };
    return {
      status: 'ready',
      choices: result.subjects.map((subject) => ({
        id: subject.id,
        label: subject.summary?.label?.value || pickText(subject.labels, locale).text || subject.id,
      })),
    };
  } catch {
    return { status: 'unavailable', choices: [] };
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
  const response = await fetch(`/api/search/suggestions?${params}`, {
    signal,
    credentials: 'same-origin',
    cache: 'no-store',
  });
  if (!response.ok) {
    if (response.status === 202) return { status: 'preparing', id };
    if (response.status === 403) return { status: 'refused', id };
    if (response.status === 404 || response.status === 422) return { status: 'unsupported', id };
    if (response.status === 409) return { status: 'restart', id };
    return { status: 'unavailable', id };
  }
  if (signal.aborted) return { status: 'unavailable', id };
  return parseConditionConceptReference(await response.json(), id);
}

export function conceptChoiceLabel(choice: ConditionConceptChoice | undefined, fallback: string): string {
  return choice?.label || fallback;
}
