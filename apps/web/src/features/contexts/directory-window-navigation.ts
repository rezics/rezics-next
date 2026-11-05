/** Coordinates only; page payloads and private authority belong to ContextVisit. */
type Cursor = string | undefined;
type Movement = { cursor: Cursor; direction: 'next' | 'previous' | 'first' };
export class DirectoryWindowNavigation {
  private predecessors: Cursor[] = [];
  private current: Cursor;
  private admitted = false;
  target: Movement | undefined;
  private focus: HTMLElement | undefined;
  private stopFocus: (() => void) | undefined;
  private committedFocus = false;
  private armed = false;

  get previous(): { cursor: Cursor } | undefined {
    return this.predecessors.length ? { cursor: this.predecessors.at(-1) } : undefined;
  }

  stage(direction: Movement['direction'], cursor: Cursor, keyboardOrigin?: HTMLElement) {
    this.cancelFocus();
    this.target = { direction, cursor };
    this.armed = true;
    if (keyboardOrigin) {
      this.focus = keyboardOrigin;
      const moved = (event: FocusEvent) => {
        if (event.target !== keyboardOrigin) this.cancelFocus();
      };
      document.addEventListener('focusin', moved);
      this.stopFocus = () => document.removeEventListener('focusin', moved);
    }
  }

  request(cursor: Cursor, addressChanged = false) {
    // A browser address change replaces a pending target; a reread of that target does not arm it.
    if (addressChanged && this.target && cursor !== this.target.cursor) {
      this.target = undefined;
      this.armed = false;
      this.cancelFocus();
    }
    return this.armed && this.target?.cursor === cursor ? this.target : undefined;
  }
  retry(cursor: Cursor, keyboardOrigin?: HTMLElement) {
    if (this.target && this.target.cursor === cursor) this.stage(this.target.direction, cursor, keyboardOrigin);
  }

  /** Called only by the exact successful, still-current native read. */
  accept(cursor: Cursor, movement: Movement | undefined) {
    if (movement !== this.target || (movement && cursor !== movement.cursor)) return;
    if (movement) {
      if (movement.direction === 'next' && this.admitted)
        this.predecessors = [...this.predecessors, this.current].slice(-8);
      if (movement.direction === 'previous') this.predecessors.pop();
      if (movement.direction === 'first') this.predecessors = [];
      this.committedFocus = !!this.focus;
      this.target = undefined;
      this.armed = false;
    } else if (cursor !== this.current) {
      // Browser Back/Forward and direct addresses do not invent a traversal.
      this.predecessors = [];
      this.cancelFocus();
    }
    this.current = cursor;
    this.admitted = true;
  }

  failed() {
    this.armed = false;
    this.cancelFocus();
  }
  handoff(heading: HTMLElement) {
    if (!this.committedFocus) return;
    const eligible = document.activeElement === this.focus || document.activeElement === document.body;
    this.cancelFocus();
    if (eligible) heading.focus();
  }
  cancelFocus() {
    this.stopFocus?.();
    this.stopFocus = undefined;
    this.focus = undefined;
    this.committedFocus = false;
  }
  dispose() {
    this.cancelFocus();
    this.predecessors = [];
    this.current = undefined;
    this.admitted = false;
    this.target = undefined;
    this.armed = false;
  }
}
