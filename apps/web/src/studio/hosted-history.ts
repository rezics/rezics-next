import type { HistoricalReaderSource } from '../threads/historical-reader-provenance';
import type { StudioFailure } from './contract';
import type { HostedBook, HostedBookNative, HostedHistoryEntry, HostedHistoryPage } from './hosted-contract';

/** Only the admitted hosted workspace supplies this binding; local Studio has no author history. */
export type HostedHistoryBinding = Readonly<{
  native: Pick<HostedBookNative, 'listHistory' | 'read'>;
  catalogueId: string;
  accountId: string;
  isCurrent: () => boolean;
}>;
export type HostedHistorySelection =
  | Readonly<{ kind: 'none' }>
  | Readonly<{ kind: 'loading'; entry: HostedHistoryEntry }>
  | Readonly<{ kind: 'failed'; entry: HostedHistoryEntry; error: StudioFailure }>
  | Readonly<{ kind: 'ready'; entry: HostedHistoryEntry; book: HostedBook }>;
export type HostedHistoryState =
  | Readonly<{ kind: 'loading'; cursor: string | null }>
  | Readonly<{ kind: 'failed'; cursor: string | null; error: StudioFailure }>
  | Readonly<{
      kind: 'ready';
      cursor: string | null;
      page: HostedHistoryPage;
      selection: HostedHistorySelection;
    }>
  | Readonly<{ kind: 'ended' }>;

/** A mounted, session-bound directory and inspector. It has no draft or publication command port. */
export class HostedHistoryVisit {
  private state: HostedHistoryState = { kind: 'loading', cursor: null };
  private readonly origin;
  private readonly unsubscribe: () => void;
  private readonly listeners = new Set<() => void>();
  private readonly consumed = new Set<string>();
  private pageRequest: AbortController | null = null;
  private detailRequest: AbortController | null = null;
  private retired = false;

  constructor(
    private readonly binding: HostedHistoryBinding,
    private readonly source: HistoricalReaderSource,
  ) {
    this.origin = source.read();
    this.unsubscribe = source.subscribe(() => {
      if (!this.isCurrent()) this.retire();
    });
  }

  snapshot = (): HostedHistoryState => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  isCurrent = (): boolean => {
    const now = this.source.read();
    return (
      !this.retired &&
      this.binding.isCurrent() &&
      this.origin.healthy &&
      this.origin.state === 'signed-in' &&
      this.origin.subject === this.binding.accountId &&
      now.healthy &&
      now.state === 'signed-in' &&
      now.subject === this.binding.accountId &&
      now.sourceId === this.origin.sourceId &&
      now.generation === this.origin.generation
    );
  };

  private update(state: HostedHistoryState) {
    this.state = state;
    for (const listener of this.listeners) listener();
  }
  private clearDetail() {
    this.detailRequest?.abort();
    this.detailRequest = null;
  }
  private retire() {
    this.retired = true;
    this.pageRequest?.abort();
    this.pageRequest = null;
    this.clearDetail();
    this.consumed.clear();
    this.update({ kind: 'ended' });
  }
  dispose = () => {
    this.unsubscribe();
    this.retire();
  };

  load = async (cursor = this.state.kind === 'ended' ? null : this.state.cursor): Promise<void> => {
    if (!this.isCurrent()) {
      this.retire();
      return;
    }
    if (this.pageRequest) return;
    const request = new AbortController();
    this.pageRequest = request;
    this.clearDetail();
    // Previous rows and exact outlines disappear as soon as their page is replaced or fails.
    this.update({ kind: 'loading', cursor });
    try {
      const result = await this.binding.native.listHistory(this.binding.catalogueId, cursor, request.signal);
      if (!this.isCurrent() || request.signal.aborted) {
        this.retire();
        return;
      }
      if (!result.ok) {
        this.update({ kind: 'failed', cursor, error: result.error });
        return;
      }
      const page = result.value;
      if (page.nextCursor !== null && (page.nextCursor === cursor || this.consumed.has(page.nextCursor))) {
        this.update({
          kind: 'failed',
          cursor,
          error: { kind: 'stale', message: 'This history continuation repeated a page. Restart history.' },
        });
        return;
      }
      if (cursor !== null) this.consumed.add(cursor);
      this.update({ kind: 'ready', cursor, page, selection: { kind: 'none' } });
    } finally {
      if (this.pageRequest === request) this.pageRequest = null;
    }
  };

  next = async (): Promise<void> => {
    if (this.state.kind === 'ready' && this.state.page.nextCursor !== null) await this.load(this.state.page.nextCursor);
  };
  restart = async (): Promise<void> => {
    this.consumed.clear();
    await this.load(null);
  };
  closeSelection = () => {
    this.clearDetail();
    if (this.state.kind === 'ready') this.update({ ...this.state, selection: { kind: 'none' } });
  };

  inspect = async (revisionId: string): Promise<void> => {
    if (!this.isCurrent()) {
      this.retire();
      return;
    }
    if (this.state.kind !== 'ready') return;
    const entry = this.state.page.items.find((item) => item.revisionId === revisionId);
    if (!entry) return;
    this.clearDetail();
    const request = new AbortController();
    this.detailRequest = request;
    this.update({ ...this.state, selection: { kind: 'loading', entry } });
    try {
      // Exact native reads admit the whole tree, including its own sibling order and chapter pins.
      const result = await this.binding.native.read(
        { catalogueId: this.binding.catalogueId, kind: entry.kind, revisionId: entry.revisionId },
        request.signal,
      );
      if (!this.isCurrent()) {
        this.retire();
        return;
      }
      if (request.signal.aborted || this.detailRequest !== request || this.state.kind !== 'ready') return;
      if (!result.ok) {
        if (result.error.kind === 'denied') this.update({ kind: 'failed', cursor: this.state.cursor, error: result.error });
        else this.update({ ...this.state, selection: { kind: 'failed', entry, error: result.error } });
        return;
      }
      const revision = result.value.revision;
      if (
        revision.catalogueId !== this.binding.catalogueId ||
        revision.kind !== entry.kind ||
        revision.revisionId !== entry.revisionId ||
        revision.sourceRevisionId !== entry.sourceRevisionId
      ) {
        this.update({
          ...this.state,
          selection: {
            kind: 'failed',
            entry,
            error: { kind: 'unavailable', message: 'The exact selected version could not be read. Try again.' },
          },
        });
        return;
      }
      this.update({ ...this.state, selection: { kind: 'ready', entry, book: result.value } });
    } finally {
      if (this.detailRequest === request) this.detailRequest = null;
    }
  };
}
