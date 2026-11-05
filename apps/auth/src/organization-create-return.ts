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
  dismissed: boolean;
};

export type OrganizationCreateReturnEvent =
  | { type: 'dismiss' }
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
  dismissed: false,
};

/** Keep only generic outcome history; private operands remain with the admitted operation descriptor. */
export function transitionOrganizationCreateReturn(
  state: OrganizationCreateReturnState,
  event: OrganizationCreateReturnEvent,
): OrganizationCreateReturnState {
  switch (event.type) {
    case 'dismiss':
      return { ...state, dismissed: true };
    case 'begin':
      return { ...state, phase: 'preflight' };
    case 'approval':
      return {
        ...state,
        phase: 'approval',
        history: event.settled ? (event.priorUncertainty ? 'unconfirmed' : 'none') : 'unconfirmed',
      };
    case 'execution':
      return { ...state, phase: 'execution', history: 'unconfirmed' };
    case 'acknowledged':
      return { ...state, phase: 'acknowledged', history: 'acknowledged', dismissed: false };
    case 'refused':
      return event.priorUncertainty
        ? { ...state, phase: 'unknown', history: 'unconfirmed' }
        : { ...state, phase: 'refused', history: 'none' };
    case 'unknown':
      return { ...state, phase: 'unknown', history: 'unconfirmed' };
    case 'unavailable':
      return { ...state, phase: 'unavailable', history: state.history };
    case 'read-unavailable':
      return { ...state, phase: 'unavailable', history: state.history };
    case 'return':
      if (state.history === 'unconfirmed') return { ...state, phase: 'unknown', history: state.history };
      if (state.history === 'acknowledged') return { ...state, phase: 'acknowledged', history: state.history };
      return { ...state, phase: state.phase === 'approval' ? 'approval' : 'review', history: 'none' };
    case 'unresumable':
      return { ...state, phase: 'unresumable', history: state.history };
  }
}
