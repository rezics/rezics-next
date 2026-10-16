import type { MainClient } from '../discover/types.ts';
import { failedRead, isOfflineError } from '../feed/types.ts';
import { failureOf, type FacetList, type Loaded, type ZoneBrowsePage, type ZoneBrowseQuery } from './types.ts';

type Answer<T> = {
  data: T | null;
  error: { status: number; value?: unknown } | null;
  headers?: unknown;
  response?: { headers?: unknown };
};

/** A moved first page starts again once; a moved cursor is the reader's to restart. */
export async function settleRealmRead<T>(call: () => Promise<Answer<T>>, cursor?: string): Promise<Loaded<T>> {
  try {
    let answer = await call();
    if (answer.error?.status === 409 && !cursor) answer = await call();
    const { data, error } = answer;
    if ((error?.value instanceof Error || error?.value instanceof DOMException) && !answer.response)
      return { ok: false, failure: isOfflineError(error.value) ? 'offline' : 'unavailable' };
    if (error) return failedRead(failureOf(error.status, error.value), error.value,
      answer.headers ?? answer.response?.headers, error.status);
    return data === null ? { ok: false, failure: 'unavailable' } : { ok: true, data };
  } catch (error) {
    return { ok: false, failure: isOfflineError(error) ? 'offline' : 'unavailable' };
  }
}

/** The route and recorded stories read through the same typed client and failure adapter. */
export function readBrowseAnswer(main: MainClient, realm: string, query: ZoneBrowseQuery): Promise<Loaded<ZoneBrowsePage>> {
  return settleRealmRead(() => main.v1.realms({ realm }).modules.browse.get({
    query: { ...query, actingSubject: query.actingSubject },
  }), query.cursor);
}

export function readFacetAnswer(main: MainClient): Promise<Loaded<FacetList>> {
  return settleRealmRead(() => main.v1.facets.get());
}
