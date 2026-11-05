import type { CopiesAddress } from '../copies-query';
import type { CopiesPageData } from '../copies-read';

export type CopiesWindowMove = 'previous' | 'first' | 'more';

export type CopiesWindowsState = {
  base: string;
  routeCursor: string | null;
  current: string | null | undefined;
  predecessors: (string | null)[];
  reader: string;
  viewer: number;
  pending: {
    move: CopiesWindowMove;
    target: string | null;
    fromRouteCursor: string | null;
    from: string | null;
    sourceReader: string;
    destinationReader?: string;
    focus: boolean;
  } | null;
};

function base(address: CopiesAddress) {
  return JSON.stringify([address.subjectId, address.kind, address.status, address.locale, address.issue ?? null]);
}

function blank(address: CopiesAddress, reader: string, viewer: number): CopiesWindowsState {
  return {
    base: base(address),
    routeCursor: address.cursor,
    current: undefined,
    predecessors: [],
    reader,
    viewer,
    pending: null,
  };
}

function sameBlank(state: CopiesWindowsState, address: CopiesAddress, reader: string, viewer: number) {
  return (
    state.base === base(address) &&
    state.routeCursor === address.cursor &&
    state.current === undefined &&
    state.predecessors.length === 0 &&
    state.reader === reader &&
    state.viewer === viewer &&
    state.pending === null
  );
}

export function createCopiesWindows(address: CopiesAddress, reader: string, viewer: number) {
  return blank(address, reader, viewer);
}

/** Only an explicitly staged cursor transition can carry this path to another reader lifetime. */
export function reconcileCopiesWindows(
  state: CopiesWindowsState,
  address: CopiesAddress,
  reader: string,
  viewer: number,
  active: boolean,
): CopiesWindowsState {
  const nextBase = base(address);
  if (!active || state.base !== nextBase || state.viewer !== viewer) {
    return sameBlank(state, address, reader, viewer) ? state : blank(address, reader, viewer);
  }
  if (state.pending) {
    const pending = state.pending;
    if (
      address.cursor === pending.target &&
      state.routeCursor === pending.fromRouteCursor &&
      state.reader === pending.sourceReader
    ) {
      return {
        ...state,
        routeCursor: address.cursor,
        pending: { ...pending, destinationReader: reader },
      };
    }
    if (
      address.cursor === state.routeCursor &&
      reader === (pending.destinationReader ?? state.reader) &&
      (pending.destinationReader === undefined || pending.target === address.cursor)
    )
      return state;
    return sameBlank(state, address, reader, viewer) ? state : blank(address, reader, viewer);
  }
  if (address.cursor !== state.routeCursor || reader !== state.reader)
    return sameBlank(state, address, reader, viewer) ? state : blank(address, reader, viewer);
  return state;
}

export function stageCopiesWindowMove(
  state: CopiesWindowsState,
  address: CopiesAddress,
  move: CopiesWindowMove,
  target: string | null,
  focus: boolean,
): CopiesWindowsState {
  if (state.current === undefined || state.base !== base(address) || address.issue) return state;
  if (move === 'previous' && state.predecessors.at(-1) !== target) return state;
  if (move === 'first' && (target !== null || state.current === null)) return state;
  if (move === 'more' && (typeof target !== 'string' || !target)) return state;
  if (target === address.cursor) return state;
  return {
    ...state,
    pending: {
      move,
      target,
      fromRouteCursor: state.routeCursor,
      from: state.current,
      sourceReader: state.reader,
      focus,
    },
  };
}

function pushPredecessor(predecessors: (string | null)[], cursor: string | null) {
  const result = [...predecessors, cursor];
  while (result.filter((value) => value !== null).length > 8) result.shift();
  return result;
}

export function admitCopiesWindowRead(
  state: CopiesWindowsState,
  address: CopiesAddress,
  reader: string,
  viewer: number,
  page: CopiesPageData,
): { state: CopiesWindowsState; focus: boolean } {
  if (
    page.signedIn !== true ||
    page.inventoryState === 'forbidden' ||
    page.inventoryState === 'unavailable' ||
    state.base !== base(address) ||
    state.routeCursor !== address.cursor
  ) {
    return { state: blank(address, reader, viewer), focus: false };
  }

  if (page.cursorRestarted) {
    return { state: { ...blank(address, reader, viewer), current: null }, focus: false };
  }

  const pending = state.pending;
  if (
    pending &&
    pending.target === address.cursor &&
    pending.destinationReader === reader &&
    pending.sourceReader === state.reader &&
    pending.from === state.current
  ) {
    let predecessors = state.predecessors;
    if (pending.move === 'previous') predecessors = predecessors.slice(0, -1);
    else if (pending.move === 'first') predecessors = [];
    else predecessors = pushPredecessor(predecessors, pending.from);
    return {
      state: {
        ...state,
        routeCursor: address.cursor,
        current: address.cursor,
        predecessors,
        reader,
        pending: null,
      },
      focus: pending.focus,
    };
  }

  if (state.current !== undefined && state.reader === reader && !pending) return { state, focus: false };

  return {
    state: { ...blank(address, reader, viewer), current: address.cursor },
    focus: false,
  };
}
