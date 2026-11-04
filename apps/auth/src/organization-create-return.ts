export type OrganizationCreateHistory = 'none' | 'unconfirmed' | 'acknowledged';

export type OrganizationCreatePhase =
  | 'review'
  | 'preflight'
  | 'approval'
  | 'execution'
  | 'unknown'
  | 'unavailable'
  | 'refused'
  | 'acknowledged'
  | 'unresumable';

export type OrganizationCreateReturnState = {
  phase: OrganizationCreatePhase;
  history: OrganizationCreateHistory;
};

export type OrganizationCreateReturnEvent =
  | { type: 'begin' }
  | { type: 'approval'; priorUncertainty: boolean; settled?: boolean }
  | { type: 'execution' }
  | { type: 'acknowledged' }
  | { type: 'refused'; priorUncertainty: boolean }
  | { type: 'unknown' }
  | { type: 'unavailable' }
  | { type: 'read-unavailable' }
  | { type: 'return' }
  | { type: 'unresumable' };

export const initialOrganizationCreateReturn: OrganizationCreateReturnState = {
  phase: 'review',
  history: 'none',
};

/** Keep only generic outcome history; private operands remain with the admitted operation descriptor. */
export function transitionOrganizationCreateReturn(
  state: OrganizationCreateReturnState,
  event: OrganizationCreateReturnEvent,
): OrganizationCreateReturnState {
  switch (event.type) {
    case 'begin':
      return { ...state, phase: 'preflight' };
    case 'approval':
      return {
        phase: 'approval',
        history: event.settled ? (event.priorUncertainty ? 'unconfirmed' : 'none') : 'unconfirmed',
      };
    case 'execution':
      return { phase: 'execution', history: 'unconfirmed' };
    case 'acknowledged':
      return { phase: 'acknowledged', history: 'acknowledged' };
    case 'refused':
      return event.priorUncertainty
        ? { phase: 'unknown', history: 'unconfirmed' }
        : { phase: 'refused', history: 'none' };
    case 'unknown':
      return { phase: 'unknown', history: 'unconfirmed' };
    case 'unavailable':
      return { phase: 'unavailable', history: state.history };
    case 'read-unavailable':
      return { phase: 'unavailable', history: state.history };
    case 'return':
      if (state.history === 'unconfirmed') return { phase: 'unknown', history: state.history };
      if (state.history === 'acknowledged') return { phase: 'acknowledged', history: state.history };
      return { phase: state.phase === 'approval' ? 'approval' : 'review', history: 'none' };
    case 'unresumable':
      return { phase: 'unresumable', history: state.history };
  }
}
