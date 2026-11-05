import type { QueryClient } from '@tanstack/react-query';
import { sessionQuery } from '../../session/query';
import type { CurationRead } from './curate-actions';
import { startCurationOpeningRead, type CurationOpeningRead } from './curation-opening-read';

export type CurationSessionObservation = {
  state: 'unknown' | 'signed-in' | 'signed-out' | 'unavailable';
  subject?: string | null;
};

export type CurationAdmissionLease = {
  readonly reader: string;
  readonly incarnation: number;
  readonly kind: 'initial' | 'fresh';
  isCurrent(): boolean;
  onRetire(listener: (silent: boolean) => void): () => void;
};

export type CurationReaderAdmissionSnapshot = {
  version: number;
  session: CurationSessionObservation;
  lease: CurationAdmissionLease | null;
};

type SessionPhase = 'unknown' | 'success' | 'error';
type SessionCacheSnapshot = {
  query: object | null;
  phase: SessionPhase;
  session: CurationSessionObservation;
};

const unknownSession: CurationSessionObservation = { state: 'unknown' };
const queryKey = JSON.stringify(sessionQuery.queryKey);
let nextIncarnation = 1;
const retiredReaders = new WeakMap<QueryClient, Set<string>>();

function retiredSet(client: QueryClient): Set<string> {
  let readers = retiredReaders.get(client);
  if (!readers) {
    readers = new Set();
    retiredReaders.set(client, readers);
  }
  return readers;
}

function markRetired(client: QueryClient, reader: string) {
  retiredSet(client).add(reader);
}

function clearRetired(client: QueryClient, reader: string) {
  retiredReaders.get(client)?.delete(reader);
}

function sessionCacheSnapshot(client: QueryClient): SessionCacheSnapshot {
  const query = client.getQueryCache().find({ queryKey: sessionQuery.queryKey, exact: true });
  if (!query) return { query: null, phase: 'unknown', session: unknownSession };

  const state = query.state;
  if (state.status === 'error') return { query, phase: 'error', session: { state: 'unavailable' } };

  const data = state.data;
  if (!data || typeof data !== 'object' || !('state' in data))
    return { query, phase: 'unknown', session: unknownSession };

  const candidate = data as { state: unknown; subject?: unknown };
  if (candidate.state === 'signed-in') {
    if (candidate.subject === null || candidate.subject === undefined)
      return { query, phase: 'success', session: { state: 'signed-in', subject: null } };
    if (typeof candidate.subject === 'string')
      return { query, phase: 'success', session: { state: 'signed-in', subject: candidate.subject } };
    return { query, phase: 'unknown', session: unknownSession };
  }
  if (candidate.state === 'signed-out') return { query, phase: 'success', session: { state: 'signed-out' } };
  if (candidate.state === 'unavailable') return { query, phase: 'success', session: { state: 'unavailable' } };
  return { query, phase: 'unknown', session: unknownSession };
}

function sameSession(left: CurationSessionObservation, right: CurationSessionObservation): boolean {
  return left.state === right.state && left.subject === right.subject;
}

class Lease implements CurationAdmissionLease {
  private retired = false;
  private listeners = new Set<(silent: boolean) => void>();

  constructor(
    private readonly owner: CurationReaderAdmission,
    readonly reader: string,
    readonly incarnation: number,
    readonly kind: 'initial' | 'fresh',
  ) {}

  isCurrent = () => this.owner.owns(this);

  onRetire = (listener: (silent: boolean) => void) => {
    if (this.retired) {
      listener(false);
      return () => {};
    }
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  retire(silent = false) {
    if (this.retired) return;
    this.retired = true;
    for (const listener of [...this.listeners]) listener(silent);
    this.listeners.clear();
  }
}

/**
 * One mounted curation visit observes the actual session QueryCache. A lease is irrevocable:
 * equal session data after a health loss can only create a new lease after a fresh curation read.
 */
export class CurationReaderAdmission {
  private opening: {
    reader: string;
    version: number;
    source: object;
    work: CurationOpeningRead<CurationRead | undefined>;
  } | null = null;
  private listeners = new Set<() => void>();
  private stopCache: (() => void) | null = null;
  private raw: SessionCacheSnapshot;
  private snapshot: CurationReaderAdmissionSnapshot;
  private activeLease: Lease | null = null;
  private leaseSawHealthySession = false;
  private securityInvalidated = false;
  private replaced = false;
  private attached = false;
  private hasAttached = false;
  private detachedOwner: {
    reader: string;
    kind: 'initial' | 'fresh';
    query: object | null;
    hadHealthySession: boolean;
  } | null = null;
  private initialReader: string | null;

