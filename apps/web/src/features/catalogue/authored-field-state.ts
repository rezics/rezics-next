import { fromPlainText, type DocumentSnapshot } from '@rezics/document';
import type { CandidateFailure } from '../../subject/candidates';
import type { ProposalResult } from './statement-editor';
import type { AuthoredCommand, AuthoredRead } from './authored-field';

export type AuthoredDraft = {
  document: DocumentSnapshot;
  language: string;
  licence: string;
  citation: string;
  original: boolean;
};
type AuthoredState = {
  drafts: Record<string, AuthoredDraft>;
  command: AuthoredCommand | null;
  proposed?: Extract<ProposalResult, { ok: true }> | undefined;
  failure?: CandidateFailure['reason'] | undefined;
};
type Action =
  | { type: 'edit'; property: string; change: Partial<AuthoredDraft> }
  | { type: 'discard'; property: string }
  | { type: 'submit'; command: AuthoredCommand }
  | { type: 'result'; result: ProposalResult }
  | { type: 'read'; read: AuthoredRead; reviewDraft: boolean }
  | { type: 'denied' };

const blank = (): AuthoredDraft => ({
  document: fromPlainText(''),
  language: '',
  licence: '',
  citation: '',
  original: false,
});

export function initialAuthoredState(initial: AuthoredRead): AuthoredState {
  return {
    drafts: initial.ok ? { [initial.property]: blank() } : {},
    command: null,
    failure: initial.ok ? undefined : initial.reason,
  };
}

/** The frozen request and its notice move together. Metadata and late editor emissions cannot dismiss rejection. */
export function authoredState(state: AuthoredState, action: Action): AuthoredState {
  switch (action.type) {
    case 'discard':
      if (
        !state.drafts[action.property] ||
        state.command ||
        state.proposed ||
        state.failure === 'stale' ||
        state.failure === 'denied'
      )
        return state;
      return { ...state, drafts: { ...state.drafts, [action.property]: blank() }, failure: undefined };
    case 'edit': {
      const draft = state.drafts[action.property];
      if (!draft || state.command || state.proposed || state.failure === 'denied') return state;
      return {
        ...state,
        drafts: { ...state.drafts, [action.property]: { ...draft, ...action.change } },
        failure: undefined,
      };
    }
    case 'submit':
      if (state.proposed || state.failure === 'stale' || state.failure === 'denied') return state;
      return { ...state, command: state.command ?? structuredClone(action.command), failure: undefined };
    case 'result':
      return action.result.ok
        ? { ...state, command: null, proposed: action.result, failure: undefined }
        : {
            ...state,
            command: action.result.reason === 'unavailable' || action.result.reason === 'stale' ? state.command : null,
            failure: action.result.reason,
          };
    case 'read': {
      // Only a successful, explicit review of the stale draft releases the frozen request.
      const recovered = action.reviewDraft && action.read.ok && state.failure === 'stale';
      return {
        ...state,
        drafts:
          action.read.ok && !state.drafts[action.read.property]
            ? { ...state.drafts, [action.read.property]: blank() }
            : state.drafts,
        command: recovered ? null : state.command,
        failure: state.command && !recovered ? state.failure : action.read.ok ? undefined : action.read.reason,
      };
    }
    case 'denied':
      return { ...state, command: null, proposed: undefined, failure: 'denied' };
  }
}
