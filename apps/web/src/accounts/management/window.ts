import type { Cursors } from './data';

export type Feed = keyof Cursors;
export type Movement = 'next' | 'previous' | 'first';
type Coordinate = string | undefined;
const feeds: Feed[] = ['organizationsCursor', 'operatorsCursor', 'membersCursor'];

/** A mounted visit owns coordinates only. Native replacements remain the sole source of rows. */
export class ManagementWindow {
  private prior: Record<Feed, Coordinate[]> = { organizationsCursor: [], operatorsCursor: [], membersCursor: [] };
  private current: Cursors;
  private pending?: { field: Feed; movement: Movement; target: Cursors };
  private retired = false;

  constructor(cursors: Cursors) {
    this.current = { ...cursors };
  }

  previous(field: Feed): { cursor: Coordinate } | undefined {
    const prior = this.prior[field];
    return !this.retired && prior.length ? { cursor: prior.at(-1) } : undefined;
  }

  request(field: Feed, cursor: Coordinate, movement: Movement, address: Cursors): Cursors {
    const target = { ...address };
    if (cursor === undefined) delete target[field];
    else target[field] = cursor;
    this.pending = { field, movement, target };
    return target;
  }

  pendingField(): Feed | undefined {
    return this.pending?.field;
  }

  /** Failure and refresh do not alter the last admitted history or the pending exact target. */
  admit(cursors: Cursors, admitted: (field: Feed) => boolean): void {
    if (this.retired) return;
    const pending = this.pending;
    if (pending && feeds.every((field) => cursors[field] === pending.target[field])) {
      const { field, movement } = pending;
      if (!admitted(field)) return;
      if (movement === 'first') this.prior[field] = [];
      else if (movement === 'previous') this.prior[field].pop();
      else if (this.current[field] !== cursors[field]) {
        this.prior[field].push(this.current[field]);
        this.prior[field] = this.prior[field].slice(-8);
      }
      this.current = { ...cursors };
      this.pending = undefined;
    } else if (!pending) {
      // A browser history/direct address is readable, but supplies no invented predecessor.
      for (const field of feeds) {
        if (this.current[field] !== cursors[field]) this.prior[field] = [];
      }
      this.current = { ...cursors };
    }
  }

  retire(): void {
    this.retired = true;
    this.current = {};
    this.pending = undefined;
    for (const field of feeds) this.prior[field] = [];
  }
}