  constructor(
    readonly queryClient: QueryClient,
    initialReader: string | null,
    options: { forceFresh?: boolean } = {},
  ) {
    this.initialReader = initialReader;
    this.raw = sessionCacheSnapshot(queryClient);
    this.snapshot = { version: 0, session: this.raw.session, lease: null };

    const contradicted =
      this.raw.phase === 'error' ||
      this.raw.session.state === 'signed-out' ||
      this.raw.session.state === 'unavailable' ||
      (this.raw.session.state === 'signed-in' && this.raw.session.subject !== initialReader);
    const retired = !!(initialReader && retiredReaders.get(queryClient)?.has(initialReader));
    this.securityInvalidated = !!options.forceFresh || contradicted || retired;

    if (initialReader && !this.securityInvalidated) {
      this.activeLease = this.makeLease(initialReader, 'initial');
      this.leaseSawHealthySession =
        this.raw.phase === 'success' &&
        this.raw.session.state === 'signed-in' &&
        this.raw.session.subject === initialReader;
      this.snapshot = { version: 1, session: this.raw.session, lease: this.activeLease };
    } else if (initialReader && this.securityInvalidated) {
      markRetired(queryClient, initialReader);
      this.snapshot = { version: 1, session: this.raw.session, lease: null };
    }
  }

  getSnapshot = () => this.snapshot;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private publish(session: CurationSessionObservation, lease: Lease | null, incrementVersion = true, notify = true) {
    if (incrementVersion) {
      this.opening?.work.retire();
      this.opening = null;
    }
    this.snapshot = {
      version: this.snapshot.version + (incrementVersion ? 1 : 0),
      session,
      lease,
    };
    if (notify) for (const listener of [...this.listeners]) listener();
  }

  private makeLease(reader: string, kind: 'initial' | 'fresh'): Lease {
    return new Lease(this, reader, nextIncarnation++, kind);
  }

  owns(lease: Lease): boolean {
    if (this.replaced || this.activeLease !== lease) return false;
    this.refreshFromCache();
    return !this.replaced && this.activeLease === lease;
  }

  private retireActive(mark = true, notify = true) {
    const lease = this.activeLease;
    if (!lease) return false;
    this.activeLease = null;
    this.leaseSawHealthySession = false;
    if (mark) {
      this.securityInvalidated = true;
      markRetired(this.queryClient, lease.reader);
    }
    lease.retire(!notify);
    return true;
  }

  private refreshFromCache(event?: { type?: string; query?: { queryKey?: readonly unknown[] } }, notify = true) {
    if (this.replaced) return;
    const isSessionEvent = !event || (event.query && JSON.stringify(event.query.queryKey) === queryKey);
    if (!isSessionEvent) return;

    const previous = this.raw;
    const current = sessionCacheSnapshot(this.queryClient);
    const removed = event?.type === 'removed';
    const disappeared = !!previous.query && !current.query;
    const recreated = !!previous.query && !!current.query && previous.query !== current.query;
    const queryChanged = removed || disappeared || recreated;

    this.raw = current;
    const identityChanged = !sameSession(previous.session, current.session) || previous.phase !== current.phase;

    if (queryChanged) {
      const hadLease = this.retireActive(true, notify);
      if (!hadLease) this.securityInvalidated = true;
      this.publish(current.session, null, true, notify);
      return;
    }

    const lease = this.activeLease;
    const unhealthy =
      current.phase === 'error' ||
      current.session.state === 'signed-out' ||
      current.session.state === 'unavailable' ||
      (current.session.state === 'signed-in' && current.session.subject !== lease?.reader) ||
      (current.session.state === 'unknown' && this.leaseSawHealthySession);

    if (lease && unhealthy) {
      this.retireActive(true, notify);
      this.publish(current.session, null, true, notify);
      return;
    }

    if (
      lease &&
      current.phase === 'success' &&
      current.session.state === 'signed-in' &&
      current.session.subject === lease.reader
    )
      this.leaseSawHealthySession = true;

    if (identityChanged) this.publish(current.session, this.activeLease, true, notify);
  }

