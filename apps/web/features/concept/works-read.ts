import type { UiLocale } from '../../i18n/define.ts';
import { type MainClient, problemCode } from '../discover/types.ts';
import { type ConceptState, conceptQuery } from './state.ts';
import { type ConceptWorksPage, failureOf, type Loaded } from './types.ts';

// Reads shared by the server render and the browser's "Show more": each takes
// the Eden client for its side and returns `Loaded` instead of throwing.

type Answer<T> = { data: T | null; error: { status: number; value: unknown } | null };

export async function settle<T>(call: () => Promise<Answer<T>>): Promise<Loaded<T>> {
  try {
    const { data, error } = await call();
    if (error) return { ok: false, failure: failureOf(error.status, problemCode(error.value)) };
    return data === null ? { ok: false, failure: 'unavailable' } : { ok: true, data };
  } catch {
    return { ok: false, failure: 'unavailable' };
  }
}

/**
 * One page of the Works the Condition bar selects. A first page cannot have
 * moved under a cursor, so Main is asked again once when the graph moved while it read.
 */
export async function readConceptWorks(main: MainClient, state: ConceptState, locale: UiLocale,
  cursor?: string): Promise<Loaded<ConceptWorksPage>> {
  const query = conceptQuery(state, cursor);
  const read = async (): Promise<Loaded<ConceptWorksPage>> => {
    const response = await settle(() => main.v1.query.post(query, { headers: { 'accept-language': locale } }));
    return response.ok ? response.data.result.profile === 'concept-works-v1'
      ? { ok: true, data: response.data.result } : { ok: false, failure: 'invalid' } : response;
  };
  const first = await read();
  return !first.ok && first.failure === 'moved' && !cursor ? read() : first;
}
