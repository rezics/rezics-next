import type { CollectionVisibility } from '../library/reads';
import type {
  CollectionVisibilityWrite,
  NativePreferenceFailure,
  OwnedCollection,
  OwnedCollectionsPage,
} from './preferences';
import {
  collectionPrivacyFailureMetadata,
  isCollectionPrivacyReadRefusal,
  type CollectionPrivacyFailure,
  type CollectionPrivacyRead,
} from './collection-privacy-data';
import { preferenceRetryDeadline } from './preference-failure-retry';

export type VisibilityAttempt = Readonly<{
  collectionId: string;
  revision: number;
  visibility: CollectionVisibility;
  idempotencyKey: string;
}>;
export type CollectionPrivacyIO = {
  save: (input: VisibilityAttempt) => Promise<CollectionVisibilityWrite>;
  read: (id: string) => Promise<CollectionPrivacyRead<OwnedCollection>>;
};
type VisibilityReceipt = { id: string; revision: number; visibility: CollectionVisibility };
type EditorState = {
  current: OwnedCollection | null;
  desired: CollectionVisibility;
  attempt: VisibilityAttempt | null;
  receipt: VisibilityReceipt | null;
  outcomeUnknown: boolean;
  readRefusal: 'closed' | 'forbidden' | null;
  phase:
    | 'idle'
    | 'saving'
    | 'uncertain'
    | 'readback'
    | 'conflict'
    | 'refused'
    | 'review'
    | 'reloading'
    | 'saved'
    | 'abandoned';
  failure?: CollectionPrivacyFailure | 'invalid' | undefined;
  nativeFailure?: NativePreferenceFailure | undefined;
};

class Observable<State> {
  protected listeners = new Set<() => void>();
  protected generation = 0;
  protected disposed = false;
  protected live = () => !this.disposed && this.isCurrent();
  constructor(
    protected state: State,
    private isCurrent: () => boolean = () => true,
  ) {}
  snapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  dispose = () => {
    this.disposed = true;
    this.generation++;
  };
  protected update(patch: Partial<State>) {
    if (!this.live()) return;
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((listener) => listener());
  }
}

