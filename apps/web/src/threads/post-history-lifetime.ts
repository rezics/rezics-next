import type { QueryClient } from '@tanstack/react-query';
import type { readPostHistory } from './reads';

export type HistoryPage = Extract<Awaited<ReturnType<typeof readPostHistory>>, { available: true }>;
type BrowserSession = { state: string; subject?: string | null; csrfToken?: string | null };

/** A read-only observation of the existing browser cache, shared only by history disclosures. */
const sources = new WeakMap<QueryClient, ReturnType<typeof observeSession>>();
function observeSession(client: QueryClient) {
  const read = () => client.getQueryData<BrowserSession>(['session']);
  const identity = () => {
    const session = read();
    return JSON.stringify([session?.state ?? 'unknown', session?.subject ?? null, session?.csrfToken ?? null]);
  };
  let previous = identity();
  let revision = 0;
  const listeners = new Set<() => void>();
  client.getQueryCache().subscribe((event) => {
    if (event.query.queryKey.length !== 1 || event.query.queryKey[0] !== 'session') return;
    // A successful replacement is significant even if structural sharing preserves the old tuple.
    // Fetch/status/observer notifications do not replace a reading lifetime.
    const next = identity();
    const replaced =
      event.type === 'added' ||
      event.type === 'removed' ||
      (event.type === 'updated' && event.action.type === 'success');
    if (previous === next && !replaced) return;
    previous = next;
    revision++;
    for (const listener of listeners) listener();
  });
  return {
    read,
    snapshot: () => revision,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export function postHistorySessionSource(client: QueryClient) {
  let source = sources.get(client);
  if (!source) {
    source = observeSession(client);
    sources.set(client, source);
  }
  return source;
}

/** Caller readiness only; the existing native reader still decides disclosure. */
export function historySessionReady(
  source: ReturnType<typeof postHistorySessionSource> | undefined,
  viewerId?: string,
) {
  if (!source) return true; // Prepared standalone fixtures have no browser session producer.
  const session = source.read();
  if (session?.state === 'signed-out') return viewerId === undefined;
  return (
    session?.state === 'signed-in' &&
    !!session.subject &&
    !!session.csrfToken &&
    (viewerId === undefined || viewerId === session.subject)
  );
}

export type HistoryView = {
  open: boolean;
  loading: boolean;
  loaded: boolean;
  available: boolean;
  failedCursor: string | undefined;
  revisions: { revision: HistoryPage['revisions'][number]; documentMedia: HistoryPage['documentMedia'] }[];
  authors: HistoryPage['authors'];
  mentions: HistoryPage['mentions'];
  subjects: HistoryPage['subjects'];
  reviewVotes: HistoryPage['reviewVotes'];
  next: string | null;
  now: string;
};

function emptyHistory(): HistoryView {
  return {
    open: false,
    loading: false,
    loaded: false,
    available: true,
    failedCursor: undefined,
    revisions: [],
    authors: {},
    mentions: {},
    subjects: [],
    reviewVotes: {},
    next: null,
    now: new Date().toISOString(),
  };
}

type HistoryRequest = { connection: number; read: number };
let sequence = 0;

/** One original caller/session visit. It owns data and guards, never credentials or a transport. */
export class PostHistoryLifetime {
  readonly id = ++sequence;
  private retired = false;
  private connected = true;
  private connection = 0;
  private read = 0;
  private pending: HistoryRequest | undefined;
  private view = emptyHistory();
  private listeners = new Set<() => void>();
  constructor(
    private valid: () => boolean,
    private watch?: (listener: () => void) => () => void,
  ) {}

  private notify() {
    for (const listener of this.listeners) listener();
  }
  retire = (notify = true) => {
    if (this.retired) return;
    this.retired = true;
    this.connection++;
    this.pending = undefined;
    this.view = emptyHistory();
    if (notify) this.notify();
  };
  current = () => {
    if (!this.retired && !this.valid()) this.retire();
    return !this.retired && this.connected;
  };
  snapshot = () => {
    this.current();
    return this.view;
  };
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  ticket = () => this.connection;
  ownsConnection = (ticket: number) => this.current() && ticket === this.connection;
  update(ticket: number, update: (view: HistoryView) => HistoryView) {
    if (!this.ownsConnection(ticket)) return;
    this.view = update(this.view);
    this.notify();
  }
  begin(ticket: number) {
    if (!this.ownsConnection(ticket) || this.pending) return;
    return (this.pending = { connection: ticket, read: ++this.read });
  }
  owns = (request: HistoryRequest) => this.ownsConnection(request.connection) && this.pending === request;
  finish(request: HistoryRequest) {
    if (!this.owns(request)) return;
    this.pending = undefined;
    this.update(request.connection, (view) => ({ ...view, loading: false }));
  }
  connect = () => {
    this.connected = true;
    const stop = this.watch?.(() => {
      this.current();
    });
    this.current();
    return () => {
      stop?.();
      this.connected = false;
      this.connection++;
      this.pending = undefined;
      const open = this.view.open;
      this.view = { ...emptyHistory(), open, loaded: open, available: !open };
      this.notify();
      // Strict Mode can reconnect this visit. All former connection requests remain obsolete.
      queueMicrotask(() => {
        if (!this.connected) this.retire();
      });
    };
  };
}
