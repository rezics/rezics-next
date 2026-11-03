import type { KernelClient } from '@rezics/client';
import { parseDiscoveryFilter } from '@rezics/filter';
import { isPlatformClosedError } from '../../kernel/platform-closed';

/** Inferred from Content's mounted FeedPageSchema, never a parallel browser DTO. */
type ClientFeedPage = NonNullable<Awaited<ReturnType<KernelClient['feedItems']['get']>>['data']>;
type AccountSummary = Extract<
  ClientFeedPage['feedItems'][number],
  { source: 'discovery'; key: { owner: 'accounts' } }
>['summary'];
export type HomeReviewSubject = { id: string; title?: string | null };
/** Additive native summary seam until the generated client includes Content's optional fields. */
type WithContentSummary<Item> = Item extends { key: { owner: 'content' }; summary: infer Summary }
  ? Omit<Item, 'summary'> & {
      summary: Summary & {
        author?: Pick<AccountSummary, 'displayName' | 'handle' | 'avatar'>;
        excerpt?: string;
        subject?: HomeReviewSubject;
      };
    }
  : Item;
/** Public discovery Collection rows until Search registers that kind and Content discloses them. */
export type HomeDiscoveryCollectionItem = {
  id: string;
  occurredAt: string | null;
  source: 'discovery';
  key: { owner: 'library'; kind: 'collection'; route: number; id: string };
  summary: { id: string; title: string; description: string | null };
  destination: { kind: 'collection'; id: string; title: string | null };
};
/** Space feed rows until Content/Community disclose this branch. Realm is carrier context only. */
export type HomeSpaceFeedItem = {
  id: string;
  occurredAt: string | null;
  source: 'discovery' | 'following';
  key: { owner: 'community'; kind: 'space'; route: number; id: string };
  summary: {
    id: string;
    title: string;
    address: string | null;
    summary?: string;
    realm?: { id: string; title?: string | null } | null;
  };
  destination: { kind: 'space'; id: string; title: string | null; address: string | null };
};
export type HomePendingFeedItem = HomeDiscoveryCollectionItem | HomeSpaceFeedItem;
export type FeedPage = Omit<ClientFeedPage, 'feedItems'> & {
  feedItems: Array<WithContentSummary<ClientFeedPage['feedItems'][number]> | HomePendingFeedItem>;
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
export const HOME_FEED_HISTORY_KEY = 'rezicsHomeFeed';
export const HOME_FEED_HISTORY_CURSOR_LIMIT = 32_768;
export type HomeFeedNavigationDescriptor = {
  version: 1;
  origin: string;
  pathname: string;
  locale: string;
  input: FeedInput;
  frontierUnavailable?: true;
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

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isHomePath(pathname: string, locale: string): boolean {
  const prefix = `/${encodeURIComponent(locale)}`;
  return pathname === '/' || pathname === prefix || pathname === `${prefix}/`;
}

function validFeedInput(value: unknown): FeedInput | undefined {
  if (!record(value) || !['home', 'following'].includes(String(value.stream))) return;
  const keys = Object.keys(value);
  if (keys.some((key) => !['stream', 'cursor', 'kind', 'spaceId', 'ratingQuestionId'].includes(key))) return;
  if (
    value.cursor !== undefined &&
    (typeof value.cursor !== 'string' ||
      value.cursor.length < 1 ||
      value.cursor.length > HOME_FEED_HISTORY_CURSOR_LIMIT)
  )
    return;
  if (value.kind !== undefined) {
    if (typeof value.kind !== 'string') return;
    try {
      parseDiscoveryFilter({ kind: { in: [value.kind] } });
    } catch {
      return;
    }
  }
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (value.spaceId !== undefined && (typeof value.spaceId !== 'string' || !uuid.test(value.spaceId))) return;
  if (
    value.ratingQuestionId !== undefined &&
    (typeof value.ratingQuestionId !== 'string' || !uuid.test(value.ratingQuestionId))
  )
    return;
  return {
    stream: value.stream as FeedStream,
    ...(typeof value.cursor === 'string' ? { cursor: value.cursor } : {}),
    ...(typeof value.kind === 'string' ? { kind: value.kind } : {}),
    ...(typeof value.spaceId === 'string' ? { spaceId: value.spaceId } : {}),
    ...(typeof value.ratingQuestionId === 'string' ? { ratingQuestionId: value.ratingQuestionId } : {}),
  };
}

/** Store only the current native selection and signed frontier, never rows or URL filters. */
export function homeFeedNavigationDescriptor(
  input: FeedInput,
  location: { origin: string; pathname: string },
  locale: string,
): HomeFeedNavigationDescriptor | undefined {
  if (!isHomePath(location.pathname, locale)) return;
  let origin: string;
  try {
    const parsed = new URL(location.origin);
    if (parsed.origin !== location.origin || !['http:', 'https:'].includes(parsed.protocol)) return;
    origin = parsed.origin;
  } catch {
    return;
  }
  const frontierUnavailable = typeof input.cursor === 'string' && input.cursor.length > HOME_FEED_HISTORY_CURSOR_LIMIT;
  const { cursor: _cursor, ...selection } = input;
  const boundedInput: FeedInput = frontierUnavailable ? selection : input;
  const validated = validFeedInput(boundedInput);
  if (!validated) return;
  return {
    version: 1,
    origin,
    pathname: location.pathname,
    locale,
    input: validated,
    ...(frontierUnavailable ? { frontierUnavailable: true as const } : {}),
  };
}

/** A descriptor is usable only at its original same-origin localized Home entry. */
export function readHomeFeedNavigationDescriptor(
  state: unknown,
  location: { origin: string; pathname: string },
  locale: string,
): HomeFeedNavigationDescriptor | undefined {
  if (!record(state) || !record(state[HOME_FEED_HISTORY_KEY])) return;
  const descriptor = state[HOME_FEED_HISTORY_KEY];
  const descriptorKeys = Object.keys(descriptor).sort().join(',');
  if (
    !['input,locale,origin,pathname,version', 'frontierUnavailable,input,locale,origin,pathname,version'].includes(
      descriptorKeys,
    ) ||
    descriptor.version !== 1 ||
    descriptor.origin !== location.origin ||
    descriptor.pathname !== location.pathname ||
    descriptor.locale !== locale ||
    typeof descriptor.pathname !== 'string' ||
    !isHomePath(descriptor.pathname, locale)
  )
    return;
  if (descriptor.frontierUnavailable !== undefined && descriptor.frontierUnavailable !== true) return;
  const input = validFeedInput(descriptor.input);
  if (!input) return;
  if (descriptor.frontierUnavailable === true && input.cursor !== undefined) return;
  return {
    version: 1,
    origin: location.origin,
    pathname: location.pathname,
    locale,
    input,
    ...(descriptor.frontierUnavailable === true ? { frontierUnavailable: true } : {}),
  };
}

export function homeFeedHistoryState(
  state: unknown,
  descriptor?: HomeFeedNavigationDescriptor,
): Record<string, unknown> {
  const next = record(state) ? { ...state } : {};
  if (descriptor) next[HOME_FEED_HISTORY_KEY] = descriptor;
  else delete next[HOME_FEED_HISTORY_KEY];
  return next;
}
