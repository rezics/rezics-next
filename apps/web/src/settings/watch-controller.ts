import { withManagedReadDeadline } from './managed-read-deadline';
import type { ManagedWatch, StopWatch, WatchManagementIO, WatchPage } from './watch-native';

export const watchPageLimit = 20;

type WatchOwner = {
  readCurrent(): boolean;
  credential(): string | null;
  subscribe(listener: () => void): () => void;
};
export type WatchState = Readonly<{
  read: 'idle' | 'loading' | 'ready' | 'failed' | 'unavailable';
  rows: readonly ManagedWatch[];
  cursor: string | null;
  next: string | null;
  command: StopWatch | null;
  write: 'idle' | 'sending' | 'uncertain' | 'rejected' | 'removed';
  retired: boolean;
}>;
const initial: WatchState = {
  read: 'idle',
  rows: [],
  cursor: null,
  next: null,
  command: null,
  write: 'idle',
  retired: false,
};

/** One bounded page and one original unresolved intent, scoped to the installed Settings observation. */
export class WatchController {
  private state: WatchState = initial;
  private listeners = new Set<() => void>();
  private generation = 0;
  private request: AbortController | undefined;
  private unsubscribe: (() => void) | undefined;
  constructor(
    private io: WatchManagementIO,
    private owner: WatchOwner,
  ) {}

  snapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private update(patch: Partial<WatchState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((listener) => listener());
  }
  private current() {
    if (!this.state.retired && !this.owner.readCurrent()) this.retire();
    return !this.state.retired;
  }
  mount = () => {
    this.unsubscribe ??= this.owner.subscribe(() => {
      this.current();
    });
    this.current();
  };
  retire = () => {
    if (this.state.retired) return;
    ++this.generation;
    this.request?.abort();
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    // Neither private data nor an old account's recovery callback survives retirement.
    this.update({ ...initial, retired: true });
  };
  needsDecision = () => this.current() && this.state.command !== null;
  canWrite = () => this.current() && !!this.owner.credential();

  refresh = () => this.load(this.state.cursor);
  first = () => this.load(null);
  next = () =>
    this.state.read === 'ready' && this.state.next !== null ? this.load(this.state.next) : Promise.resolve();

  private validPage(page: WatchPage) {
    return (
      page.watches.length <= watchPageLimit &&
      new Set(page.watches.map((row) => row.subscriptionId)).size === page.watches.length &&
      (page.next === null || (typeof page.next === 'string' && page.next.length > 0))
    );
  }
  private async load(cursor: string | null) {
    if (!this.current() || this.state.read === 'loading' || this.state.write === 'sending') return;
    const generation = ++this.generation;
    this.request = new AbortController();
    // A failed refresh cannot lend its previous rows current read or command authority.
    this.update({ read: 'loading', rows: [], cursor, next: null });
    try {
      const result = await withManagedReadDeadline(
        (signal) => this.io.read({ limit: watchPageLimit, cursor, signal }),
        this.request.signal,
      );
      if (!this.current() || generation !== this.generation) return;
      if (result.kind === 'unavailable') {
        this.update({ read: 'unavailable' });
      } else if (this.validPage(result.page)) {
        this.update({ read: 'ready', rows: result.page.watches, next: result.page.next });
      } else {
        this.update({ read: 'failed' });
      }
    } catch {
      if (this.current() && generation === this.generation) this.update({ read: 'failed' });
    }
  }

  stop = async (subscriptionId: string) => {
    if (
      !this.canWrite() ||
      this.state.read !== 'ready' ||
      this.state.command ||
      !this.state.rows.some((row) => row.subscriptionId === subscriptionId)
    )
      return;
    const command = Object.freeze({ subscriptionId, idempotencyKey: crypto.randomUUID() });
    this.update({ command, write: 'sending' });
    await this.send(command);
  };
  retryOriginal = async () => {
    const command = this.state.command;
    if (!this.canWrite() || !command || this.state.write !== 'uncertain' || this.state.read === 'loading') return;
    this.update({ write: 'sending' });
    await this.send(command);
  };
  private async send(command: StopWatch) {
    const credential = this.owner.credential();
    if (!credential || !this.current()) return;
    try {
      // Bound waiting without claiming cancellation reversed a dispatched command.
      const result = await withManagedReadDeadline(() => this.io.stop(command, credential));
      if (!this.current() || this.state.command !== command) return;
      if (result.kind === 'removed') {
        this.update({
          rows: this.state.rows.filter((row) => row.subscriptionId !== command.subscriptionId),
          command: null,
          write: 'removed',
        });
      } else if (result.kind === 'rejected') {
        this.update({ command: null, write: 'rejected', read: 'failed', rows: [], next: null });
      } else {
        this.update({ write: 'uncertain' });
      }
    } catch {
      if (this.current() && this.state.command === command) this.update({ write: 'uncertain' });
    }
  }
}