  /** Start the cache subscription before controls are actionable; return a mounted-owner cleanup. */
  attach() {
    if (this.attached) return () => {};
    const current = sessionCacheSnapshot(this.queryClient);

    if (this.hasAttached && this.detachedOwner && !this.securityInvalidated && !this.replaced) {
      const sameQuery = this.detachedOwner.query === current.query;
      const sameSession =
        (current.session.state === 'unknown' && !this.detachedOwner.hadHealthySession) ||
        (current.phase === 'success' &&
          current.session.state === 'signed-in' &&
          current.session.subject === this.detachedOwner.reader);
      if (sameQuery && sameSession && current.phase !== 'error') {
        clearRetired(this.queryClient, this.detachedOwner.reader);
        this.activeLease = this.makeLease(this.detachedOwner.reader, this.detachedOwner.kind);
        this.leaseSawHealthySession = current.session.state === 'signed-in';
        this.raw = current;
        this.detachedOwner = null;
        this.publish(current.session, this.activeLease);
      } else {
        this.securityInvalidated = true;
      }
    }

    this.raw = current;
    this.attached = true;
    this.hasAttached = true;
    this.stopCache = this.queryClient.getQueryCache().subscribe((event) => {
      this.refreshFromCache(event as { type?: string; query?: { queryKey?: readonly unknown[] } });
    });
    // Close the render-to-subscribe gap without treating an ordinary healthy notification as loss.
    this.refreshFromCache();

    return () => {
      if (!this.attached) return;
      this.stopCache?.();
      this.stopCache = null;
      this.attached = false;
      const lease = this.activeLease;
      if (lease) {
        this.detachedOwner = {
          reader: lease.reader,
          kind: lease.kind,
          query: this.raw.query,
          hadHealthySession: this.leaseSawHealthySession,
        };
        markRetired(this.queryClient, lease.reader);
      }
      this.retireActive(false);
      this.publish(this.raw.session, null);
    };
  }

  /** A new same-read result may replace the first SSR admission, but never revive a retired one. */
  updateInitial(reader: string | null) {
    // A failed refresh does not revoke an already admitted same-reader SSR result.
    if (reader === null) return;
    if (reader === this.initialReader) return;
    const canReplaceInitial = !this.securityInvalidated && !this.replaced;
    const previousReader = this.initialReader;
    this.initialReader = reader;
    if (previousReader) {
      this.retireActive(false, false);
      markRetired(this.queryClient, previousReader);
    }
    if (!canReplaceInitial || !reader || retiredReaders.get(this.queryClient)?.has(reader)) {
      this.publish(this.snapshot.session, null, true, false);
      return;
    }

    this.refreshFromCache(undefined, false);
    const session = this.snapshot.session;
    const compatible = session.state === 'unknown' || (session.state === 'signed-in' && session.subject === reader);
    if (!compatible) {
      this.securityInvalidated = true;
      markRetired(this.queryClient, reader);
      this.publish(session, null, true, false);
      return;
    }

    this.securityInvalidated = false;
    this.activeLease = this.makeLease(reader, 'initial');
    this.leaseSawHealthySession = session.state === 'signed-in';
    this.publish(session, this.activeLease, true, false);
  }

  canRead(reader: string, version: number): boolean {
    if (!this.attached || this.replaced) return false;
    this.refreshFromCache();
    const session = this.snapshot.session;
    return (
      this.activeLease === null &&
      this.snapshot.version === version &&
      session.state === 'signed-in' &&
      session.subject === reader
    );
  }

  /** The installed visit owns work even when an effect subscriber releases its result handler. */
  readOpening(
    reader: string,
    version: number,
    source: object,
    read: (signal: AbortSignal) => Promise<CurationRead | undefined>,
  ): CurationOpeningRead<CurationRead | undefined> | null {
    if (!this.canRead(reader, version)) return null;
    const current = this.opening;
    if (
      current?.reader === reader &&
      current.version === version &&
      current.source === source &&
      !current.work.signal.aborted
    )
      return current.work;
    current?.work.retire();
    const work = startCurationOpeningRead(read);
    this.opening = { reader, version, source, work };
    const release = () => {
      if (this.opening?.work === work) this.opening = null;
    };
    void work.promise.then(release, release);
    return work;
  }

  retireOtherOpening(source: object) {
    if (this.opening && this.opening.source !== source) {
      this.opening.work.retire();
      this.opening = null;
    }
  }

  /** A successful same-reader BFF read is the only way to establish an owner after retirement. */
  admitFresh(reader: string, version: number): CurationAdmissionLease | null {
    if (!this.canRead(reader, version)) return null;
    const lease = this.makeLease(reader, 'fresh');
    this.activeLease = lease;
    this.leaseSawHealthySession = true;
    this.securityInvalidated = true;
    clearRetired(this.queryClient, reader);
    this.publish(this.snapshot.session, lease);
    return lease;
  }

  retireForReplacement() {
    if (this.replaced) return;
    this.replaced = true;
    const lease = this.activeLease;
    if (lease) markRetired(this.queryClient, lease.reader);
    this.retireActive(false, false);
    this.publish(this.snapshot.session, null, true, false);
  }
}
