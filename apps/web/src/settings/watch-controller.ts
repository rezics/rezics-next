import { withManagedReadDeadline } from './managed-read-deadline';
import { preferenceRetryDeadline } from './preference-failure-retry';
import type {
  ManagedWatch,
  NativeWatchProblem,
  StopWatchIntent,
  WatchActions,
  WatchKind,
  WatchManagementIO,
  WatchPage,
  WatchViewer,
} from './watch-native';

export const watchPageLimit = 20;

type WatchOwner = {
  subject: string;
  readCurrent(): boolean;
  credential(): string | null;
  subscribe(listener: () => void): () => void;
};
export type WatchState = Readonly<{
  kind: WatchKind;
  read: 'idle' | 'loading' | 'ready' | 'failed' | 'unavailable' | 'denied' | 'invalid_cursor';
  rows: readonly ManagedWatch[];
  cursor: string | null;
  next: string | null;
  viewer: WatchViewer | null;
  actions: WatchActions | null;
  readProblem: NativeWatchProblem | null;
  writeProblem: NativeWatchProblem | null;
  readRetryAt: number;
  writeRetryAt: number;
  command: StopWatchIntent | null;
  write: 'idle' | 'sending' | 'uncertain' | 'rejected' | 'removed' | 'removed_current' | 'conflict' | 'denied';
  retired: boolean;
}>;
const initial: WatchState = {
  kind: 'thread',
  read: 'idle',
  rows: [],
  cursor: null,
  next: null,
  viewer: null,
  actions: null,
  readProblem: null,
  writeProblem: null,
  readRetryAt: 0,
  writeRetryAt: 0,
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
  canRemove = () => this.canWrite() && this.state.actions?.remove === 'available';
  canRetryOriginal = () =>
    this.canWrite() &&
    this.state.command !== null &&
    this.state.write === 'uncertain' &&
    this.state.read === 'ready' &&
    this.state.actions?.remove === 'available' &&
    Date.now() >= this.state.writeRetryAt;

  refresh = () => this.load(this.state.cursor);
  first = () => this.load(null);
  next = () =>
    this.state.read === 'ready' && this.state.next !== null ? this.load(this.state.next) : Promise.resolve();

  selectKind = (kind: WatchKind) => {
    if (!this.current() || this.state.command || this.state.kind === kind) return Promise.resolve();
    return this.load(null, kind);
  };

  private validPage(page: WatchPage) {
    return (
      page.viewer.state === 'current' &&
      page.viewer.accountId === this.owner.subject &&
      (page.actions.remove === 'available' || page.actions.remove === 'denied') &&
      page.watches.length <= watchPageLimit &&
      new Set(page.watches.map((row) => row.subscriptionId)).size === page.watches.length &&
      page.watches.every(
        (row) =>
          row.kind === this.state.kind &&
          Number.isSafeInteger(row.revision) &&
          row.revision > 0 &&
          typeof row.createdAt === 'string' &&
          row.command.watchId === row.subscriptionId &&
          row.command.kind === row.kind &&
          row.command.expectedRevision === row.revision &&
          row.remove === page.actions.remove &&
          (row.target === null ||
            (typeof row.target.title === 'string' &&
              typeof row.target.href === 'string' &&
              row.target.href.startsWith('/'))),
      ) &&
      (page.next === null || (typeof page.next === 'string' && page.next.length > 0))
    );
  }
  private async load(cursor: string | null, kind: WatchKind = this.state.kind) {
    if (
      !this.current() ||
      this.state.read === 'loading' ||
      this.state.write === 'sending' ||
      Date.now() < this.state.readRetryAt
    )
      return;
    const generation = ++this.generation;
    this.request = new AbortController();
    // A failed refresh cannot lend its previous rows current read or command authority.
    this.update({
      read: 'loading',
      rows: [],
      cursor,
      next: null,
      kind,
      viewer: null,
      actions: null,
      readProblem: null,
    });
    try {
      const result = await withManagedReadDeadline(
        (signal) => this.io.read({ accountId: this.owner.subject, kind, limit: watchPageLimit, cursor, signal }),
        this.request.signal,
      );
      if (!this.current() || generation !== this.generation) return;
      if (result.kind === 'page' && this.validPage(result.page)) {
        this.update({
          read: 'ready',
          rows: result.page.watches,
          next: result.page.next,
          viewer: result.page.viewer,
          actions: result.page.actions,
          readProblem: null,
          readRetryAt: 0,
        });
      } else if (result.kind === 'invalid_cursor' || result.kind === 'denied' || result.kind === 'unavailable') {
        this.update({
          read: result.kind,
          readProblem: result.problem,
          readRetryAt: preferenceRetryDeadline(result.problem.retryAfter),
        });
      } else {
        this.update({ read: 'failed', readRetryAt: 0, readProblem: null });
      }
    } catch {
      if (this.current() && generation === this.generation)
        this.update({ read: 'failed', readRetryAt: 0, readProblem: null });
    }
  }

  stop = async (subscriptionId: string) => {
    const row = this.state.rows.find((candidate) => candidate.subscriptionId === subscriptionId);
    const credential = this.owner.credential();
    if (!this.canRemove() || this.state.read !== 'ready' || this.state.command || !row || !credential) return;
    const command = Object.freeze({
      accountId: this.state.viewer?.accountId ?? this.owner.subject,
      watchId: row.command.watchId,
      kind: row.command.kind,
      expectedRevision: row.command.expectedRevision,
      idempotencyKey: crypto.randomUUID(),
      credential,
    });
    this.update({ command, write: 'sending' });
    await this.send(command);
  };
  retryOriginal = async () => {
    if (!this.canRetryOriginal()) return;
    const command = this.state.command!;
    this.update({ write: 'sending' });
    await this.send(command);
  };
  private async send(command: StopWatchIntent) {
    if (!command.credential || !this.current()) return;
    try {
      // Bound waiting without claiming cancellation reversed a dispatched command.
      const result = await withManagedReadDeadline(() => this.io.stop(command, command.credential));
      if (!this.current() || this.state.command !== command) return;
      const writeRetryAt = result.kind === 'uncertain' ? preferenceRetryDeadline(result.problem.retryAfter) : 0;
      if (result.kind === 'removed') {
        const currentRevisionRemains = this.state.rows.some(
          (row) =>
            row.subscriptionId === command.watchId &&
            row.kind === command.kind &&
            row.revision !== command.expectedRevision,
        );
        this.update({
          rows: this.state.rows.filter(
            (row) =>
              row.subscriptionId !== command.watchId ||
              row.kind !== command.kind ||
              row.revision !== command.expectedRevision,
          ),
          command: null,
          write: currentRevisionRemains ? 'removed_current' : 'removed',
          writeProblem: null,
          writeRetryAt,
        });
      } else if (result.kind === 'uncertain') {
        this.update({ write: 'uncertain', writeProblem: result.problem, writeRetryAt });
      } else if (result.kind === 'denied') {
        this.update({
          command: null,
          write: 'denied',
          read: 'denied',
          rows: [],
          next: null,
          viewer: null,
          actions: null,
          writeProblem: result.problem,
          writeRetryAt,
        });
      } else {
        this.update({
          command: null,
          write: result.kind,
          read: 'failed',
          rows: [],
          next: null,
          viewer: null,
          actions: null,
          writeProblem: result.problem,
          writeRetryAt,
        });
      }
    } catch {
      if (this.current() && this.state.command === command)
        this.update({ write: 'uncertain', writeProblem: { status: null, code: null }, writeRetryAt: 0 });
    }
  }
}
