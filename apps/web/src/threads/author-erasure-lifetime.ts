import type { QueryClient } from '@tanstack/react-query';
import { sessionQuery } from '../session/query';
import type { ErasureEnqueue, ErasureIntent } from './author-erasure';

export type AuthorErasureSession = {
  state: 'unknown' | 'signed-in' | 'signed-out' | 'unavailable';
  subject?: string | null;
  csrfToken?: string | null;
};

export type AuthorErasureSessionSource = {
  read: () => AuthorErasureSession | undefined;
  snapshot: () => number;
  serverSnapshot: () => 0;
  subscribe: (notify: () => void) => () => void;
};

const sources = new WeakMap<QueryClient, AuthorErasureSessionSource>();
const emptySource: AuthorErasureSessionSource = {
  read: () => undefined,
  snapshot: () => 0,
  serverSnapshot: () => 0,
  subscribe: () => () => {},
};

/** One read-only cache observation preserves transitions which React may batch away. */
export function authorErasureSessionSource(client: QueryClient | undefined): AuthorErasureSessionSource {
  if (!client) return emptySource;
  const known = sources.get(client);
  if (known) return known;

  const read = () => client.getQueryData<AuthorErasureSession>(sessionQuery.queryKey);
  const identity = () => {
    const session = read();
    return JSON.stringify([
      session?.state ?? 'unknown',
      session?.subject ?? null,
      session?.csrfToken ?? null,
    ]);
  };
  let previous = identity();
  let revision = 0;
  const listeners = new Set<() => void>();
  client.getQueryCache().subscribe(({ query }) => {
    if (query.queryKey.length !== sessionQuery.queryKey.length || query.queryKey[0] !== sessionQuery.queryKey[0])
      return;
    const next = identity();
    if (next === previous) return;
    previous = next;
    revision += 1;
    for (const listener of listeners) listener();
  });
  const source: AuthorErasureSessionSource = {
    read,
    snapshot: () => revision,
    serverSnapshot: () => 0,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  sources.set(client, source);
  return source;
}

export function authorErasureSessionIsReady(
  session: AuthorErasureSession | undefined,
  subject: string | null | undefined,
): session is AuthorErasureSession & { state: 'signed-in'; subject: string; csrfToken: string } {
  return authorErasureSessionIsAuthenticated(session) && !!subject && session.subject === subject;
}

export function authorErasureSessionIsAuthenticated(
  session: AuthorErasureSession | undefined,
): session is AuthorErasureSession & { state: 'signed-in'; subject: string; csrfToken: string } {
  return (
    session?.state === 'signed-in' &&
    typeof session.subject === 'string' &&
    session.subject.length > 0 &&
    typeof session.csrfToken === 'string' &&
    session.csrfToken.length > 0
  );
}

export type AuthorErasureTransport = (
  intent: ErasureIntent,
  csrfToken: string,
) => Promise<ErasureEnqueue>;

/** The caller's token and liveness check cross every asynchronous transport-loading boundary together. */
export async function dispatchAuthorErasure(
  intent: ErasureIntent,
  csrfToken: string,
  isCurrent: () => boolean,
  loadTransport: () => Promise<AuthorErasureTransport> = async () => {
    const { beginThreadAuthorErasure } = await import('./author-erasure-server');
    return (original, token) =>
      beginThreadAuthorErasure({ data: original, headers: { 'X-CSRF-Token': token } });
  },
): Promise<ErasureEnqueue | undefined> {
  if (!isCurrent()) return undefined;
  const send = await loadTransport();
  if (!isCurrent()) return undefined;
  // Keep the final guard adjacent to the one call which starts the existing server transport.
  if (!isCurrent()) return undefined;
  return send(intent, csrfToken);
}