/** An unresolved command never becomes the next draft's command. */
export class CollectionPrivacyEditor extends Observable<EditorState> {
  private edits = 0;
  private commandRetryAt = 0;
  private currentReadRetryAt = 0;
  constructor(
    current: OwnedCollection,
    private io: CollectionPrivacyIO,
    isCurrent: () => boolean = () => true,
    private canWrite: () => boolean = isCurrent,
    private now: () => number = Date.now,
  ) {
    super(
      {
        current,
        desired: current.visibility,
        attempt: null,
        receipt: null,
        outcomeUnknown: false,
        readRefusal: null,
        phase: 'idle',
      },
      isCurrent,
    );
  }
  commandRetryDeadline = () => this.commandRetryAt;
  currentReadRetryDeadline = () => this.currentReadRetryAt;
  private commandWaiting = () => this.commandRetryAt > this.now();
  private currentReadWaiting = () => this.currentReadRetryAt > this.now();
  private retainCommandWait = (failure: NativePreferenceFailure | undefined) => {
    this.commandRetryAt = Math.max(
      this.commandRetryAt,
      preferenceRetryDeadline(failure?.retryAfter, this.now()),
    );
  };
  private retainCurrentReadWait = (failure: NativePreferenceFailure | undefined) => {
    this.currentReadRetryAt = Math.max(
      this.currentReadRetryAt,
      preferenceRetryDeadline(failure?.retryAfter, this.now()),
    );
  };
  override dispose = () => {
    this.commandRetryAt = 0;
    this.currentReadRetryAt = 0;
    this.state = {
      current: null,
      desired: 'private',
      attempt: null,
      receipt: null,
      outcomeUnknown: false,
      readRefusal: null,
      phase: 'idle',
    };
    this.disposed = true;
    this.generation++;
    this.listeners.forEach((listener) => listener());
    this.listeners.clear();
  };
  needsListRestartProtection = () => {
    const current = this.state.current;
    return (
      this.state.attempt !== null ||
      (this.state.phase !== 'abandoned' && current !== null && this.state.desired !== current.visibility) ||
      this.state.phase === 'saving' ||
      this.state.phase === 'reloading'
    );
  };
  /** A fresh list may update a clean mounted row, but cannot resolve its command or replace a draft. */
  receive(current: OwnedCollection) {
    if (!this.live()) return;
    const existing = this.state.current;
    if (
      !existing ||
      this.needsListRestartProtection() ||
      this.state.readRefusal ||
      current === existing ||
      current.id !== existing.id ||
      (existing.revision !== null && current.revision !== null && current.revision < existing.revision) ||
      (current.revision === existing.revision && current.visibility !== existing.visibility)
    )
      return;
    this.update({
      current,
      desired: current.visibility,
      phase: this.state.phase === 'abandoned' ? 'abandoned' : 'idle',
    });
  }
  async edit(desired: CollectionVisibility) {
    if (!this.live() || !this.canWrite() || this.state.phase === 'abandoned') return;
    const current = this.state.current;
    if (
      !current ||
      current.revision === null ||
      (desired !== current.visibility && !current.allowedVisibilityActions.includes(desired))
    )
      return;
    if (this.state.readRefusal) return;
    this.edits++;
    this.update({ desired });
    if (this.state.phase === 'idle' || this.state.phase === 'saved') await this.submit();
  }
  async submit() {
    if (!this.live() || !this.canWrite() || this.commandWaiting()) return;
    const current = this.state.current;
    if (
      this.state.readRefusal ||
      this.state.attempt ||
      this.state.phase === 'abandoned' ||
      !['idle', 'saved', 'review'].includes(this.state.phase)
    )
      return;
    if (
      !current ||
      current.revision === null ||
      this.state.desired === current.visibility ||
      !current.allowedVisibilityActions.includes(this.state.desired)
    )
      return;
    const attempt = Object.freeze({
      collectionId: current.id,
      revision: current.revision,
      visibility: this.state.desired,
      idempotencyKey: crypto.randomUUID(),
    });
    this.update({ attempt });
    await this.send(false);
  }
  async retry() {
    if (!this.live() || !this.canWrite() || this.commandWaiting()) return;
    if (!this.state.readRefusal && this.state.attempt && this.state.phase === 'uncertain') await this.send(true);
  }
  abandon() {
    if (!this.live() || !this.state.attempt || !['uncertain', 'readback'].includes(this.state.phase)) return;
    this.commandRetryAt = 0;
    this.currentReadRetryAt = 0;
    this.update({
      attempt: null,
      receipt: null,
      desired: this.state.current?.visibility ?? this.state.desired,
      phase: 'abandoned',
      failure: undefined,
      nativeFailure: undefined,
    });
  }
  private async send(recovering: boolean) {
    if (!this.live() || !this.canWrite() || this.commandWaiting()) return;
    const attempt = this.state.attempt;
    if (!attempt) return;
    const generation = this.generation;
    this.update({ phase: 'saving', failure: undefined, nativeFailure: undefined });
    try {
      const answer = await this.io.save(attempt);
      if (!this.live() || !this.canWrite() || generation !== this.generation) return;
      if (!answer.ok) {
        this.retainCommandWait(answer.failure);
        if (this.state.receipt) {
          this.update({
            phase: 'readback',
            failure: answer.reason === 'conflict' ? undefined : answer.reason,
            nativeFailure: answer.failure,
          });
          return;
        }
        this.update(
          answer.reason === 'unavailable' || (recovering && answer.reason !== 'conflict')
            ? // A refused replay cannot establish whether the earlier transport-ambiguous command committed.
              { phase: 'uncertain', failure: answer.reason, nativeFailure: answer.failure, outcomeUnknown: true }
            : {
                attempt: null,
                receipt: null,
                outcomeUnknown: false,
                phase: answer.reason === 'conflict' ? 'conflict' : 'refused',
                failure: answer.reason === 'conflict' ? undefined : answer.reason,
                nativeFailure: answer.failure,
              },
        );
        return;
      }
      const receipt = answer.collection;
      if (
        receipt.id !== attempt.collectionId ||
        receipt.revision === null ||
        receipt.revision !== attempt.revision + 1 ||
        receipt.visibility !== attempt.visibility
      ) {
        this.update({ phase: this.state.receipt ? 'readback' : 'uncertain', failure: 'unavailable' });
        return;
      }
      if (!recovering) {
        this.commandRetryAt = 0;
        this.update({
          current: receipt,
          attempt: null,
          receipt: null,
          outcomeUnknown: false,
          phase: this.state.desired === receipt.visibility ? 'saved' : 'review',
        });
        return;
      }
      // A replay receipt is historical. Read current native state without replacing a later draft.
      const originalReceipt = { id: receipt.id, revision: receipt.revision, visibility: receipt.visibility };
      this.commandRetryAt = 0;
      const readWaiting = this.currentReadWaiting();
      this.update({
        phase: readWaiting ? 'readback' : 'reloading',
        receipt: originalReceipt,
        outcomeUnknown: false,
        nativeFailure: undefined,
      });
      if (readWaiting) return;
      const read = await this.io.read(attempt.collectionId);
      if (!this.live() || generation !== this.generation) return;
      if (!read.ok) {
        this.retainCurrentReadWait(read.failure);
        const readRefusal = isCollectionPrivacyReadRefusal(read.reason) ? read.reason : null;
        const refused = readRefusal !== null;
        this.update({
          ...(refused ? { current: null } : {}),
          phase: 'readback',
          failure: read.reason,
          nativeFailure: read.failure,
          readRefusal: readRefusal ?? this.state.readRefusal,
        });
        return;
      }
      this.currentReadRetryAt = 0;
      const current = read.value;
      if (
        current.id !== originalReceipt.id ||
        current.revision === null ||
        current.revision < originalReceipt.revision ||
        (current.revision === originalReceipt.revision && current.visibility !== originalReceipt.visibility)
      ) {
        this.update({ phase: 'readback', failure: 'unavailable' });
        return;
      }
      this.update({
        current,
        attempt: null,
        receipt: null,
        outcomeUnknown: false,
        phase: this.state.desired === current.visibility ? 'saved' : 'review',
        readRefusal: null,
      });
    } catch (error) {
      if (this.live() && generation === this.generation) {
        const nativeFailure = collectionPrivacyFailureMetadata(error);
        if (this.state.receipt) this.retainCurrentReadWait(nativeFailure);
        else this.retainCommandWait(nativeFailure);
        this.update({
          phase: this.state.receipt ? 'readback' : 'uncertain',
          failure: 'unavailable',
          nativeFailure,
          outcomeUnknown: this.state.receipt ? false : true,
        });
      }
    }
  }
  async reload() {
    if (!this.live() || this.currentReadWaiting()) return;
    const current = this.state.current;
    const attempt = this.state.attempt;
    const collectionId = current?.id ?? attempt?.collectionId;
    if (
      !collectionId ||
      this.state.phase === 'saving' ||
      this.state.phase === 'reloading' ||
      this.state.phase === 'abandoned'
    )
      return;
    const generation = this.generation;
    const edits = this.edits;
    const previous = this.state.phase;
    const receipt = this.state.receipt;
    this.update({ phase: 'reloading', nativeFailure: undefined });
    try {
      const read = await this.io.read(collectionId);
      if (!this.live() || generation !== this.generation) return;
      if (!read.ok) {
        this.retainCurrentReadWait(read.failure);
        const readRefusal = isCollectionPrivacyReadRefusal(read.reason) ? read.reason : null;
        const refused = readRefusal !== null;
        this.update({
          ...(refused ? { current: null, ...(attempt ? {} : { desired: 'private' as const }) } : {}),
          phase: refused ? (attempt ? (receipt ? 'readback' : 'uncertain') : 'refused') : previous,
          failure: read.reason,
          nativeFailure: read.failure,
          readRefusal: readRefusal ?? this.state.readRefusal,
        });
        return;
      }
      this.currentReadRetryAt = 0;
      if (
        read.value.id !== collectionId ||
        (current?.revision !== null &&
          current?.revision !== undefined &&
          read.value.revision !== null &&
          read.value.revision < current.revision) ||
        (current && read.value.revision === current.revision && read.value.visibility !== current.visibility) ||
        (attempt && read.value.revision !== null && read.value.revision < (receipt?.revision ?? attempt.revision)) ||
        (receipt &&
          (read.value.revision === null ||
            read.value.revision < receipt.revision ||
            (read.value.revision === receipt.revision && read.value.visibility !== receipt.visibility)))
      )
        throw new Error('Stale Collection read');
      if (attempt && !receipt) {
        // Current state is useful advice, but cannot prove the original command applied or did not apply.
        this.update({
          current: read.value,
          readRefusal: null,
          phase: 'uncertain',
          outcomeUnknown: true,
          failure: undefined,
          nativeFailure: undefined,
        });
        return;
      }
      const desired = attempt ? this.state.desired : edits === this.edits ? read.value.visibility : this.state.desired;
      this.update({
        current: read.value,
        desired,
        attempt: null,
        receipt: null,
        outcomeUnknown: false,
        readRefusal: null,
        phase: desired === read.value.visibility ? 'idle' : 'review',
        failure: undefined,
        nativeFailure: undefined,
      });
    } catch (error) {
      if (this.live() && generation === this.generation) {
        const nativeFailure = collectionPrivacyFailureMetadata(error);
        this.retainCurrentReadWait(nativeFailure);
        this.update({
          phase: previous,
          failure: 'unavailable',
          nativeFailure,
        });
      }
    }
  }
}

