import { createContext, createElement, useContext, type ReactNode } from 'react';
import type { QueryClient } from '@tanstack/react-query';
import { browserObservation, sessionQuery, useSession } from '../../session';
import { isSessionQueryKey, personalRead, readQueryKey, SESSION_QUERY_KEY } from '../../settings/ports/vocabulary';
import type { InboxSessionObservation, InboxShellPort } from '../ports/shell';

function refreshSession(client: QueryClient): Promise<InboxSessionObservation> {
  return client.fetchQuery({ ...sessionQuery, staleTime: 0 });
}

/** Bind the installed session query and browser observation. Inbox adds no second cache. */
export function createInboxShellPort(): InboxShellPort {
  return {
    sessionQueryKey: SESSION_QUERY_KEY,
    personalRead,
    readQueryKey,
    useSession,
    refreshSession,
    sessionQueryState: (client) => client.getQueryState(sessionQuery.queryKey),
    subscribeSessionQuery: (client, onChange) =>
      client.getQueryCache().subscribe(({ query }) => {
        if (isSessionQueryKey(query.queryKey)) onChange();
      }),
    isSessionQuery: isSessionQueryKey,
    observeSessionCache: (client, listener) => browserObservation(client).subscribeCache(listener),
    publishSessionObservation: (client, notify) => browserObservation(client).publish(notify),
  };
}

export const productionInboxShellPort = createInboxShellPort();

const InboxShellContext = createContext<InboxShellPort | null>(null);

/** Route and shell composition supply the bound port; tests and stories may inject a fake. */
export function InboxShellProvider({ port, children }: { port?: InboxShellPort; children: ReactNode }) {
  return createElement(InboxShellContext.Provider, { value: port ?? productionInboxShellPort }, children);
}

export function useInboxShell(): InboxShellPort {
  return useContext(InboxShellContext) ?? productionInboxShellPort;
}

export function useInboxSession() {
  return useInboxShell().useSession();
}
