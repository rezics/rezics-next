import { type FeedPage, type FeedQuery, isOfflineError, type Loaded, type MainClient, settle } from './types.ts';

/** Keep Main's status and problem at the feed boundary; 403 is not an expired session. */
export async function settleFeedRead<T>(call: () => Promise<{
  data: T | null; error: { status: number; value: unknown } | null;
  headers?: unknown; response?: { headers?: unknown };
}>): Promise<Loaded<T>> {
  let refused: { status: number; value: unknown } | null = null;
  const read = await settle(async () => {
    const answer = await call();
    refused = answer.error;
    return answer;
  });
  if (read.ok || !refused) return read;
  const { status, value: problem } = refused as { status: number; value: unknown };
  // Eden wraps a failed transport in a synthetic 503; there was no Main answer to retain.
  if (problem instanceof Error || problem instanceof DOMException)
    return { ok: false, failure: isOfflineError(problem) ? 'offline' : 'unavailable' };
  return { ...read, ...(status === 403 && read.failure !== 'closed' ? { failure: 'unavailable' as const } : {}),
    status, problem };
}

/** Only a first-page 409 can restart once. A successor belongs to its exact cursor chain. */
export async function readFeedPage(main: MainClient, query: FeedQuery): Promise<Loaded<FeedPage>> {
  const read = () => settleFeedRead(() => main.v1.feed.get({ query: { ...query, actingSubject: query.actingSubject } }));
  const first = await read();
  return !query.cursor && !first.ok && first.failure === 'moved' ? read() : first;
}

/** Head counts can describe only the scopes Main supports, never an approximation of filters. */
export function feedHeadScope(query: FeedQuery): string | null {
  if (query.savedFilter || query.contentLanguages?.length || query.kinds?.length || query.interests ||
    query.concepts?.length || query.requiredConcept || query.excludedConcepts?.length) return null;
  if (query.realms?.length) return query.realms.length === 1 ? `realm:${query.realms[0]}` : null;
  return query.scope ?? 'all';
}
