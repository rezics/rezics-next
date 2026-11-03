import { fromPlainText, hasDocumentContent, type DocumentSnapshot } from '@rezics/document';
import type { CandidateFailure } from '../../subject/candidates';
import type { ProposalResult, StatementInput } from './statement-editor';
import type { AuthoredCommand, AuthoredRead } from './authored-field';

export type AuthoredDraft = {
  document: DocumentSnapshot;
  language: string;
  licence: string;
  references: StatementInput['references'];
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
  // Preserve the existing URL citation affordance as the first ordinary reference part.
  references: [
    { parts: [{ property: { id: 'schema:url' }, value: { type: 'value', content: '' } }] },
  ],
  original: false,
});

function hasValue(value: unknown): boolean {
  if (typeof value === 'string') return value.trim().length > 0;
  if (typeof value === 'number' || typeof value === 'boolean') return true;
  if (Array.isArray(value)) return value.some(hasValue);
  if (value && typeof value === 'object')
    return Object.entries(value).some(
      ([key, nested]) => !['unit', 'precision', 'calendarmodel', 'language'].includes(key) && hasValue(nested),
    );
  return false;
}

export function authoredDraftHasContent(draft: AuthoredDraft): boolean {
  return (
    hasDocumentContent(draft.document) ||
    [draft.language, draft.licence].some((text) => text.trim()) ||
    draft.references.some((reference) =>
      reference.parts.some((part) => part.value.type !== 'value' || hasValue(part.value.content)),
    ) ||
    draft.original
  );
}

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
