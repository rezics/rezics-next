export type MineCollectionsCoordinate = string | null;
export type MineCollectionsWindowAction = 'next' | 'previous' | 'first';
export type MineCollectionsLayout = 'rows' | 'previews';

export type MineCollectionsMovement = {
  action: MineCollectionsWindowAction;
  source: MineCollectionsCoordinate;
  target: MineCollectionsCoordinate;
  failed: boolean;
};

export type MineCollectionsWindowsSnapshot = {
  /** Cursor-only history. This contains no Collection payloads or predicates. */
  coordinates: readonly MineCollectionsCoordinate[];
  current: MineCollectionsCoordinate | null;
  movement: MineCollectionsMovement | null;
  cursorReset: boolean;
  focusReady: boolean;
  revision: number;
};

type LayoutTransition = { cursor: MineCollectionsCoordinate; layout: MineCollectionsLayout };

const emptySnapshot: MineCollectionsWindowsSnapshot = {
  coordinates: [],
  current: null,
  movement: null,
  cursorReset: false,
  focusReady: false,
  revision: 0,
};
const sameCursor = (left: MineCollectionsCoordinate, right: MineCollectionsCoordinate) => left === right;

/** One mounted route visit retains admitted cursor coordinates only. */
export class MineCollectionsWindowsVisit {
  private snapshot = emptySnapshot;
  private readonly listeners = new Set<() => void>();
  private authorityKey: string | null = null;
  private observedCursor: MineCollectionsCoordinate | undefined;
  private observedLayout: MineCollectionsLayout | undefined;
  private locationKey: string | undefined;
  private layoutTransition: LayoutTransition | undefined;
  private focusSource: HTMLElement | undefined;
  private focusListener: ((event: FocusEvent) => void) | undefined;
  private mounts = 0;
  private disposalGeneration = 0;
  private disposed = false;

