import type { KernelClient } from '@rezics/client';
import { isPlatformClosedError } from '../../kernel/platform-closed';

/** Inferred from Content's mounted FeedPageSchema, never a parallel browser DTO. */
export type FeedPage = NonNullable<Awaited<ReturnType<KernelClient['feedItems']['get']>>['data']>;
export type FeedItem = FeedPage['feedItems'][number];
export type FeedStream = 'home' | 'following';
export type FeedInput = { stream: FeedStream; cursor?: string };
export type FeedFailure = 'request' | 'auth' | 'denied' | 'closed' | 'cursor' | 'deadline' | 'unavailable';
export type HomeFeedResult = { state: 'ready'; page: FeedPage } | { state: FeedFailure | 'loading'; code: string };
export const HOME_FEED_LIMIT = 20;

function failure(status: number, value: unknown): HomeFeedResult {
  const code =
    value && typeof value === 'object' && 'code' in value && typeof value.code === 'string'
      ? value.code
      : 'dependency_unavailable';
  const state: FeedFailure =
    code === 'platform_closed'
      ? 'closed'
      : ['invalid_cursor', 'stale_cursor', 'search_restart_required'].includes(code)
        ? 'cursor'
        : code === 'deadline_exceeded'
          ? 'deadline'
          : status === 401
            ? 'auth'
            : status === 403
              ? 'denied'
              : status === 400
                ? 'request'
                : 'unavailable';
  return { state, code };
}

/** One native read carries ordered rows, owner summaries and the original signed frontier. */
export async function readHomeFeedPage(
  client: KernelClient,
  input: FeedInput = { stream: 'home' },
  authorization?: string,
  signal?: AbortSignal,
): Promise<HomeFeedResult> {
  try {
    const result = await client.feedItems.get({
      query: { ...input, limit: HOME_FEED_LIMIT },
      ...(authorization ? { headers: { authorization } } : {}),
      fetch: { cache: 'no-store', redirect: 'manual', ...(signal ? { signal } : {}) },
    });
    if (result.status !== 200 || result.error || !result.data) return failure(result.status, result.error?.value);
    const page = result.data;
    // A malformed or incorrectly scoped response must not expose private rows in a public page.
    if (
      !Array.isArray(page.feedItems) ||
      page.feedItems.length > HOME_FEED_LIMIT ||
      (!authorization &&
        (page.sources.following !== 'not_requested' ||
          page.sources.continue !== 'not_requested' ||
          page.feedItems.some((item) => item.source !== 'discovery')))
    )
      return { state: 'unavailable', code: 'invalid_feed_response' };
    return { state: 'ready', page };
  } catch (error) {
    return {
      state: isPlatformClosedError(error) ? 'closed' : 'unavailable',
      code: isPlatformClosedError(error) ? 'platform_closed' : 'dependency_unavailable',
    };
  }
}

/** Public loader and browser continuation deliberately never inspect a session. */
export function loadPublicHomeFeed(client: KernelClient, cursor?: string) {
  return readHomeFeedPage(client, { stream: 'home', ...(cursor === undefined ? {} : { cursor }) });
}

export type FeedWindow = { result: HomeFeedResult; busy: boolean; input: FeedInput };
/** A single displayed page. Replaced pages and late responses never accumulate in a query cache. */
export function createHomeFeedWindow(initial: HomeFeedResult, read: (input: FeedInput) => Promise<HomeFeedResult>) {
  let snapshot: FeedWindow = { result: initial, busy: false, input: { stream: 'home' } };
  let generation = 0;
  const listeners = new Set<() => void>();
  const emit = () => {
    for (const listener of listeners) listener();
  };
  return {
    snapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    clear: () => {
      generation++;
      snapshot = { result: initial, busy: false, input: { stream: 'home' } };
      emit();
    },
    async load(input: FeedInput) {
      const current = ++generation;
      snapshot = {
        result: input.stream === snapshot.input.stream ? snapshot.result : { state: 'loading', code: 'loading' },
        busy: true,
        input,
      };
      emit();
      let result: HomeFeedResult;
      try {
        result = await read(input);
      } catch {
        result = { state: 'unavailable', code: 'dependency_unavailable' };
      }
      if (generation !== current) return;
      snapshot = { result, busy: false, input };
      emit();
    },
  };
}

/** Session authority, including rotation, selects a fresh private window before rendering any prior rows. */
export function homeFeedViewer(session: { state: string; subject?: string | null; csrfToken: string | null }) {
  return session.state === 'signed-in' && session.subject && session.csrfToken
    ? { subject: session.subject, scope: `${session.subject}:${session.csrfToken}` }
    : null;
}