type PageState = {
  collections: OwnedCollection[];
  next: string | null;
  window: number;
  loaded: boolean;
  loading: boolean;
  failure: CollectionPrivacyFailure | null;
  nativeFailure?: NativePreferenceFailure | undefined;
  restarting?: boolean;
  restartBlocked?: boolean;
};
export type CollectionPrivacyPageRead = (cursor: string | null) => Promise<CollectionPrivacyRead<OwnedCollectionsPage>>;

export class CollectionPrivacyPager extends Observable<PageState> {
  private rows = new Set<() => boolean>();
  private failedRequest: { cursor: string | null; replace: boolean } | null = null;
  private retryWait: { cursor: string | null; deadline: number } | null = null;
  constructor(
    private read: CollectionPrivacyPageRead,
    isCurrent: () => boolean = () => true,
    private now: () => number = Date.now,
  ) {
    super({ collections: [], next: null, window: 0, loaded: false, loading: false, failure: null }, isCurrent);
  }
  retryDeadline = () => {
    const cursor = this.failedRequest ? this.failedRequest.cursor : this.state.next;
    return this.deadlineFor(cursor);
  };
  restartDeadline = () => this.deadlineFor(null);
  private deadlineFor = (cursor: string | null) => (this.retryWait?.cursor === cursor ? this.retryWait.deadline : 0);
  private waitingFor = (cursor: string | null) => this.deadlineFor(cursor) > this.now();
  private retainRetryWait = (cursor: string | null, failure: NativePreferenceFailure | undefined) => {
    const previous = this.retryWait?.cursor === cursor ? this.retryWait.deadline : 0;
    const deadline = Math.max(previous, preferenceRetryDeadline(failure?.retryAfter, this.now()));
    this.retryWait = deadline > this.now() ? { cursor, deadline } : null;
  };
  override dispose = () => {
    this.state = {
      collections: [],
      next: null,
      window: 0,
      loaded: false,
      loading: false,
      failure: null,
      restarting: false,
      restartBlocked: false,
    };
    this.failedRequest = null;
    this.retryWait = null;
    this.rows.clear();
    this.disposed = true;
    this.generation++;
    this.listeners.forEach((listener) => listener());
    this.listeners.clear();
  };
  /** Read-only registration: drafts and immutable commands remain inside their mounted row editors. */
  registerRow = (row: Pick<CollectionPrivacyEditor, 'needsListRestartProtection' | 'subscribe'>) => {
    this.rows.add(row.needsListRestartProtection);
    const refresh = () => {
      const restartBlocked = this.hasUnresolvedRows();
      if (restartBlocked !== !!this.state.restartBlocked) this.update({ restartBlocked });
    };
    const unsubscribe = row.subscribe(refresh);
    refresh();
    return () => {
      unsubscribe();
      this.rows.delete(row.needsListRestartProtection);
      refresh();
    };
  };
  private hasUnresolvedRows = () => [...this.rows].some((needsDecision) => needsDecision());
  retryReplacesRows = () => this.failedRequest !== null && this.state.collections.length > 0;
  retryStartsAtFirstPage = () => this.failedRequest?.cursor === null;
  async load() {
    if (!this.live()) return;
    if (this.state.loaded && this.state.next === null && !this.failedRequest) return;
    await this.requestPage(this.failedRequest ?? { cursor: this.state.next, replace: false });
  }
  async restart() {
    if (!this.live()) return;
    await this.requestPage({ cursor: null, replace: true });
  }
  private async requestPage(request: { cursor: string | null; replace: boolean }) {
    if (!this.live() || this.waitingFor(request.cursor)) return;
    if (this.state.loading || this.hasUnresolvedRows()) return;
    const generation = this.generation;
    this.update({
      loading: true,
      failure: null,
      nativeFailure: undefined,
      ...(request.replace ? { restarting: true } : {}),
    });
    try {
      const read = await this.read(request.cursor);
      if (!this.live() || generation !== this.generation) return;
      if (!read.ok) {
        this.retainRetryWait(request.cursor, read.failure);
        this.failedRequest = isCollectionPrivacyReadRefusal(read.reason) ? null : request;
        this.update(
          isCollectionPrivacyReadRefusal(read.reason)
            ? // An explicit refresh starts at the first native page; denied pages cannot revive cached rows.
              {
                failure: read.reason,
                nativeFailure: read.failure,
                collections: [],
                next: null,
                window: this.state.window + 1,
                loaded: false,
              }
            : { failure: read.reason, nativeFailure: read.failure },
        );
        return;
      }
      // A row can become dirty while the native page read is in flight. Keep its window and retry this cursor.
      if (this.hasUnresolvedRows()) {
        this.failedRequest = request;
        this.retryWait = null;
        return;
      }
      this.failedRequest = null;
      this.retryWait = null;
      // The first occurrence from one native page wins; later duplicate identities are ignored.
      const rows = new Map<string, OwnedCollection>();
      for (const row of read.value.collections.slice(0, 20)) if (!rows.has(row.id)) rows.set(row.id, row);
      this.update({
        collections: [...rows.values()],
        next: read.value.next,
        window: this.state.window + 1,
        loaded: true,
      });
    } catch (error) {
      if (this.live() && generation === this.generation) {
        const nativeFailure = collectionPrivacyFailureMetadata(error);
        this.retainRetryWait(request.cursor, nativeFailure);
        this.failedRequest = request;
        this.update({ failure: 'unavailable', nativeFailure });
      }
    } finally {
      if (this.live() && generation === this.generation)
        this.update({ loading: false, ...(request.replace ? { restarting: false } : {}) });
    }
  }
}
