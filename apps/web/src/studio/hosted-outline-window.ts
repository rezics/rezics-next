import type { HistoricalReaderSource } from '../threads/historical-reader-provenance';
import type { StudioFailure } from './contract';
import type { HostedOutlineWindowNative, HostedOutlineWindowPage, HostedRevision } from './hosted-contract';

export type HostedOutlineWindowState =
  | Readonly<{ kind: 'loading'; cursor: string | null }>
  | Readonly<{ kind: 'ready'; cursor: string | null; page: HostedOutlineWindowPage }>
  | Readonly<{ kind: 'failed'; cursor: string | null; error: StudioFailure }>
  | Readonly<{ kind: 'ended' }>;

/** Exact history inspection owns one page without entering the complete-tree edit adapter. */
export class HostedOutlineWindow {
  private state: HostedOutlineWindowState = { kind: 'loading', cursor: null };
  private readonly origin;
  private readonly revision: HostedRevision;
  private readonly unsubscribe: () => void;
  private readonly listeners = new Set<() => void>();
  private request: AbortController | null = null;
  private retired = false;

  constructor(
    private readonly native: HostedOutlineWindowNative,
    private readonly source: HistoricalReaderSource,
    private readonly accountId: string,
    revision: HostedRevision,
    private readonly ownerCurrent: () => boolean = () => true,
  ) {
    this.revision = { ...revision };
    this.origin = source.read();
    this.unsubscribe = source.subscribe(() => {
      if (!this.isCurrent()) this.retire();
    });
  }

  snapshot = (): HostedOutlineWindowState => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  isCurrent = (): boolean => {
    const now = this.source.read();
    return (
      !this.retired &&
      this.ownerCurrent() &&
      this.origin.healthy &&
      now.healthy &&
      this.origin.credentialMode === 'session' &&
      now.credentialMode === 'session' &&
      this.origin.state === 'signed-in' &&
      now.state === 'signed-in' &&
      this.origin.subject === this.accountId &&
      now.subject === this.accountId &&
      this.origin.sourceId === now.sourceId &&
      this.origin.generation === now.generation
    );
  };

  private update(state: HostedOutlineWindowState) {
    this.state = state;
    for (const listener of this.listeners) listener();
  }
  private retire() {
    this.retired = true;
    this.request?.abort();
    this.request = null;
    this.update({ kind: 'ended' });
  }
  dispose = () => {
    this.unsubscribe();
    this.retire();
  };

  /** Retry defaults to the failed cursor. A rejected continuation never falls back to page one. */
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
      const result = await this.native.readOutlineWindow({ revision: this.revision, cursor }, request.signal);
      if (!this.isCurrent() || request.signal.aborted) {
        this.retire();
        return;
      }
      this.update(
        result.ok ? { kind: 'ready', cursor, page: result.value } : { kind: 'failed', cursor, error: result.error },
      );
    } finally {
      if (this.request === request) this.request = null;
    }
  };

  next = async (): Promise<void> => {
    if (this.state.kind === 'ready' && this.state.page.nextCursor !== null) await this.load(this.state.page.nextCursor);
  };
}
