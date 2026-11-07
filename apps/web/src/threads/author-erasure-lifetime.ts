import { readerSessionSource, useReaderVisit } from '../reader/lifetime/index';
import { getLocale } from '../paraglide/runtime.js';
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

/** Session parsing and successful-incarnation observation belong to the reader producer. */
export const authorErasureSessionSource = readerSessionSource;

export type AuthorErasureBrowserVisit = {
  locale: ReturnType<typeof getLocale>;
  current: () => boolean;
};

/** The application session host supplies navigation; isolated mounts keep browser observation. */
export function useAuthorErasureBrowserVisit(scope = ''): AuthorErasureBrowserVisit {
  return useReaderVisit(scope, getLocale(), getLocale);
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

export type AuthorErasureTransport = (intent: ErasureIntent, csrfToken: string) => Promise<ErasureEnqueue>;

/** The caller's token and liveness check cross every asynchronous transport-loading boundary together. */
export async function dispatchAuthorErasure(
  intent: ErasureIntent,
  csrfToken: string,
  isCurrent: () => boolean,
  loadTransport: () => Promise<AuthorErasureTransport> = async () => {
    const { beginThreadAuthorErasure } = await import('./author-erasure-server');
    return (original, token) => beginThreadAuthorErasure({ data: original, headers: { 'X-CSRF-Token': token } });
  },
): Promise<ErasureEnqueue | undefined> {
  if (!isCurrent()) return undefined;
  const send = await loadTransport();
  if (!isCurrent()) return undefined;
  // Keep the final guard adjacent to the one call which starts the existing server transport.
  if (!isCurrent()) return undefined;
  return send(intent, csrfToken);
}
