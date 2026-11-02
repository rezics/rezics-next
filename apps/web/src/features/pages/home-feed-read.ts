import type { KernelClient } from '@rezics/client';
import { isPlatformClosedError } from '../../kernel/platform-closed';

/** Inferred from Content's mounted FeedPageSchema, never a parallel browser DTO. */
type ClientFeedPage = NonNullable<Awaited<ReturnType<KernelClient['feedItems']['get']>>['data']>;
type AccountSummary = Extract<
  ClientFeedPage['feedItems'][number],
  { source: 'discovery'; key: { owner: 'accounts' } }
>['summary'];
/** Additive native summary seam until the dev landing regenerates the client. */
type WithContentSummary<Item> = Item extends { key: { owner: 'content' }; summary: infer Summary }
  ? Omit<Item, 'summary'> & {
      summary: Summary & {
        author?: Pick<AccountSummary, 'displayName' | 'handle' | 'avatar'>;
        excerpt?: string;
      };
    }
  : Item;
export type FeedPage = Omit<ClientFeedPage, 'feedItems'> & {
  feedItems: WithContentSummary<ClientFeedPage['feedItems'][number]>[];
};
export type FeedItem = FeedPage['feedItems'][number];
export type FeedStream = 'home' | 'following';
export type FeedInput = {
  stream: FeedStream;
  cursor?: string;
  kind?: string;
  spaceId?: string;
  ratingQuestionId?: string;
};
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
              : status === 400 || status === 422
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
export function loadPublicHomeFeed(
  client: KernelClient,
  cursor?: string,
  kind?: string,
  signal?: AbortSignal,
  selection: Pick<FeedInput, 'spaceId' | 'ratingQuestionId'> = {},
) {
  return readHomeFeedPage(
    client,
    {
      ...selection,
      stream: 'home',
      ...(cursor === undefined ? {} : { cursor }),
      ...(kind === undefined ? {} : { kind }),
    },
    undefined,
    signal,
  );
}

export type FeedWindow = { result: HomeFeedResult; busy: boolean; input: FeedInput };
/** A single displayed page. Replaced pages and late responses never accumulate in a query cache. */
export function createHomeFeedWindow(
  initial: HomeFeedResult,
  read: (input: FeedInput, signal: AbortSignal) => Promise<HomeFeedResult>,
) {
  let snapshot: FeedWindow = { result: initial, busy: false, input: { stream: 'home' } };
  let generation = 0;
  let pending: AbortController | undefined;
  let completion: Promise<void> | undefined;
  const listeners = new Set<() => void>();
  const selectionListeners = new Set<() => void>();
  let selectionIdentity = JSON.stringify(['home', null, null, null]);
  const emit = () => {
    const { stream, kind, spaceId, ratingQuestionId } = snapshot.input;
    const nextIdentity = JSON.stringify([stream, kind ?? null, spaceId ?? null, ratingQuestionId ?? null]);
    if (nextIdentity !== selectionIdentity) {
      selectionIdentity = nextIdentity;
      for (const listener of selectionListeners) listener();
    }
    for (const listener of listeners) listener();
  };
  return {
    snapshot: () => snapshot,
    onSelectionChange: (listener: () => void) => {
      selectionListeners.add(listener);
      return () => {
        selectionListeners.delete(listener);
      };
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    clear: () => {
      generation++;
      pending?.abort();
      snapshot = { result: initial, busy: false, input: { stream: 'home' } };
      emit();
    },
    retire: (result: HomeFeedResult = { state: 'loading', code: 'loading' }, input: FeedInput = snapshot.input) => {
      generation++;
      pending?.abort();
      const { cursor: _cursor, ...selection } = input;
      snapshot = { result, busy: false, input: selection };
      emit();
    },
    load(input: FeedInput): Promise<void> {
      // A repeated Next click shares the in-flight selection/frontier. A new selection
      // still aborts the old generation and removes its private rows synchronously.
      if (
        snapshot.busy &&
        input.stream === snapshot.input.stream &&
        input.cursor === snapshot.input.cursor &&
        input.kind === snapshot.input.kind &&
        input.spaceId === snapshot.input.spaceId &&
        input.ratingQuestionId === snapshot.input.ratingQuestionId
      )
        return completion!;
      input = { ...input };
      const current = ++generation;
      pending?.abort();
      const controller = new AbortController();
      pending = controller;
      // Install completion before notifying subscribers, so reentrant callers
      // also join the actual request rather than completing ahead of it.
      let complete!: () => void;
      const done = new Promise<void>((resolve) => {
        complete = resolve;
      });
      completion = done;
      snapshot = {
        result:
          input.stream === snapshot.input.stream &&
          input.kind === snapshot.input.kind &&
          input.spaceId === snapshot.input.spaceId &&
          input.ratingQuestionId === snapshot.input.ratingQuestionId
            ? snapshot.result
            : { state: 'loading', code: 'loading' },
        busy: true,
        input,
      };
      emit();
      void (async () => {
        try {
          let result: HomeFeedResult;
          try {
            result = await read(input, controller.signal);
          } catch {
            result = { state: 'unavailable', code: 'dependency_unavailable' };
          }
          if (generation !== current) return;
          snapshot = { result, busy: false, input };
          emit();
        } finally {
          complete();
        }
      })();
      return done;
    },
  };
}

/** Session authority, including rotation, selects a fresh private window before rendering any prior rows. */
export function homeFeedViewer(session: { state: string; subject?: string | null; csrfToken: string | null }) {
  return session.state === 'signed-in' && session.subject && session.csrfToken
    ? { subject: session.subject, scope: `${session.subject}:${session.csrfToken}` }
    : null;
}
