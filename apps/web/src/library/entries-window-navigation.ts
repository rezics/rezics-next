import type { PersonalLibraryAddress } from './personal-library-server';

type Cursor = string | null;
type Movement = { cursor: Cursor; kind: 'next' | 'previous' | 'first'; focus: boolean };
export function entriesWindowSource({ cursor: _, ...source }: PersonalLibraryAddress) {
  return JSON.stringify(source);
}

/** Coordinates only. The current reader remains the sole page and admission owner. */
export class EntriesWindowNavigation {
  private client: object | undefined;
  private identity = '';
  private source = '';
  private predecessors: Cursor[] = [];
  private current: Cursor = null;
  private admitted = false;
  pending: Movement | undefined;
  private focusTarget: Cursor | undefined;

  attach(client: object) {
    if (this.client !== client) this.leave();
    this.client = client;
  }
  leave() {
    this.identity = '';
    this.source = '';
    this.predecessors = [];
    this.current = null;
    this.admitted = false;
    this.pending = undefined;
    this.focusTarget = undefined;
  }
  bind(identity: string, address: PersonalLibraryAddress) {
    const source = entriesWindowSource(address);
    if (identity !== this.identity || source !== this.source) {
      this.leave();
      this.identity = identity;
      this.source = source;
    }
  }
  get previous(): Cursor | undefined {
    return this.predecessors.at(-1);
  }
  stage(kind: Movement['kind'], cursor: Cursor, focus: boolean) {
    if (this.pending) return false;
    this.pending = { kind, cursor, focus };
    return true;
  }
  cancelFocus() {
    this.focusTarget = undefined;
    if (this.pending) this.pending.focus = false;
  }
  failed() {
    this.cancelFocus();
  }
  admit(cursor: Cursor, reset: boolean) {
    const target = reset ? null : cursor;
    const pending = this.pending;
    if (reset) {
      this.predecessors = [];
      this.pending = undefined;
    } else if (pending?.cursor === cursor) {
      if (pending.kind === 'next' && this.admitted) this.predecessors = [...this.predecessors, this.current].slice(-8);
      if (pending.kind === 'previous') this.predecessors.pop();
      if (pending.kind === 'first') this.predecessors = [];
      this.focusTarget = pending.focus ? target : undefined;
      this.pending = undefined;
    } else if (!this.admitted || this.current !== target) {
      // Fresh addresses and browser history never invent predecessors.
      this.predecessors = [];
      this.pending = undefined;
      this.focusTarget = undefined;
    }
    this.current = target;
    this.admitted = true;
  }
  takeFocus(cursor: Cursor) {
    const focus = this.focusTarget === cursor;
    this.focusTarget = undefined;
    return focus;
  }
}

export type EntriesWindowControls = {
  href: (cursor: Cursor) => string;
  previous: Cursor | undefined;
  first: boolean;
  busy: boolean;
  move: (kind: Movement['kind'], cursor: Cursor, keyboard: boolean) => void;
};

/** Edit only the cursor bytes; unknown query parameters and the hash keep their address meaning. */
export function entriesWindowHref(href: string, cursor: Cursor) {
  const hashAt = href.indexOf('#');
  const hash = hashAt < 0 ? '' : href.slice(hashAt);
  const address = hashAt < 0 ? href : href.slice(0, hashAt);
  const queryAt = address.indexOf('?');
  const path = queryAt < 0 ? address : address.slice(0, queryAt);
  const parts =
    queryAt < 0
      ? []
      : address
          .slice(queryAt + 1)
          .split('&')
          .filter((part) => !new URLSearchParams(part).has('cursor'));
  if (cursor !== null) parts.push(`cursor=${encodeURIComponent(cursor)}`);
  return path + (parts.length ? `?${parts.join('&')}` : '') + hash;
}
