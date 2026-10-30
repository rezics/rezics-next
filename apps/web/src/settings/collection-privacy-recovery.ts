import type { CollectionVisibility } from '../library/reads';
import type { CollectionVisibilityWrite, OwnedCollection, OwnedCollectionsPage } from './preferences';
import type { CollectionPrivacyFailure, CollectionPrivacyRead } from './collection-privacy-data';

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
  phase: 'idle' | 'saving' | 'uncertain' | 'conflict' | 'refused' | 'review' | 'reloading' | 'saved';
  failure?: CollectionPrivacyFailure | 'invalid' | undefined;
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
    super({ current, desired: current.visibility, attempt: null, phase: 'idle' });
  }
  async edit(desired: CollectionVisibility) {
    this.edits++;
    this.update({ desired });
    if (this.state.phase === 'idle' || this.state.phase === 'saved') await this.submit();
  }
  async submit() {
    if (this.state.attempt || !['idle', 'saved', 'review'].includes(this.state.phase)) return;
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
    if (this.state.attempt && this.state.phase === 'uncertain') await this.send(true);
  }
  private async send(recovering: boolean) {
    const attempt = this.state.attempt;
    if (!attempt) return;
    const generation = this.generation;
    this.update({ phase: 'saving', failure: undefined });
    try {
      const answer = await this.io.save(attempt);
      if (generation !== this.generation) return;
      if (!answer.ok) {
        this.update(
          answer.reason === 'unavailable'
            ? { phase: 'uncertain', failure: 'unavailable' }
            : {
                attempt: null,
                phase: answer.reason === 'conflict' ? 'conflict' : 'refused',
                failure: answer.reason === 'conflict' ? undefined : answer.reason,
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
      this.update({ phase: 'reloading' });
      const read = await this.io.read(attempt.collectionId);
      if (generation !== this.generation) return;
      if (!read.ok) {
        this.update({ phase: 'uncertain', failure: read.reason });
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
      this.update({ current, attempt: null, phase: 'review' });
    } catch {
      if (generation === this.generation) this.update({ phase: 'uncertain', failure: 'unavailable' });
    }
  }
  async reload() {
    if (this.state.phase === 'saving' || this.state.phase === 'reloading') return;
    const generation = this.generation;
    const edits = this.edits;
    const previous = this.state.phase;
    this.update({ phase: 'reloading' });
    try {
      const read = await this.io.read(this.state.current.id);
      if (generation !== this.generation) return;
      if (!read.ok) {
        this.update({ phase: previous, failure: read.reason });
        return;
      }
      if (read.value.id !== this.state.current.id || read.value.revision < this.state.current.revision)
        throw new Error('Stale Collection read');
      const desired = edits === this.edits ? read.value.visibility : this.state.desired;
      this.update({
        current: read.value,
        desired,
        attempt: null,
        phase: desired === read.value.visibility ? 'idle' : 'review',
        failure: undefined,
      });
    } catch {
      if (generation === this.generation) this.update({ phase: previous, failure: 'unavailable' });
    }
  }
}

type PageState = {
  collections: OwnedCollection[];
  next: string | null;
  loaded: boolean;
  loading: boolean;
  failure: CollectionPrivacyFailure | null;
};
export type CollectionPrivacyPageRead = (cursor: string | null) => Promise<CollectionPrivacyRead<OwnedCollectionsPage>>;

export class CollectionPrivacyPager extends Observable<PageState> {
  constructor(private read: CollectionPrivacyPageRead) {
    super({ collections: [], next: null, loaded: false, loading: false, failure: null });
  }
  override dispose = () => {
    this.generation++;
    this.update({ loading: false });
  };
  async load() {
    if (this.state.loading || (this.state.loaded && this.state.next === null)) return;
    const generation = this.generation;
    const cursor = this.state.next;
    this.update({ loading: true, failure: null });
    try {
      const read = await this.read(cursor);
      if (generation !== this.generation) return;
      if (!read.ok) {
        this.update({ failure: read.reason });
        return;
      }
      const rows = new Map(this.state.collections.map((row) => [row.id, row]));
      for (const row of read.value.collections) if (!rows.has(row.id)) rows.set(row.id, row);
      this.update({ collections: [...rows.values()], next: read.value.next, loaded: true });
    } catch {
      if (generation === this.generation) this.update({ failure: 'unavailable' });
    } finally {
      if (generation === this.generation) this.update({ loading: false });
    }
  }
}
