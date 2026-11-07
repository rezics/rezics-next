import type { QueryClient, QueryState } from '@tanstack/react-query';
import {
  SESSION_QUERY_KEY,
  personalRead,
  readQueryKey,
  type ReadCredentialMode,
} from '../../settings/ports/vocabulary';

export type InboxSessionObservation = {
  state: 'unknown' | 'signed-in' | 'signed-out' | 'unavailable';
  csrfToken: string | null;
  subject?: string | null;
};

export type InboxSessionCacheEvent = { query: { queryKey: readonly unknown[] } };

/**
 * Shell and session capabilities Inbox owns as a consumer. Composition binds the installed
 * session query and browser observation. Count, page and acknowledgement keys stay on that
 * observation; the port does not start another fetch or cache.
 */
export type InboxShellPort = {
  readonly sessionQueryKey: typeof SESSION_QUERY_KEY;
  readonly personalRead: typeof personalRead;
  readQueryKey: (key: readonly unknown[], mode: ReadCredentialMode) => readonly unknown[];
  useSession: () => InboxSessionObservation;
  refreshSession: (client: QueryClient) => Promise<InboxSessionObservation>;
  sessionQueryState: (client: QueryClient) => QueryState<InboxSessionObservation> | undefined;
  subscribeSessionQuery: (client: QueryClient, onChange: () => void) => () => void;
  isSessionQuery: (key: readonly unknown[]) => boolean;
  observeSessionCache: (client: QueryClient, listener: (event: InboxSessionCacheEvent) => void) => () => void;
  publishSessionObservation: (client: QueryClient, notify: () => void) => void;
};
