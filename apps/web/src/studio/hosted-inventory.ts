import type { HistoricalReaderSource } from '../threads/historical-reader-provenance';
import type { StudioFailure } from './contract';
import {
  sameHostedViewer,
  type HostedBookNative,
  type HostedOwnerBinding,
  type HostedOwnerBook,
  type HostedOwnerInventory,
  type HostedOwnerViewer,
} from './hosted-contract';

export type HostedInventoryState =
  | Readonly<{ kind: 'loading'; cursor: string | null }>
  | Readonly<{ kind: 'ready'; cursor: string | null; page: HostedOwnerInventory }>
  | Readonly<{ kind: 'failed'; cursor: string | null; error: StudioFailure }>
  | Readonly<{ kind: 'ended' }>;

/** One mounted inventory. Session replacement retires it permanently, including equal-account replacement. */
export class HostedInventoryVisit {
  private state: HostedInventoryState;
  private binding: HostedOwnerBinding | undefined;
  private readonly origin;
  private readonly unsubscribe: () => void;
  private readonly listeners = new Set<() => void>();
  private readonly consumed = new Set<string>();
  private request: AbortController | null = null;
  private retired = false;

  constructor(
    private readonly native: Pick<HostedBookNative, 'listOwn'>,
    private readonly source: HistoricalReaderSource,
    private readonly accountId: string,
    cursor: string | null = null,
  ) {
    this.origin = source.read();
    this.state = { kind: 'loading', cursor };
    this.unsubscribe = source.subscribe(() => {
      if (!this.isCurrent()) this.retire();
    });
  }

  snapshot = (): HostedInventoryState => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  isCurrent = (): boolean => {
    const now = this.source.read();
    return (
      !this.retired &&
      now.healthy &&
      this.origin.healthy &&
      this.origin.state === 'signed-in' &&
      this.origin.subject === this.accountId &&
      now.state === 'signed-in' &&
      now.subject === this.accountId &&
      now.sourceId === this.origin.sourceId &&
      now.generation === this.origin.generation
    );
  };

  private update(state: HostedInventoryState) {
    this.state = state;
    for (const listener of this.listeners) listener();
  }

  private retire() {
    this.retired = true;
    this.request?.abort();
    this.request = null;
    this.binding = undefined;
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
    if (this.request) return;
    const request = new AbortController();
    this.request = request;
    this.update({ kind: 'loading', cursor });
    try {
      const result = await this.native.listOwn(this.accountId, cursor, request.signal, this.binding);
      if (!this.isCurrent() || request.signal.aborted) {
        this.retire();
        return;
      }
      if (!result.ok) {
        this.update({ kind: 'failed', cursor, error: result.error });
        return;
      }
      const page = result.value;
      if (
        page.viewer.accountId !== this.accountId ||
        (this.binding && !sameHostedViewer(page.viewer, this.binding.viewer))
      ) {
        this.retire();
        return;
      }
      if (
        (this.binding &&
          (page.scope.kind !== this.binding.scope.kind || page.scope.route !== this.binding.scope.route)) ||
        (page.nextCursor !== null && (page.nextCursor === cursor || this.consumed.has(page.nextCursor)))
      ) {
        this.update({
          kind: 'failed',
          cursor,
          error: { kind: 'stale', message: 'The inventory continuation changed. Reopen your books.' },
        });
        return;
      }
      // Sparse native pages can be empty and still have an exact raw-key continuation.
      if (cursor !== null) this.consumed.add(cursor);
      this.binding = { scope: page.scope, viewer: page.viewer };
      this.update({ kind: 'ready', cursor, page });
    } finally {
      if (this.request === request) this.request = null;
    }
  };

  next = async (): Promise<void> => {
    if (this.state.kind === 'ready' && this.state.page.nextCursor !== null) await this.load(this.state.page.nextCursor);
  };
}

/** This URL carries a native viewer comparison, never an account or home authorization claim. */
export function hostedOwnerBookHref(book: HostedOwnerBook, viewer: HostedOwnerViewer): string {
  const query = new URLSearchParams({
    catalogueId: book.catalogueId,
    ownerAccount: viewer.accountId,
    ownerEpoch: String(viewer.authnEpoch),
  });
  return `/studio?${query}`;
}
