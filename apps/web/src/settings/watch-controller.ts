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
export const watchPreviousLimit = 8;
export const watchCursorLimit = 4096;
export const watchPageByteLimit = 262_144;

export type WatchAddress = Readonly<{ kind: WatchKind; cursor: string | null }>;
export type WatchReturnReceipt = Readonly<{
  locator: Readonly<{ current: WatchAddress; previous: readonly WatchAddress[] }>;
  identity: Readonly<{ subscriptionId: string; kind: WatchKind; revision: number }>;
  focusRequested: boolean;
}>;

export type WatchReturnOutcome = 'restored' | 'missing' | 'changed' | 'withheld';

type ReadRequest = Readonly<{
  kind: WatchKind;
  cursor: string | null;
  previousAfter: readonly WatchAddress[];
  previousOnStart?: readonly WatchAddress[];
  returnReceipt?: WatchReturnReceipt;
}>;

function validAddress(value: unknown, kind?: WatchKind): value is WatchAddress {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const address = value as Record<string, unknown>;
  return (
    Object.keys(address).length === 2 &&
    (address.kind === 'thread' || address.kind === 'board') &&
    (kind === undefined || address.kind === kind) &&
    (address.cursor === null ||
      (typeof address.cursor === 'string' && address.cursor.length > 0 && address.cursor.length <= watchCursorLimit))
  );
}

function fitsPageBudget(page: WatchPage): boolean {
  try {
    const encoded = JSON.stringify(page);
    return typeof encoded === 'string' && new TextEncoder().encode(encoded).byteLength <= watchPageByteLimit;
  } catch {
    return false;
  }
}

/** Validate the small browser-history locator without admitting it as a row or command. */
export function isWatchReturnReceipt(value: unknown): value is WatchReturnReceipt {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const receipt = value as Record<string, unknown>;
  if (Object.keys(receipt).length !== 3 || typeof receipt.focusRequested !== 'boolean') return false;
  const locator = receipt.locator;
  const identity = receipt.identity;
  if (
    !locator ||
    typeof locator !== 'object' ||
    Array.isArray(locator) ||
    !identity ||
    typeof identity !== 'object' ||
    Array.isArray(identity)
  )
    return false;
  const location = locator as Record<string, unknown>;
  const selected = identity as Record<string, unknown>;
  if (
    Object.keys(location).length !== 2 ||
    !validAddress(location.current) ||
    !Array.isArray(location.previous) ||
    location.previous.length > watchPreviousLimit ||
    !location.previous.every((address) => validAddress(address, (location.current as WatchAddress).kind)) ||
    Object.keys(selected).length !== 3 ||
    typeof selected.subscriptionId !== 'string' ||
    selected.subscriptionId.length === 0 ||
    (selected.kind !== 'thread' && selected.kind !== 'board') ||
    selected.kind !== (location.current as WatchAddress).kind ||
    !Number.isSafeInteger(selected.revision) ||
    (selected.revision as number) < 1
  )
    return false;
  try {
    // Keep the structured-clone payload finite even if an admitted native identifier is unusually large.
    const encoded = JSON.stringify(value);
    return typeof encoded === 'string' && new TextEncoder().encode(encoded).byteLength <= 65_536;
  } catch {
    return false;
  }
}

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
  previous: readonly WatchAddress[];
  viewer: WatchViewer | null;
  actions: WatchActions | null;
  readProblem: NativeWatchProblem | null;
  writeProblem: NativeWatchProblem | null;
  readRetryAt: number;
  writeRetryAt: number;
  command: StopWatchIntent | null;
  write: 'idle' | 'sending' | 'uncertain' | 'rejected' | 'removed' | 'removed_current' | 'conflict' | 'denied';
  returnOutcome: WatchReturnOutcome | null;
  returnFocus: (WatchReturnReceipt & { outcome: WatchReturnOutcome }) | null;
  retired: boolean;
}>;
const initial: WatchState = {
  kind: 'thread',
  read: 'idle',
  rows: [],
  cursor: null,
  next: null,
  previous: [],
  viewer: null,
  actions: null,
  readProblem: null,
  writeProblem: null,
  readRetryAt: 0,
  writeRetryAt: 0,
  command: null,
  write: 'idle',
  returnOutcome: null,
  returnFocus: null,
  retired: false,
};

// One response deadline survives a Watch view controller remount under the same installed Settings owner.
const watchWriteRetryAt = new WeakMap<object, number>();

