import { queryOptions, type QueryClient } from '@tanstack/react-query';
import { personalRead, readQueryKey } from '../kernel/query';
import { preferenceRetryDeadline } from '../settings/preference-failure-retry';
import {
  DEFAULT_INBOX_SELECTION,
  InboxSeenError,
  inboxReadFailure,
  markInboxItemSeen,
  markInboxSeen,
  readInboxPage,
  readUnreadCount,
  type InboxNoticeSeenAttempt,
  type InboxPage,
  type InboxPageQuery,
  type InboxSeenAttempt,
  type InboxSeenResult,
  type InboxSelection,
  type UnreadCount,
} from './inbox-read';
import { inboxObservationRecovery, type InboxObservationRecovery } from './inbox-acknowledgement-recovery';
import { forInboxViewer, inboxViewerCsrfToken, type InboxViewer } from './inbox-viewer';

const inboxKey = readQueryKey(['notifications', 'inbox'], 'session');

export function inboxViewerQueryKey(viewer: InboxViewer) {
  return [...inboxKey, viewer.subject, viewer.epoch] as const;
}

export type InboxPageLoader = (query: InboxPageQuery, signal?: AbortSignal) => Promise<InboxPage>;

const loadNativeInboxPage: InboxPageLoader = (query, signal) =>
  readInboxPage({ data: query, ...(signal ? { signal } : {}) });

export function inboxPageQuery(
  viewer: InboxViewer,
  cursor?: string,
  loadPage: InboxPageLoader = loadNativeInboxPage,
  selection: InboxSelection = DEFAULT_INBOX_SELECTION,
  episode = 1,
  ownerCurrent: () => boolean = () => viewer.isCurrent(),
  pageInstance = 'default',
  readId = 0,
) {
  const query: InboxPageQuery = { selection, ...(cursor ? { cursor } : {}) };
  return queryOptions({
    ...personalRead,
    // Each direction change and mounted return receives a fresh key. A prior cached payload
    // can never stand in for native admission of the same opaque address.
    queryKey: [...inboxViewerQueryKey(viewer), episode, selection, cursor ?? null, pageInstance, readId],
    queryFn: ({ signal }) =>
      forInboxViewer(
        viewer,
        async () => {
          if (!ownerCurrent()) throw new DOMException('Inbox owner changed', 'AbortError');
          const result = await loadPage(query, signal);
          if (!ownerCurrent()) throw new DOMException('Inbox owner changed', 'AbortError');
          return result;
        },
        signal,
      ),
    retry: false,
    gcTime: 0,
    enabled: typeof globalThis.window !== 'undefined' && ownerCurrent(),
  });
}

const unreadCountDefaults = {
  ...personalRead,
  staleTime: 60_000,
  retry: false,
} as const;

const unreadCountObservations = new WeakMap<InboxViewer, { retryAt: number; last: UnreadCount }>();

export function unreadCountRetryAt(viewer: InboxViewer): number {
  return unreadCountObservations.get(viewer)?.retryAt ?? 0;
}

export function unreadCountFetchBlocked(viewer: InboxViewer, now = Date.now()): boolean {
  return unreadCountRetryAt(viewer) > now;
}

function rememberUnreadCount(viewer: InboxViewer, result: UnreadCount, now = Date.now()) {
  unreadCountObservations.set(viewer, {
    retryAt:
      result.signedIn && result.state === 'unavailable' ? preferenceRetryDeadline(result.failure.retryAfter, now) : 0,
    last: result,
  });
  return result;
}

export async function fetchInboxUnreadCount(viewer: InboxViewer, signal?: AbortSignal): Promise<UnreadCount> {
  if (signal?.aborted || !viewer.isCurrent()) throw new DOMException('Inbox viewer changed', 'AbortError');
  if (unreadCountFetchBlocked(viewer)) {
    const last = unreadCountObservations.get(viewer)?.last;
    if (last) return last;
    throw new DOMException('Inbox viewer unavailable', 'AbortError');
  }
  return forInboxViewer(
    viewer,
    async () => rememberUnreadCount(viewer, await readUnreadCount(signal ? { signal } : {})),
    signal,
  );
}

// Retain the fixed prefix for existing cache invalidation consumers.
export const unreadCountQuery = queryOptions({
  ...unreadCountDefaults,
  queryKey: readQueryKey(['notifications', 'count'], 'session'),
  queryFn: () => readUnreadCount(),
});

