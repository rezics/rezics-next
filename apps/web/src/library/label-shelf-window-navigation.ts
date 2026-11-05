export type LabelShelfWindowMove = 'next' | 'previous' | 'first' | 'retry';

export type LabelShelfWindowState = {
  predecessors: (string | null)[];
  current: string | null;
  pending: { move: LabelShelfWindowMove; target: string | null } | null;
};

export const labelShelfWindowLimit = 8;

export function emptyLabelShelfWindow(): LabelShelfWindowState {
  return { predecessors: [], current: null, pending: null };
}

export function stageLabelShelfWindow(
  state: LabelShelfWindowState,
  move: LabelShelfWindowMove,
  target: string | null,
): LabelShelfWindowState {
  if (move === 'retry' && state.pending?.target === target) return state;
  return { ...state, pending: { move, target } };
}

/** Admit a route coordinate only after its exact native window has loaded. */
export function admitLabelShelfWindow(state: LabelShelfWindowState, target: string | null): LabelShelfWindowState {
  const pending = state.pending;
  if (pending?.target === target) {
    if (pending.move === 'next')
      return {
        predecessors: [...state.predecessors, state.current].slice(-labelShelfWindowLimit),
        current: target,
        pending: null,
      };
    if (pending.move === 'previous') {
      if (target === state.current) return { ...state, pending: null };
      return { predecessors: state.predecessors.slice(0, -1), current: target, pending: null };
    }
    if (pending.move === 'first') return emptyLabelShelfWindow();
    return { ...state, current: target, pending: null };
  }
  if (state.current === target && pending === null) return state;
  // An un-staged address change (for example browser Back or direct entry) has no invented predecessors.
  return { predecessors: [], current: target, pending: null };
}

export function previousLabelShelfWindow(state: LabelShelfWindowState): string | null | undefined {
  if (state.pending?.move === 'next') return state.current;
  if (state.pending?.move === 'previous') return state.predecessors.at(-2);
  return state.predecessors.at(-1);
}

export function hasPreviousLabelShelfWindow(state: LabelShelfWindowState): boolean {
  if (state.pending?.move === 'next') return true;
  if (state.pending?.move === 'previous') return state.predecessors.length > 1;
  return state.predecessors.length > 0;
}
