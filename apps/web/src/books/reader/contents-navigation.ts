import type { BookContentsAddress } from './source';

export const BOOK_CONTENTS_PREDECESSORS = 8;

/** Only public contents operands. Publication/viewer/locale lifetime belongs to the host. */
export type BookContentsCoordinate = Readonly<{
  parentOccurrenceId: string | null;
  cursor: string | null;
}>;
export type BookContentsMovement = 'exact' | 'level' | 'first';
export type BookContentsWindow = Readonly<{
  predecessors: readonly BookContentsCoordinate[];
  current: BookContentsCoordinate | null;
  staged: BookContentsCoordinate | null;
}>;

const coordinate = (address: BookContentsCoordinate): BookContentsCoordinate => ({
  parentOccurrenceId: address.parentOccurrenceId,
  cursor: address.cursor,
});
const same = (a: BookContentsCoordinate, b: BookContentsCoordinate) =>
  a.parentOccurrenceId === b.parentOccurrenceId && a.cursor === b.cursor;

/** Eight observed predecessors plus current/staged operands; never a page or a cursor generated from order. */
export function createBookContentsNavigation() {
  let window: BookContentsWindow = { predecessors: [], current: null, staged: null };
  let first = false;
  let generation = 0;
  const latest = (parentOccurrenceId: string | null) =>
    [window.current, ...[...window.predecessors].reverse()].find(
      (value) => value && value.parentOccurrenceId === parentOccurrenceId,
    );
  return {
    getSnapshot: () => window,
    generation: () => generation,
    retire() {
      generation += 1;
      first = false;
      window = { predecessors: [], current: null, staged: null };
    },
    resolve(address: BookContentsAddress, movement: BookContentsMovement): BookContentsAddress {
      const observed = movement === 'level' && address.cursor === null ? latest(address.parentOccurrenceId) : null;
      return observed ? { ...address, cursor: observed.cursor } : address;
    },
    stage(address: BookContentsCoordinate, movement: BookContentsMovement = 'exact') {
      first = movement === 'first';
      window = { ...window, staged: coordinate(address) };
    },
    observe(address: BookContentsAddress) {
      const target = coordinate(address);
      // An initial/direct observation has no predecessor. A failed target never calls this method.
      if (window.current && !same(window.current, target)) {
        const index = window.predecessors.findLastIndex((value) => same(value, target));
        const restarting = first && window.staged && same(window.staged, target);
        const predecessors = restarting
          ? window.predecessors.filter((value) => value.parentOccurrenceId !== target.parentOccurrenceId)
          : index >= 0
            ? window.predecessors.slice(0, index)
            : [...window.predecessors, window.current];
        window = { predecessors: predecessors.slice(-BOOK_CONTENTS_PREDECESSORS), current: target, staged: null };
      } else window = { ...window, current: target, staged: null };
      first = false;
    },
    previous(address: BookContentsAddress): BookContentsAddress | null {
      // A different parent can be an observed return location, but never this level's Previous page.
      const index = window.predecessors.findLastIndex((value) => same(value, address));
      const candidates = index >= 0 ? window.predecessors.slice(0, index) : window.predecessors;
      const previous = candidates.findLast((value) => value.parentOccurrenceId === address.parentOccurrenceId);
      return previous ? { ...address, ...previous } : null;
    },
  };
}
export type BookContentsNavigation = ReturnType<typeof createBookContentsNavigation>;
