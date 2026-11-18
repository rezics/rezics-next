import type { QueryClient } from '@tanstack/react-query';
import { browserObservation } from './observation';
import { normalizeSessionObservation, sessionQueryKey, unknownSession, type BrowserSession } from './contract';

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

export type BrowserSessionOwnerSnapshot = Readonly<{ client: QueryClient | null; revision: number }>;

const serverOwnerSnapshot: BrowserSessionOwnerSnapshot = { client: null, revision: 0 };
let ownerSnapshot = serverOwnerSnapshot;
const ownerListeners = new Set<() => void>();

let ownerPublicationQueued = false;
function advanceOwnerSnapshot(): void {
  ownerSnapshot = { client: owners.at(-1)?.client ?? null, revision: ownerSnapshot.revision + 1 };
  // Guards see each retirement now, including ABA within a single React update.
  if (ownerPublicationQueued) return;
  ownerPublicationQueued = true;
  queueMicrotask(() => {
    ownerPublicationQueued = false;
    for (const listener of [...ownerListeners]) listener();
  });
}

/** Identifies the active useSession cache without exposing its credentials or session payload. */
export const browserSessionOwner = {
  getSnapshot: (): BrowserSessionOwnerSnapshot => ownerSnapshot,
  getServerSnapshot: (): BrowserSessionOwnerSnapshot => serverOwnerSnapshot,
  subscribe(listener: () => void): () => void {
    ownerListeners.add(listener);
    return () => ownerListeners.delete(listener);
  },
};

type SessionState = ReturnType<typeof sessionStateSnapshot>;

// TanStack announces observer results before its cache update. Compare the committed state
// so both events describe one transition, and observer/options churn cannot create a visit.
function sessionAuthorityChanged(before: SessionState, after: SessionState): boolean {
  return (
    before?.status !== after?.status ||
    before?.fetchStatus !== after?.fetchStatus ||
    before?.isInvalidated !== after?.isInvalidated ||
    before?.data !== after?.data ||
    before?.dataUpdateCount !== after?.dataUpdateCount ||
    before?.dataUpdatedAt !== after?.dataUpdatedAt ||
    before?.errorUpdateCount !== after?.errorUpdateCount
  );
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
      advanceOwnerSnapshot();
      const observation = browserObservation(client);
      const publish = () => {
        for (const subscriber of [...entry.listeners]) subscriber();
      };
      let previousState = sessionStateSnapshot(client);
      entry.unsubscribeCache = observation.subscribeCache((event) => {
        if (event.query.queryKey.length !== 1 || event.query.queryKey[0] !== sessionQueryKey[0]) return;
        const state = sessionStateSnapshot(client);
        if (state === previousState) return;
        const replaced = sessionAuthorityChanged(previousState, state);
        previousState = state;
        if (replaced && owners.at(-1) === entry) advanceOwnerSnapshot();
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
        const wasCurrentOwner = ownerIndex !== -1 && ownerIndex === owners.length - 1;
        if (ownerIndex !== -1) owners.splice(ownerIndex, 1);
        if (wasCurrentOwner) advanceOwnerSnapshot();
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

/** Read the prepared session cache. Does not start a session fetch. */
export function cachedBrowserSession(client: QueryClient): BrowserSession {
  const state = sessionStateSnapshot(client);
  if (!state || state.status !== 'success') return unknownSession;
  return normalizeSessionObservation(state.data);
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

/** The current mounted owner supplies dispatch credentials; server rendering never lends one. */
export function sessionCsrfToken(): string | null {
  return typeof window === 'undefined' ? null : ownedSessionCsrfToken();
}
