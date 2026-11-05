export type Coordinate = string | null;
export type Movement = 'next' | 'previous' | 'first';

/** Coordinates only: no predecessor response, Collection or preview survives replacement. */
export class CollectionVisit {
  live = true;
  coordinates: Coordinate[] = [];
  target: { cursor: Coordinate; movement: Movement } | null = null;
  pending = false;
  private cancelHandoff: (() => void) | undefined;
  private handoff: (() => void) | undefined;

  get current(): Coordinate {
    return this.coordinates.at(-1) ?? null;
  }
  get previous(): Coordinate | undefined {
    return this.coordinates.at(-2);
  }

  retire() {
    this.live = false;
    this.coordinates = [];
    this.target = null;
    this.cancelFocus();
  }

  cancelFocus() {
    this.cancelHandoff?.();
    this.cancelHandoff = undefined;
    this.handoff = undefined;
  }

  begin(movement: Movement, cursor: Coordinate, activator: HTMLElement) {
    if (!this.live || this.pending) return false;
    this.cancelFocus();
    this.target = { cursor, movement };
    this.pending = true;
    const document = activator.ownerDocument;
    const cancel = () => this.cancelFocus();
    const focus = (event: FocusEvent) => {
      if (event.target !== activator && event.target !== document.body) cancel();
    };
    document.addEventListener('focusin', focus);
    document.addEventListener('pointerdown', cancel);
    document.addEventListener('keydown', cancel);
    this.cancelHandoff = () => {
      document.removeEventListener('focusin', focus);
      document.removeEventListener('pointerdown', cancel);
      document.removeEventListener('keydown', cancel);
    };
    this.handoff = () => {
      if (document.activeElement !== activator && document.activeElement !== document.body) return;
      document.querySelector<HTMLElement>('[data-slot="account-collections"] h2')?.focus();
    };
    return true;
  }

  receive(cursor: Coordinate, admitted: boolean) {
    if (!this.live) return;
    this.pending = false;
    if (!admitted) {
      this.cancelFocus();
      return;
    }
    const target = this.target;
    if (target && target.cursor === cursor) {
      if (target.movement === 'first') this.coordinates = [null];
      else if (target.movement === 'previous') this.coordinates.pop();
      else this.coordinates = [...this.coordinates, cursor].slice(-9);
      this.target = null;
      const focus = this.handoff;
      this.cancelFocus();
      focus?.();
    } else if (!this.coordinates.length || this.current !== cursor) {
      // A direct address, including browser history, does not invent a predecessor.
      this.coordinates = [cursor];
      this.target = null;
      this.cancelFocus();
    }
  }
}

/** Remove only cursor fields, preserving unrelated query bytes, duplicates and fragment. */
export function collectionWindowHref(search: string, hash: string, cursor: Coordinate): string {
  const raw = search.replace(/^\?/, '');
  const retained = raw ? raw.split('&').filter((part) => !new URLSearchParams(part).has('cursor')) : [];
  if (cursor !== null) retained.push(`cursor=${encodeURIComponent(cursor)}`);
  const query = retained.join('&');
  return `${query ? `?${query}` : '?'}${hash ? `#${hash.replace(/^#/, '')}` : ''}`;
}
