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
type EditorState = {
  current: OwnedCollection;
  desired: CollectionVisibility;
  attempt: VisibilityAttempt | null;
  readRefusal: 'closed' | 'forbidden' | null;
  phase: 'idle' | 'saving' | 'uncertain' | 'conflict' | 'refused' | 'review' | 'reloading' | 'saved';
  failure?: CollectionPrivacyFailure | 'invalid' | undefined;
  nativeFailure?: NativePreferenceFailure | undefined;
};

class Observable<State> {
  protected listeners = new Set<() => void>();
  protected generation = 0;
  constructor(protected state: State) {}
  snapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  dispose = () => {
    this.generation++;
  };
  protected update(patch: Partial<State>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((listener) => listener());
  }
}

/** An unresolved command never becomes the next draft's command. */
export class CollectionPrivacyEditor extends Observable<EditorState> {
  private edits = 0;
  constructor(
    current: OwnedCollection,
    private io: CollectionPrivacyIO,
  ) {
    super({ current, desired: current.visibility, attempt: null, readRefusal: null, phase: 'idle' });
  }
  needsListRestartProtection = () =>
    this.state.attempt !== null ||
    this.state.desired !== this.state.current.visibility ||
    this.state.phase === 'saving' ||
    this.state.phase === 'reloading';
  /** A fresh list may update a clean mounted row, but cannot resolve its command or replace a draft. */
  receive(current: OwnedCollection) {
    if (
      this.needsListRestartProtection() ||
      this.state.readRefusal ||
      current === this.state.current ||
      current.id !== this.state.current.id ||
      current.revision < this.state.current.revision ||
      (current.revision === this.state.current.revision && current.visibility !== this.state.current.visibility)
    )
      return;
    this.update({ current, desired: current.visibility, phase: 'idle' });
  }
  async edit(desired: CollectionVisibility) {
    if (this.state.readRefusal) return;
    this.edits++;
    this.update({ desired });
    if (this.state.phase === 'idle' || this.state.phase === 'saved') await this.submit();
  }
  async submit() {
    if (this.state.readRefusal || this.state.attempt || !['idle', 'saved', 'review'].includes(this.state.phase)) return;
    if (this.state.desired === this.state.current.visibility) return;
    const attempt = Object.freeze({
      collectionId: this.state.current.id,
      revision: this.state.current.revision,
      visibility: this.state.desired,
      idempotencyKey: crypto.randomUUID(),
    });
    this.update({ attempt });
    await this.send(false);
  }
  async retry() {
    if (!this.state.readRefusal && this.state.attempt && this.state.phase === 'uncertain') await this.send(true);
  }
  private async send(recovering: boolean) {
    const attempt = this.state.attempt;
    if (!attempt) return;
    const generation = this.generation;
    this.update({ phase: 'saving', failure: undefined, nativeFailure: undefined });
    try {
      const answer = await this.io.save(attempt);
      if (generation !== this.generation) return;
      if (!answer.ok) {
        this.update(
          answer.reason === 'unavailable' || (recovering && answer.reason !== 'conflict')
            ? // A refused replay cannot establish whether the earlier transport-ambiguous command committed.
              { phase: 'uncertain', failure: answer.reason, nativeFailure: answer.failure }
            : {
                attempt: null,
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
        receipt.revision !== attempt.revision + 1 ||
        receipt.visibility !== attempt.visibility
      ) {
        this.update({ phase: 'uncertain', failure: 'unavailable' });
        return;
      }
      if (!recovering) {
        this.update({
          current: receipt,
          attempt: null,
          phase: this.state.desired === receipt.visibility ? 'saved' : 'review',
        });
        return;
      }
      // A replay receipt is historical. Read current native state without replacing a later draft.
      this.update({ phase: 'reloading', nativeFailure: undefined });
      const read = await this.io.read(attempt.collectionId);
      if (generation !== this.generation) return;
      if (!read.ok) {
        this.update({
          phase: 'uncertain',
          failure: read.reason,
          nativeFailure: read.failure,
          readRefusal: isCollectionPrivacyReadRefusal(read.reason) ? read.reason : this.state.readRefusal,
        });
        return;
      }
      const current = read.value;
      if (
        current.id !== receipt.id ||
        current.revision < receipt.revision ||
        (current.revision === receipt.revision && current.visibility !== receipt.visibility)
      ) {
        this.update({ phase: 'uncertain', failure: 'unavailable' });
        return;
      }
      this.update({ current, attempt: null, phase: 'review', readRefusal: null });
    } catch (error) {
      if (generation === this.generation)
        this.update({
          phase: 'uncertain',
          failure: 'unavailable',
          nativeFailure: collectionPrivacyFailureMetadata(error),
        });
    }
  }
  async reload() {
    if (this.state.phase === 'saving' || this.state.phase === 'reloading') return;
    const generation = this.generation;
    const edits = this.edits;
    const previous = this.state.phase;
    this.update({ phase: 'reloading', nativeFailure: undefined });
    try {
      const read = await this.io.read(this.state.current.id);
      if (generation !== this.generation) return;
      if (!read.ok) {
        this.update({
          phase: previous,
          failure: read.reason,
          nativeFailure: read.failure,
          readRefusal: isCollectionPrivacyReadRefusal(read.reason) ? read.reason : this.state.readRefusal,
        });
        return;
      }
      if (
        read.value.id !== this.state.current.id ||
        read.value.revision < this.state.current.revision ||
        (read.value.revision === this.state.current.revision && read.value.visibility !== this.state.current.visibility)
      )
        throw new Error('Stale Collection read');
      const desired = edits === this.edits ? read.value.visibility : this.state.desired;
      this.update({
        current: read.value,
        desired,
        attempt: null,
        readRefusal: null,
        phase: desired === read.value.visibility ? 'idle' : 'review',
        failure: undefined,
        nativeFailure: undefined,
      });
    } catch (error) {
      if (generation === this.generation)
        this.update({
          phase: previous,
          failure: 'unavailable',
          nativeFailure: collectionPrivacyFailureMetadata(error),
        });
    }
  }
}

type PageState = {
  collections: OwnedCollection[];
  next: string | null;
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
  constructor(private read: CollectionPrivacyPageRead) {
    super({ collections: [], next: null, loaded: false, loading: false, failure: null });
  }
  override dispose = () => {
    this.generation++;
    this.update({ loading: false, ...(this.state.restarting ? { restarting: false } : {}) });
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
  retryReplacesRows = () => this.failedRequest?.replace === true;
  async load() {
    if (this.state.loaded && this.state.next === null && !this.failedRequest) return;
    await this.requestPage(this.failedRequest ?? { cursor: this.state.next, replace: false });
  }
  async restart() {
    await this.requestPage({ cursor: null, replace: true });
  }
  private async requestPage(request: { cursor: string | null; replace: boolean }) {
    if (this.state.loading || (request.replace && this.hasUnresolvedRows())) return;
    const generation = this.generation;
    this.update({
      loading: true,
      failure: null,
      nativeFailure: undefined,
      ...(request.replace ? { restarting: true } : {}),
    });
    try {
      const read = await this.read(request.cursor);
      if (generation !== this.generation) return;
      if (!read.ok) {
        this.failedRequest = isCollectionPrivacyReadRefusal(read.reason) ? null : request;
        this.update(
          isCollectionPrivacyReadRefusal(read.reason)
            ? // An explicit refresh starts at the first native page; denied pages cannot revive cached rows.
              { failure: read.reason, nativeFailure: read.failure, collections: [], next: null, loaded: false }
            : { failure: read.reason, nativeFailure: read.failure },
        );
        return;
      }
      this.failedRequest = null;
      const rows = new Map((request.replace ? [] : this.state.collections).map((row) => [row.id, row]));
      for (const row of read.value.collections) if (!rows.has(row.id)) rows.set(row.id, row);
      this.update({ collections: [...rows.values()], next: read.value.next, loaded: true });
    } catch (error) {
      if (generation === this.generation) {
        this.failedRequest = request;
        this.update({ failure: 'unavailable', nativeFailure: collectionPrivacyFailureMetadata(error) });
      }
    } finally {
      if (generation === this.generation)
        this.update({ loading: false, ...(request.replace ? { restarting: false } : {}) });
    }
  }
}