  getSnapshot = () => this.snapshot;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Defers disposal by one microtask so React's Strict Mode effect replay can reattach. */
  attach = () => {
    if (this.disposed) return () => {};
    this.mounts++;
    this.disposalGeneration++;
    return () => {
      this.mounts--;
      const generation = ++this.disposalGeneration;
      queueMicrotask(() => {
        if (this.mounts === 0 && this.disposalGeneration === generation) this.dispose();
      });
    };
  };

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.authorityKey = null;
    this.layoutTransition = undefined;
    this.cancelFocus();
    this.snapshot = { ...emptySnapshot, revision: this.snapshot.revision + 1 };
    this.listeners.clear();
  }

  /** A different address entry starts fresh unless this visit initiated its exact transition. */
  observe(
    authorityKey: string | null,
    cursor: MineCollectionsCoordinate,
    layout: MineCollectionsLayout,
    locationKey?: string,
  ) {
    if (this.disposed) return;
    if (!authorityKey) {
      if (this.authorityKey !== null || this.snapshot.coordinates.length || this.snapshot.movement) {
        this.authorityKey = null;
        this.observedCursor = cursor;
        this.observedLayout = layout;
        this.locationKey = locationKey;
        this.layoutTransition = undefined;
        this.cancelFocus();
        this.replace({ ...emptySnapshot, revision: this.snapshot.revision });
      } else {
        this.observedCursor = cursor;
        this.observedLayout = layout;
        this.locationKey = locationKey;
      }
      return;
    }

    if (this.authorityKey !== authorityKey) {
      this.authorityKey = authorityKey;
      this.observedCursor = cursor;
      this.observedLayout = layout;
      this.locationKey = locationKey;
      this.layoutTransition = undefined;
      this.cancelFocus();
      this.replace({ ...emptySnapshot, revision: this.snapshot.revision });
      return;
    }

    const movedLocation = this.locationKey !== undefined && locationKey !== undefined && this.locationKey !== locationKey;
    const expectedMovement = this.snapshot.movement?.target === cursor;
    const expectedLayout =
      this.layoutTransition?.cursor === cursor && this.layoutTransition.layout === layout;
    const unexpectedAddress =
      (movedLocation && !expectedMovement && !expectedLayout) ||
      (!sameCursor(this.observedCursor ?? null, cursor) && !expectedMovement && !expectedLayout) ||
      (this.observedLayout !== undefined && this.observedLayout !== layout && !expectedLayout);

    if (unexpectedAddress) {
      this.layoutTransition = undefined;
      this.cancelFocus();
      this.replace({ ...emptySnapshot, revision: this.snapshot.revision });
    } else if (expectedLayout && (movedLocation || this.observedLayout !== layout)) {
      this.layoutTransition = undefined;
    }

    this.observedCursor = cursor;
    this.observedLayout = layout;
    this.locationKey = locationKey;
  }

  beginMovement(
    authorityKey: string,
    action: MineCollectionsWindowAction,
    source: MineCollectionsCoordinate,
    target: MineCollectionsCoordinate,
    focusSource?: HTMLElement,
  ): boolean {
    if (this.disposed) return false;
    if (
      this.authorityKey !== authorityKey ||
      this.snapshot.current !== source ||
      !sameCursor(this.snapshot.coordinates.at(-1) ?? null, source)
    )
      return false;
    if (
      action === 'previous' &&
      (this.snapshot.coordinates.length < 2 || this.snapshot.coordinates.at(-2) !== target)
    )
      return false;
    if (action === 'first' && (source === null || target !== null)) return false;

    this.layoutTransition = undefined;
    this.armFocus(focusSource);
    this.replace({
      ...this.snapshot,
      movement: { action, source, target, failed: false },
      focusReady: false,
    });
    return true;
  }

  beginLayoutChange(
    authorityKey: string,
    cursor: MineCollectionsCoordinate,
    layout: MineCollectionsLayout,
  ): boolean {
    if (this.disposed) return false;
    if (
      this.authorityKey !== authorityKey ||
      this.snapshot.current !== cursor ||
      !sameCursor(this.snapshot.coordinates.at(-1) ?? null, cursor)
    )
      return false;
    this.cancelFocus();
    this.layoutTransition = { cursor, layout };
    this.replace({ ...this.snapshot, focusReady: false });
    return true;
  }

  /** Retries the same pending target while preserving the last admitted stack. */
  retryMovement(authorityKey: string, cursor: MineCollectionsCoordinate, focusSource?: HTMLElement): boolean {
    if (this.disposed) return false;
    const movement = this.snapshot.movement;
    if (
      this.authorityKey !== authorityKey ||
      !movement?.failed ||
      movement.target !== cursor
    )
      return false;
    this.armFocus(focusSource);
    this.replace({ ...this.snapshot, movement: { ...movement, failed: false }, focusReady: false });
    return true;
  }

  failMovement(authorityKey: string, cursor: MineCollectionsCoordinate) {
    if (this.disposed) return;
    const movement = this.snapshot.movement;
    if (this.authorityKey !== authorityKey || !movement || movement.target !== cursor) return;
    this.cancelFocus();
    this.replace({ ...this.snapshot, movement: { ...movement, failed: true }, focusReady: false });
  }

  cancelMovementFocus(authorityKey: string) {
    if (this.disposed) return;
    if (this.authorityKey !== authorityKey || (!this.focusListener && !this.snapshot.focusReady)) return;
    this.cancelFocus();
    this.replace({ ...this.snapshot, focusReady: false });
  }

  /** Called only by the current admitted reader after its envelope matches subject and address. */
  accept(authorityKey: string, requested: MineCollectionsCoordinate, cursorReset = false) {
    if (this.disposed) return;
    if (this.authorityKey !== authorityKey) return;

    if (cursorReset) {
      this.cancelFocus();
      this.layoutTransition = undefined;
      this.replace({
        ...this.snapshot,
        coordinates: [null],
        current: null,
        movement: null,
        cursorReset: true,
        focusReady: false,
      });
      return;
    }

    const movement = this.snapshot.movement;
    let coordinates = this.snapshot.coordinates;
    let moved = false;
    if (movement && movement.target === requested) {
      if (movement.action === 'next') coordinates = [...coordinates, requested].slice(-9);
      else if (movement.action === 'previous') coordinates = coordinates.slice(0, -1);
      else coordinates = [null];
      moved = true;
    } else if (!coordinates.length || this.snapshot.current !== requested) {
      coordinates = [requested];
    }

    const focusReady = moved && !!this.focusListener;
    if (movement?.target === requested) this.replace({
      ...this.snapshot,
      coordinates,
      current: requested,
      movement: null,
      cursorReset: moved ? false : this.snapshot.cursorReset,
      focusReady,
    });
    else {
      this.cancelFocus();
      this.replace({
        ...this.snapshot,
        coordinates,
        current: requested,
        movement: null,
        cursorReset: this.snapshot.cursorReset,
        focusReady: false,
      });
    }
    this.layoutTransition = undefined;
  }

  consumeFocus(authorityKey: string): boolean {
    if (this.disposed) return false;
    if (this.authorityKey !== authorityKey || !this.snapshot.focusReady) return false;
    this.cancelFocus();
    this.replace({ ...this.snapshot, focusReady: false });
    return true;
  }

  private armFocus(source?: HTMLElement) {
    this.cancelFocus();
    if (typeof document === 'undefined' || !source || document.activeElement !== source) return;
    this.focusSource = source;
    this.focusListener = (event) => {
      if (
        event.target === this.focusSource ||
        event.target === document.body ||
        event.target === document.documentElement
      )
        return;
      this.cancelFocus();
      this.replace({ ...this.snapshot, focusReady: false });
    };
    document.addEventListener('focusin', this.focusListener, true);
  }

  private cancelFocus() {
    if (this.focusListener && typeof document !== 'undefined')
      document.removeEventListener('focusin', this.focusListener, true);
    this.focusListener = undefined;
    this.focusSource = undefined;
  }

  private replace(next: Omit<MineCollectionsWindowsSnapshot, 'revision'> & { revision?: number }) {
    this.snapshot = { ...next, revision: this.snapshot.revision + 1 };
    for (const listener of [...this.listeners]) listener();
  }
}