export function unreadCountQueryFor(viewer: InboxViewer | null) {
  const admitFetch = () => viewer !== null && viewer.isCurrent() && !unreadCountFetchBlocked(viewer);
  return queryOptions({
    ...unreadCountDefaults,
    queryKey: [...unreadCountQuery.queryKey, viewer?.subject ?? null, viewer?.epoch ?? null],
    queryFn: ({ signal }) => {
      if (!viewer) throw new DOMException('Inbox viewer unavailable', 'AbortError');
      return fetchInboxUnreadCount(viewer, signal);
    },
    enabled: typeof globalThis.window !== 'undefined' && viewer !== null && viewer.isCurrent(),
    gcTime: 0,
    refetchOnWindowFocus: admitFetch,
    refetchOnReconnect: admitFetch,
    refetchOnMount: admitFetch,
  });
}

type SeenTransport = (request: { data: InboxSeenAttempt; headers: HeadersInit }) => Promise<InboxSeenResult>;
type NoticeSeenTransport = (request: {
  data: InboxNoticeSeenAttempt;
  headers: HeadersInit;
}) => Promise<InboxSeenResult>;

async function forInboxCredential<T>(
  client: QueryClient,
  viewer: InboxViewer,
  csrfToken: string,
  action: () => Promise<T>,
): Promise<T> {
  const current = () => viewer.isCurrent() && inboxViewerCsrfToken(client, viewer) === csrfToken;
  const assertCurrent = () => {
    if (!current()) throw new DOMException('Inbox viewer changed', 'AbortError');
  };
  assertCurrent();
  try {
    return await action();
  } finally {
    assertCurrent();
  }
}

function inboxCredentialRetired(client: QueryClient, viewer: InboxViewer, csrfToken: string) {
  return !viewer.isCurrent() || inboxViewerCsrfToken(client, viewer) !== csrfToken;
}

async function followInboxAcknowledgementRead(
  client: QueryClient,
  viewer: InboxViewer,
  csrfToken: string,
  refresh: () => Promise<unknown>,
): Promise<InboxObservationRecovery | null> {
  try {
    await forInboxCredential(client, viewer, csrfToken, refresh);
    return null;
  } catch (error) {
    if (inboxCredentialRetired(client, viewer, csrfToken))
      throw error instanceof DOMException && error.name === 'AbortError'
        ? error
        : new DOMException('Inbox viewer changed', 'AbortError');
    return inboxObservationRecovery(inboxReadFailure(error).failure);
  }
}

async function acknowledgeInboxViewer(
  client: QueryClient,
  viewer: InboxViewer,
  csrfToken: string,
  send: () => Promise<InboxSeenResult>,
): Promise<InboxObservationRecovery | null> {
  return forInboxCredential(client, viewer, csrfToken, async () => {
    const result = await forInboxViewer(viewer, send);
    if ('failure' in result) throw new InboxSeenError(result.failure);
    if (!result.signedIn) throw new InboxSeenError({ status: 401, code: 'unauthorized' });
    const [countObservation, pageObservation] = await Promise.all([
      followInboxAcknowledgementRead(client, viewer, csrfToken, () =>
        client.invalidateQueries({ queryKey: unreadCountQueryFor(viewer).queryKey, exact: true }),
      ),
      followInboxAcknowledgementRead(client, viewer, csrfToken, () =>
        client.invalidateQueries({ queryKey: inboxViewerQueryKey(viewer) }),
      ),
    ]);
    if (!countObservation && !pageObservation) return null;
    return inboxObservationRecovery((pageObservation ?? countObservation)!.failure, {
      page: pageObservation !== null,
      count: countObservation !== null,
    });
  });
}

export async function markInboxViewerNoticeSeen(
  client: QueryClient,
  viewer: InboxViewer,
  attempt: InboxNoticeSeenAttempt,
  csrfToken: string,
  send: NoticeSeenTransport = markInboxItemSeen,
): Promise<InboxObservationRecovery | null> {
  if (attempt.accountId !== viewer.subject) throw new InboxSeenError({ status: 403, code: 'forbidden' });
  return acknowledgeInboxViewer(client, viewer, csrfToken, () =>
    send({ data: attempt, headers: { 'X-CSRF-Token': csrfToken } }),
  );
}

export async function markInboxViewerSeen(
  client: QueryClient,
  viewer: InboxViewer,
  attempt: InboxSeenAttempt,
  csrfToken: string,
  send: SeenTransport = markInboxSeen,
): Promise<InboxObservationRecovery | null> {
  return acknowledgeInboxViewer(client, viewer, csrfToken, () =>
    send({ data: attempt, headers: { 'X-CSRF-Token': csrfToken } }),
  );
}