/** One bounded page and one original unresolved intent, scoped to the installed Settings observation. */
export class WatchController {
  private state: WatchState = initial;
  private listeners = new Set<() => void>();
  private generation = 0;
  private request: AbortController | undefined;
  private unsubscribe: (() => void) | undefined;
  private recovery: ReadRequest | undefined;
  private readonly ownerScope: object;
  constructor(
    private io: WatchManagementIO,
    private owner: WatchOwner,
    ownerScope: object = owner,
  ) {
    this.ownerScope = ownerScope;
    const deadline = watchWriteRetryAt.get(ownerScope) ?? 0;
    if (deadline > Date.now()) this.state = { ...initial, writeRetryAt: deadline };
    else watchWriteRetryAt.delete(ownerScope);
  }

  private writeWaitActive() {
    const now = Date.now();
    const viewDeadline = this.state.writeRetryAt;
    const ownerDeadline = watchWriteRetryAt.get(this.ownerScope) ?? 0;
    return Math.max(viewDeadline > now ? viewDeadline : 0, ownerDeadline > now ? ownerDeadline : 0) > now;
  }

  private keepWriteWait(retryAfter?: string) {
    const now = Date.now();
    const viewDeadline = this.state.writeRetryAt;
    const ownerDeadline = watchWriteRetryAt.get(this.ownerScope) ?? 0;
    const previous = Math.max(viewDeadline > now ? viewDeadline : 0, ownerDeadline > now ? ownerDeadline : 0);
    const deadline = Math.max(previous, preferenceRetryDeadline(retryAfter, now));
    if (deadline > now) watchWriteRetryAt.set(this.ownerScope, deadline);
    else watchWriteRetryAt.delete(this.ownerScope);
    return deadline;
  }

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
    this.recovery = undefined;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    // Neither private data nor an old account's recovery callback survives retirement.
    this.update({ ...initial, retired: true });
  };
  needsDecision = () => this.current() && this.state.command !== null;
  canWrite = () => this.current() && !!this.owner.credential();
  canRemove = () => this.canWrite() && this.state.actions?.remove === 'available' && !this.writeWaitActive();
  canRetryOriginal = () =>
    this.canWrite() &&
    this.state.command !== null &&
    this.state.write === 'uncertain' &&
    this.state.read === 'ready' &&
    this.state.actions?.remove === 'available' &&
    !this.writeWaitActive();

  refresh = () => {
    const request = this.recovery ?? {
      kind: this.state.kind,
      cursor: this.state.cursor,
      previousAfter: this.state.previous,
    };
    return this.load(request);
  };
  first = () => this.load({ kind: this.state.kind, cursor: null, previousAfter: [], previousOnStart: [] });
  next = () =>
    this.state.read === 'ready' && this.state.next !== null
      ? this.load({
          kind: this.state.kind,
          cursor: this.state.next,
          previousAfter: [...this.state.previous, { kind: this.state.kind, cursor: this.state.cursor }].slice(
            -watchPreviousLimit,
          ),
        })
      : Promise.resolve();
  previous = () => {
    const address = this.state.previous.at(-1);
    if (this.state.read !== 'ready' || !address || address.kind !== this.state.kind) return Promise.resolve();
    return this.load({
      kind: address.kind,
      cursor: address.cursor,
      previousAfter: this.state.previous.slice(0, -1),
    });
  };

  captureReturn = (subscriptionId: string, focusRequested: boolean): WatchReturnReceipt | null => {
    if (!this.current() || this.state.read !== 'ready' || !this.state.viewer || !this.state.actions) return null;
    const row = this.state.rows.find(
      (candidate) => candidate.subscriptionId === subscriptionId && candidate.kind === this.state.kind,
    );
    if (!row?.target) return null;
    const receipt: WatchReturnReceipt = {
      locator: {
        current: { kind: this.state.kind, cursor: this.state.cursor },
        previous: this.state.previous.map((address) => ({ ...address })),
      },
      identity: { subscriptionId: row.subscriptionId, kind: row.kind, revision: row.revision },
      focusRequested,
    };
    return isWatchReturnReceipt(receipt) ? receipt : null;
  };

  returnTo = (receipt: WatchReturnReceipt) => {
    if (!isWatchReturnReceipt(receipt) || !this.current()) return Promise.resolve();
    return this.load({
      kind: receipt.locator.current.kind,
      cursor: receipt.locator.current.cursor,
      previousAfter: receipt.locator.previous,
      previousOnStart: receipt.locator.previous,
      returnReceipt: receipt,
    });
  };

  finishReturnFocus = () => {
    if (this.state.returnFocus) this.update({ returnFocus: null });
  };

  selectKind = (kind: WatchKind) => {
    if (!this.current() || this.state.command || this.state.kind === kind) return Promise.resolve();
    return this.load({ kind, cursor: null, previousAfter: [], previousOnStart: [] });
  };

  private validPage(page: WatchPage, kind: WatchKind) {
    return (
      fitsPageBudget(page) &&
      page.viewer.state === 'current' &&
      page.viewer.accountId === this.owner.subject &&
      (page.actions.remove === 'available' || page.actions.remove === 'denied') &&
      page.watches.length <= watchPageLimit &&
      new Set(page.watches.map((row) => row.subscriptionId)).size === page.watches.length &&
      page.watches.every(
        (row) =>
          row.kind === kind &&
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
              row.target.href.startsWith('/') &&
              !row.target.href.startsWith('//'))),
      ) &&
      (page.next === null ||
        (typeof page.next === 'string' && page.next.length > 0 && page.next.length <= watchCursorLimit))
    );
  }
  private async load(request: ReadRequest) {
    if (
      !this.current() ||
      this.state.read === 'loading' ||
      this.state.write === 'sending' ||
      Date.now() < this.state.readRetryAt
    )
      return;
    this.recovery = request;
    const generation = ++this.generation;
    this.request = new AbortController();
    // A failed refresh cannot lend its previous rows current read or command authority.
    this.update({
      read: 'loading',
      rows: [],
      cursor: request.cursor,
      next: null,
      ...(request.previousOnStart ? { previous: request.previousOnStart } : {}),
      kind: request.kind,
      viewer: null,
      actions: null,
      readProblem: null,
      returnOutcome: null,
      returnFocus: null,
    });
    try {
      const result = await withManagedReadDeadline(
        (signal) =>
          this.io.read({
            accountId: this.owner.subject,
            kind: request.kind,
            limit: watchPageLimit,
            cursor: request.cursor,
            signal,
          }),
        this.request.signal,
      );
      if (!this.current() || generation !== this.generation) return;
      if (result.kind === 'page' && this.validPage(result.page, request.kind)) {
        let returnOutcome: WatchReturnOutcome | null = null;
        let returnFocus: (WatchReturnReceipt & { outcome: WatchReturnOutcome }) | null = null;
        if (request.returnReceipt) {
          const { identity } = request.returnReceipt;
          const row = result.page.watches.find(
            (candidate) => candidate.subscriptionId === identity.subscriptionId && candidate.kind === identity.kind,
          );
          returnOutcome = !row
            ? 'missing'
            : row.revision !== identity.revision
              ? 'changed'
              : row.target === null
                ? 'withheld'
                : 'restored';
          returnFocus = { ...request.returnReceipt, outcome: returnOutcome };
        }
        this.recovery = undefined;
        this.update({
          read: 'ready',
          rows: result.page.watches,
          next: result.page.next,
          previous: request.previousAfter,
          viewer: result.page.viewer,
          actions: result.page.actions,
          readProblem: null,
          readRetryAt: 0,
          returnOutcome,
          returnFocus,
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
    await this.send(command, false);
  };
  retryOriginal = async () => {
    if (!this.canRetryOriginal()) return;
    const command = this.state.command!;
    this.update({ write: 'sending' });
    await this.send(command, true);
  };
  private async send(command: StopWatchIntent, replay: boolean) {
    if (!command.credential || !this.current()) return;
    try {
      // Bound waiting without claiming cancellation reversed a dispatched command.
      const result = await withManagedReadDeadline(() => this.io.stop(command, command.credential));
      if (!this.current() || this.state.command !== command) return;
      const writeRetryAt = this.keepWriteWait(result.kind === 'removed' ? undefined : result.problem.retryAfter);
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
          command: replay ? command : null,
          write: replay ? 'uncertain' : 'denied',
          read: 'denied',
          rows: [],
          next: null,
          viewer: null,
          actions: null,
          readProblem: result.problem,
          writeProblem: result.problem,
          writeRetryAt,
        });
      } else if (replay) {
        this.update({
          command,
          write: 'uncertain',
          read: 'failed',
          rows: [],
          next: null,
          viewer: null,
          actions: null,
          readProblem: null,
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
