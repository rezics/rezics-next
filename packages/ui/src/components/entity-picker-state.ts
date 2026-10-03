export interface EntityPickerItem {
  value: string;
  label: string;
  description?: string;
  disabled?: boolean;
}
export interface EntityPickerPage<T> {
  items: T[];
  nextCursor: string | null;
  complete: boolean;
  /** More matches may appear; refreshing restarts from the current search basis. */
  updating?: boolean;
}
export type EntityPickerLoad<T> = (query: {
  q: string;
  cursor: string | null;
}) => Promise<EntityPickerPage<T>>;
export interface EntityPickerSnapshot<T> extends EntityPickerPage<T> {
  q: string;
  loading: boolean;
  error: boolean;
}

/** Only the current query may publish results. Failed continuations retain their cursor and items. */
export class EntityPickerSource<T extends EntityPickerItem> {
  private generation = 0;
  private listeners = new Set<() => void>();
  private snapshot: EntityPickerSnapshot<T> = {
    q: '',
    items: [],
    nextCursor: null,
    complete: false,
    loading: false,
    error: false,
  };
  constructor(private load: EntityPickerLoad<T>) {}
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish(update: Partial<EntityPickerSnapshot<T>>) {
    this.snapshot = { ...this.snapshot, ...update };
    this.listeners.forEach((listener) => listener());
  }
  search(q: string) {
    this.generation++;
    this.publish({ q, items: [], nextCursor: null, complete: false, updating: false, loading: false, error: false });
    return this.request(false);
  }
  more = () =>
    this.snapshot.loading ||
    this.snapshot.complete ||
    this.snapshot.updating ||
    this.snapshot.error ||
    !this.snapshot.nextCursor
      ? Promise.resolve()
      : this.request(true);
  retry = () =>
    this.snapshot.loading ? Promise.resolve() : this.request(!this.snapshot.updating && this.snapshot.nextCursor !== null);
  cancel = () => {
    this.generation++;
  };
  private async request(append: boolean) {
    const generation = this.generation;
    const { q, nextCursor } = this.snapshot;
    this.publish({ loading: true, error: false });
    try {
      const page = await this.load({ q, cursor: append ? nextCursor : null });
      if (generation !== this.generation) return;
      // An unfinished traversal must provide a progressing cursor, never quietly claim an exact count.
      if (!page.complete && !page.updating && (!page.nextCursor || (append && page.nextCursor === nextCursor)))
        throw new Error('Non-progressing picker page');
      if (page.updating && page.complete) throw new Error('Updating picker page cannot be complete');
      const items = new Map((append ? this.snapshot.items : []).map((item) => [item.value, item]));
      page.items.forEach((item) => items.set(item.value, item));
      this.publish({
        items: [...items.values()],
        nextCursor: page.complete ? null : page.nextCursor,
        complete: page.complete,
        updating: page.updating ?? false,
        loading: false,
      });
    } catch {
      if (generation === this.generation) this.publish({ loading: false, error: true });
    }
  }
}
