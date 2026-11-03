import type { QueryClient } from '@tanstack/react-query';
import type { PageAuthor } from '../identity/read';
import type { readPostHistory } from './reads';
import {
  createHistoricalReadBinding,
  historicalActualMatches,
  historicalReaderSource,
  type HistoricalActualReader,
  type HistoricalReadBinding,
  type HistoricalReaderSource,
} from './historical-reader-provenance';

type HistoryResponse = Awaited<ReturnType<typeof readPostHistory>>;
export type HistoryPage = Extract<HistoryResponse['data'], { available: true }>;
export type HistoryReadData = HistoryResponse['data'];

export function postHistorySessionSource(client: QueryClient) {
  return historicalReaderSource(client);
}

/** Read admission needs a prepared reader, never a write-only CSRF token. */
export function historySessionReady(source: HistoricalReaderSource | undefined, viewerId?: string) {
  if (!source) return true; // Prepared standalone fixtures have no browser session producer.
  const session = source.read();
  if (!session.healthy) return false;
  if (session.state === 'signed-out') return viewerId === undefined;
  return session.state === 'signed-in' && !!session.subject && (viewerId === undefined || viewerId === session.subject);
}

export type HistoryView = {
  /** A request replaces the entire page, including its local interactions. */
  pageGeneration: number;
  cursor: string | undefined;
  open: boolean;
  loading: boolean;
  loaded: boolean;
  available: boolean;
  failedCursor: string | undefined;
  revisions: {
    revision: HistoryPage['revisions'][number];
    documentMedia: HistoryPage['documentMedia'];
    /** The originating page's author disclosure; removed rows never borrow a later/earlier page's identity. */
    summaryAuthor?: PageAuthor | undefined;
  }[];
  authors: HistoryPage['authors'];
  mentions: HistoryPage['mentions'];
  subjects: HistoryPage['subjects'];
  reviewVotes: HistoryPage['reviewVotes'];
  next: string | null;
  now: string;
};

function emptyHistory(): HistoryView {
  return {
    pageGeneration: 0,
    cursor: undefined,
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

type HistoryRequest = {
  connection: number;
  read: number;
  cursor?: string;
  binding: HistoricalReadBinding;
};

let sequence = 0;

/** One original caller/session visit. It owns disclosure and requests, never credentials or a transport. */
export class PostHistoryLifetime {
  readonly id = ++sequence;
  private retired = false;
  private connected = true;
  private connection = 0;
  private read = 0;
  private pending: HistoryRequest | undefined;
  private actualReader: HistoricalActualReader | undefined;
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
    this.connected = false;
    this.connection++;
    this.pending = undefined;
    this.actualReader = undefined;
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

  begin(
    ticket: number,
    source?: HistoricalReaderSource,
    postId = 'standalone-post',
    cursor?: string,
    locale = 'en',
    credentialMode: 'anonymous' | 'session' = 'anonymous',
    expectedSubject?: string,
  ) {
    if (!this.ownsConnection(ticket) || this.pending) return;
    const read = ++this.read;
    const binding = createHistoricalReadBinding(
      source,
      { kind: 'post-history', postId, cursor: cursor ?? null, locale, credentialMode },
      this.id,
      ticket,
      read,
      expectedSubject,
    );
    const request = (this.pending = {
      connection: ticket,
      read,
      ...(cursor !== undefined ? { cursor } : {}),
      binding,
    });
    // Retire the previous cursor synchronously, before the queued transport can run.
    // Keep the action's position and failure address for explicit retry, never its rows or joins.
    this.view = {
      ...emptyHistory(),
      pageGeneration: read,
      cursor,
      open: this.view.open,
      loading: true,
      loaded: this.view.loaded,
      available: this.view.available,
      failedCursor: this.view.failedCursor,
      next: cursor ?? null,
    };
    this.notify();
    return request;
  }

  owns = (request: HistoryRequest) => this.ownsConnection(request.connection) && this.pending === request;

  ownsPage = (ticket: number, generation: number) =>
    this.ownsConnection(ticket) && this.view.pageGeneration === generation;

  /** Replace one admitted native envelope; no page data is merged with another cursor. */
  acceptPage(request: HistoryRequest, page: HistoryPage) {
    if (!this.owns(request)) return;
    this.update(request.connection, (view) => ({
      ...view,
      revisions: page.revisions.map((revision) => ({
        revision,
        documentMedia: page.documentMedia,
        summaryAuthor: page.authors?.[revision.authorId],
      })),
      authors: page.authors,
      mentions: page.mentions,
      subjects: page.subjects,
      reviewVotes: page.reviewVotes,
      next: page.next,
      now: page.now,
      loaded: true,
      available: true,
      failedCursor: undefined,
    }));
  }

  acceptReader(request: HistoryRequest, actualReader: HistoricalActualReader) {
    if (!this.owns(request) || !historicalActualMatches(request.binding, actualReader)) return false;
    const previous = this.actualReader;
    if (
      previous &&
      (previous.credentialMode !== actualReader.credentialMode ||
        previous.subject !== actualReader.subject ||
        previous.complete !== actualReader.complete)
    ) {
      this.resetDisclosure(request.connection);
      return false;
    }
    this.actualReader ??= actualReader;
    return true;
  }

  resetDisclosure(ticket: number) {
    if (!this.ownsConnection(ticket)) return;
    const open = this.view.open;
    this.connection++;
    this.pending = undefined;
    this.actualReader = undefined;
    this.view = { ...emptyHistory(), open, loaded: open, available: !open };
    this.notify();
  }

  /** A failed page retains only its exact retry address, never a previous cursor's disclosure. */
  failPage(request: HistoryRequest) {
    if (!this.owns(request)) return;
    this.update(request.connection, (view) => ({
      ...view,
      available: false,
      loaded: true,
      failedCursor: request.cursor,
    }));
  }

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
      this.actualReader = undefined;
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
