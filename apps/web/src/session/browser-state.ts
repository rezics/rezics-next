import type { QueryClient } from '@tanstack/react-query';
import { browserObservation } from './observation';

export const sessionQueryKey = ['session'] as const;

export type BrowserSession = {
  state: 'unknown' | 'signed-in' | 'signed-out' | 'unavailable';
  csrfToken: string | null;
  subject?: string | null;
};

type ClientEntry = {
  client: QueryClient;
  listeners: Set<() => void>;
  references: number;
  authoritativeReferences: number;
  readStarted: boolean;
  unsubscribeCache: (() => void) | undefined;
};

// Entries exist only while a useSession subscription is mounted. Anonymous entries can
// perform their own session read, but they never enter the list of browser token owners.
const entries: ClientEntry[] = [];
const owners: ClientEntry[] = [];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

const unknownSession: BrowserSession = { state: 'unknown', csrfToken: null };
const unavailableSession: BrowserSession = { state: 'unavailable', csrfToken: null, subject: null };
const signedOutSession: BrowserSession = { state: 'signed-out', csrfToken: null, subject: null };

/** Convert an untrusted successful response into the session states the browser may observe. */
export function normalizeSessionObservation(value: unknown): BrowserSession {
  if (!isRecord(value)) return unavailableSession;
  const hasOwn = (key: string) => Object.prototype.hasOwnProperty.call(value, key);
  if (!hasOwn('state')) return unavailableSession;

  if (value.state === 'signed-in') {
    const subject = value.subject;
    const csrfToken = value.csrfToken;
    if (
      !hasOwn('subject') ||
      !hasOwn('csrfToken') ||
      !nonEmptyString(subject) ||
      !(csrfToken === null || nonEmptyString(csrfToken))
    )
      return unavailableSession;
    return { state: 'signed-in', subject, csrfToken };
  }

  if (value.state === 'signed-out') return signedOutSession;
  if (value.state === 'unavailable') return unavailableSession;
  return unavailableSession;
}

function entryFor(client: QueryClient): ClientEntry {
  let entry = entries.find((candidate) => candidate.client === client);
  if (!entry) {
    entry = {
      client,
      listeners: new Set(),
      references: 0,
      authoritativeReferences: 0,
      readStarted: false,
      unsubscribeCache: undefined,
    };
    entries.push(entry);
  }
  return entry;
}

function startRead(entry: ClientEntry, read: (() => Promise<unknown>) | undefined): void {
  if (entry.readStarted) return;
  entry.readStarted = true;
  if (!read) return;
  try {
    void read().catch(() => {});
  } catch {
    // The query cache carries the failure state consumed by the hook and guard.
  }
}

/** Subscribe once per active QueryClient while keeping its session state in TanStack's cache. */
export function subscribeBrowserSession(
  client: QueryClient,
  listener: () => void,
  read: (() => Promise<unknown>) | undefined,
  authoritative: boolean,
): () => void {
  const entry = entryFor(client);
  entry.references += 1;
  const notify = () => listener();

  if (authoritative) {
    entry.listeners.add(notify);
    entry.authoritativeReferences += 1;
    if (entry.authoritativeReferences === 1) {
      owners.push(entry);
      const observation = browserObservation(client);
      const publish = () => {
        for (const subscriber of [...entry.listeners]) subscriber();
      };
      entry.unsubscribeCache = observation.subscribeCache((event) => {
        if (event.query.queryKey.length === 1 && event.query.queryKey[0] === sessionQueryKey[0])
          observation.publish(publish);
      });
    }
  }

  startRead(entry, read);

  let released = false;
  return () => {
    if (released) return;
    released = true;
    entry.references -= 1;

    if (authoritative) {
      entry.listeners.delete(notify);
      entry.authoritativeReferences -= 1;
      if (entry.authoritativeReferences === 0) {
        const ownerIndex = owners.indexOf(entry);
        if (ownerIndex !== -1) owners.splice(ownerIndex, 1);
        entry.unsubscribeCache?.();
        entry.unsubscribeCache = undefined;
      }
    }

    if (entry.references === 0) {
      const entryIndex = entries.indexOf(entry);
      if (entryIndex !== -1) entries.splice(entryIndex, 1);
    }
  };
}

export function sessionStateSnapshot(client: QueryClient) {
  return client.getQueryState(sessionQueryKey);
}

function currentOwnedSession(): BrowserSession | null {
  const owner = owners[owners.length - 1];
  if (!owner) return null;
  const queryState = sessionStateSnapshot(owner.client);
  if (!queryState || queryState.status !== 'success') return null;
  return normalizeSessionObservation(queryState.data);
}

/** Read the current owner's actual cache status at dispatch time, not a render-time token copy. */
export function ownedSessionCsrfToken(): string | null {
  const session = currentOwnedSession();
  return session?.state === 'signed-in' ? session.csrfToken : null;
}

export { unknownSession, signedOutSession };
