/** A local current-visit bookmark; nothing is written to URLs, browser history or storage. */
type Bookmark = {
  window: Window;
  x: number;
  y: number;
  scrollers: { element: HTMLElement; x: number; y: number }[];
  focus: HTMLElement | null;
};

type Pending = { kind: 'jump'; position: number; bookmark: Bookmark | null } | { kind: 'return' };
export type ReadingMove = 'jumped' | 'returned' | 'unavailable' | null;

/** Bounded target lookups and one deferred action, completed only after the responsive modal releases focus. */
export class PostReadingPosition {
  private root: HTMLElement | null = null;
  private controls: HTMLElement | null = null;
  private targets = new Map<number, HTMLHeadingElement>();
  private previous: Bookmark | null = null;
  private opening: Bookmark | null = null;
  private readingFocus: HTMLElement | null = null;
  private pending: Pending | null = null;
  private connected = false;
  private retired = false;
  private guard: () => boolean = () => true;

  setGuard(guard?: () => boolean) {
    this.guard = guard ?? (() => true);
  }
  setRoot(element: HTMLElement | null) {
    this.root = element;
  }
  setControls(element: HTMLElement | null) {
    this.controls = element;
  }
  connect() {
    this.connected = true;
    return () => {
      this.connected = false;
      this.clear();
    };
  }
  retire() {
    this.retired = true;
    this.connected = false;
    this.clear();
    this.root = null;
  }
  private clear() {
    this.targets.clear();
    this.controls = null;
    this.previous = null;
    this.opening = null;
    this.readingFocus = null;
    this.pending = null;
  }
  isCurrent() {
    if (!this.connected || this.retired) return false;
    if (!this.guard()) {
      this.retire();
      return false;
    }
    return !!this.root?.isConnected;
  }
  bind(position: number, element: HTMLHeadingElement | null) {
    if (this.retired) return;
    if (element) this.targets.set(position, element);
    else this.targets.delete(position);
  }
  get targetCount() {
    return this.targets.size;
  }
  get canReturn() {
    return this.isCurrent() && this.previous !== null;
  }
  rememberFocus(element: HTMLElement) {
    if (this.isCurrent() && this.root?.contains(element) && element.closest('[data-slot="document-body"]'))
      this.readingFocus = element;
  }
  private live(element: HTMLElement | null): element is HTMLElement {
    if (!this.isCurrent() || !element?.isConnected || !this.root?.contains(element)) return false;
    // Check only this target's ancestor chain. Never scan the document or reconstruct concealed text.
    for (let parent: HTMLElement | null = element; parent; parent = parent.parentElement) {
      if (
        parent.hidden ||
        parent.inert ||
        parent.getAttribute('aria-hidden') === 'true' ||
        parent.classList.contains('document-spoiler')
      )
        return false;
      const style = parent.ownerDocument.defaultView?.getComputedStyle(parent);
      if (style?.display === 'none' || style?.visibility === 'hidden') return false;
    }
    return true;
  }
  open() {
    if (!this.isCurrent() || !this.root) return false;
    const window = this.root.ownerDocument.defaultView;
    if (!window) return false;
    const scrollers: Bookmark['scrollers'] = [];
    for (let parent = this.root.parentElement; parent; parent = parent.parentElement) {
      const overflow = window.getComputedStyle(parent).overflowY;
      if (/auto|scroll/u.test(overflow)) scrollers.push({ element: parent, x: parent.scrollLeft, y: parent.scrollTop });
    }
    this.opening = { window, x: window.scrollX, y: window.scrollY, scrollers, focus: this.readingFocus };
    this.pending = null;
    return true;
  }
  choose(position: number) {
    if (!this.isCurrent()) return false;
    this.pending = { kind: 'jump', position, bookmark: this.opening };
    return true;
  }
  requestReturn() {
    if (!this.canReturn) return false;
    this.pending = { kind: 'return' };
    return true;
  }
  cancel() {
    this.pending = null;
    this.opening = null;
  }
  private focusReader() {
    if (!this.isCurrent()) return;
    this.root?.focus({ preventScroll: true });
  }
  complete(): ReadingMove {
    const pending = this.pending;
    this.pending = null;
    this.opening = null;
    if (!pending || !this.isCurrent()) return null;
    if (pending.kind === 'jump') {
      const target = this.targets.get(pending.position) ?? null;
      if (!this.live(target)) {
        this.focusReader();
        return 'unavailable';
      }
      this.previous = pending.bookmark;
      // Reserve the existing shell offset plus the local sticky launcher and a wrapping Return row.
      // Measure only this control, at the explicit jump; there is no resize observer or scroll traversal.
      const margin = target.style.scrollMarginBlockStart;
      const height = this.controls?.getBoundingClientRect().height ?? 0;
      target.style.scrollMarginBlockStart = `calc(6rem + ${Math.ceil(height)}px + 4rem)`;
      try {
        target.scrollIntoView({ block: 'start', behavior: 'instant' });
      } finally {
        target.style.scrollMarginBlockStart = margin;
      }
      if (this.live(target)) target.focus({ preventScroll: true });
      return this.isCurrent() ? 'jumped' : null;
    }
    const bookmark = this.previous;
    this.previous = null;
    if (!bookmark) {
      this.focusReader();
      return 'unavailable';
    }
    for (const { element, x, y } of bookmark.scrollers) {
      if (!this.isCurrent()) return null;
      if (element.isConnected) element.scrollTo({ left: x, top: y, behavior: 'instant' });
    }
    if (!this.isCurrent()) return null;
    bookmark.window.scrollTo({ left: bookmark.x, top: bookmark.y, behavior: 'instant' });
    if (this.live(bookmark.focus)) bookmark.focus.focus({ preventScroll: true });
    else this.focusReader();
    return this.isCurrent() ? 'returned' : null;
  }
}
