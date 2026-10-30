import type { SearchScope } from './types';

export type SuggestionState = 'idle' | 'loading' | 'ready' | 'empty' | 'error' | 'unavailable';

export type HeaderSearchState = {
  expanded: boolean;
  phoneSheet: boolean;
  scope?: SearchScope;
  suggestions: SuggestionState;
};

export type HeaderSearchEvent =
  | { type: 'focus' }
  | { type: 'open-phone' }
  | { type: 'escape' }
  | { type: 'outside' }
  | { type: 'remove-scope' }
  | { type: 'sync-scope'; scope?: SearchScope }
  | { type: 'suggestions'; state: SuggestionState };

export function initialHeaderSearchState(scope?: SearchScope): HeaderSearchState {
  return { expanded: false, phoneSheet: false, scope, suggestions: 'idle' };
}

/** Shared by the React surface and the stack-free transition regression. */
export function reduceHeaderSearchState(state: HeaderSearchState, event: HeaderSearchEvent): HeaderSearchState {
  switch (event.type) {
    case 'focus':
      return { ...state, expanded: true };
    case 'open-phone':
      return { ...state, expanded: true, phoneSheet: true };
    case 'escape':
    case 'outside':
      return { ...state, expanded: false, phoneSheet: false };
    case 'remove-scope':
      return { ...state, scope: undefined, suggestions: 'idle' };
    case 'sync-scope':
      return { ...state, scope: event.scope };
    case 'suggestions':
      return { ...state, suggestions: event.state };
  }
}
