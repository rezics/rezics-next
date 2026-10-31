import { queryOptions, type QueryClient } from '@tanstack/react-query';
import { personalRead, readQueryKey } from '../kernel/query';
import {
  InboxSeenError,
  markInboxSeen,
  readInboxPage,
  readUnreadCount,
  type InboxPage,
  type InboxSeenAttempt,
  type InboxSeenResult,
} from './inbox-read';
import { forInboxViewer, type InboxViewer } from './inbox-viewer';

const inboxKey = readQueryKey(['notifications', 'inbox'], 'session');

export function inboxViewerQueryKey(viewer: InboxViewer) {
  return [...inboxKey, viewer.subject, viewer.epoch] as const;
}

export type InboxPageLoader = (cursor?: string, signal?: AbortSignal) => Promise<InboxPage>;

const loadNativeInboxPage: InboxPageLoader = (cursor, signal) =>
  readInboxPage({ data: cursor ? { cursor } : {}, ...(signal ? { signal } : {}) });

export function inboxPageQuery(viewer: InboxViewer, cursor?: string, loadPage: InboxPageLoader = loadNativeInboxPage) {
  return queryOptions({
    ...personalRead,
    queryKey: [...inboxViewerQueryKey(viewer), cursor ?? null],
    queryFn: ({ signal }) => forInboxViewer(viewer, () => loadPage(cursor, signal), signal),
    retry: false,
    gcTime: 0,
  });
}

const unreadCountDefaults = {
  ...personalRead,
  staleTime: 60_000,
  retry: false,
} as const;

// Retain the fixed prefix for existing cache invalidation consumers.
export const unreadCountQuery = queryOptions({
  ...unreadCountDefaults,
  queryKey: readQueryKey(['notifications', 'count'], 'session'),
  queryFn: () => readUnreadCount(),
});

export function unreadCountQueryFor(viewer: InboxViewer | null) {
  return queryOptions({
    ...unreadCountDefaults,
    queryKey: [...unreadCountQuery.queryKey, viewer?.subject ?? null, viewer?.epoch ?? null],
    queryFn: ({ signal }) => {
      if (!viewer) throw new DOMException('Inbox viewer unavailable', 'AbortError');
      return forInboxViewer(viewer, () => readUnreadCount({ signal }), signal);
    },
    enabled: personalRead.enabled && viewer !== null,
    gcTime: 0,
  });
}

type SeenTransport = (request: { data: InboxSeenAttempt; headers: HeadersInit }) => Promise<InboxSeenResult>;

export async function markInboxViewerSeen(
  client: QueryClient,
  viewer: InboxViewer,
  attempt: InboxSeenAttempt,
  csrfToken: string,
  send: SeenTransport = markInboxSeen,
) {
  const result = await forInboxViewer(viewer, () => send({ data: attempt, headers: { 'X-CSRF-Token': csrfToken } }));
  if ('failure' in result) throw new InboxSeenError(result.failure);
  if (!result.signedIn) throw new InboxSeenError({ status: 401, code: 'unauthorized' });
  await Promise.all([
    client.invalidateQueries({ queryKey: unreadCountQueryFor(viewer).queryKey, exact: true }),
    client.invalidateQueries({ queryKey: inboxViewerQueryKey(viewer) }),
  ]);
}
